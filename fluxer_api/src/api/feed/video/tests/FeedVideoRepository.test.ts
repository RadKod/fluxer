// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import type {FeedVideoRow} from '@app/api/database/types/FeedTypes';
import {FeedVideos} from '@app/api/feed/FeedTables';
import {FeedVideoRepository, pendingHour, pendingHourAt, pendingShard} from '@app/api/feed/video/FeedVideoRepository';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {createSnowflakeFromTimestamp} from '@fluxer/snowflake/src/Snowflake';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const AUTHOR = createUserID(4242n);
const HOUR_MS = 3_600_000;

function videoRow(guid: string, overrides: Partial<FeedVideoRow> = {}): FeedVideoRow {
	return {
		video_guid: guid,
		author_id: AUTHOR,
		created_id: createSnowflakeFromTimestamp(Date.now()),
		state: 'uploading',
		content: 'hello',
		flags: 0,
		content_type: 'video/mp4',
		declared_size: 1000n,
		post_id: null,
		uploaded_at: null,
		original_hash: null,
		width: null,
		height: null,
		duration: null,
		mp4_file: null,
		scan_started_at: null,
		updated_at: new Date(),
		...overrides,
	};
}

describe('FeedVideoRepository', () => {
	let kv: MockKVProvider;
	let repository: FeedVideoRepository;

	// A whole second may pass between the write and the read.
	async function expectTtl(key: string, seconds: number): Promise<void> {
		const ttl = await kv.ttl(key);
		expect(ttl).toBeGreaterThanOrEqual(seconds - 1);
		expect(ttl).toBeLessThanOrEqual(seconds);
	}

	beforeEach(() => {
		kv = new MockKVProvider();
		repository = new FeedVideoRepository(kv);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('writes the video, its author index and its pending row in one batch', async () => {
		const batch = vi.spyOn(InMemoryCassandraQueryExecutor.prototype, 'executeBatch');
		const row = videoRow('0a1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f');
		await repository.create(row);

		expect(batch).toHaveBeenCalledTimes(1);
		const [queries, atomic] = batch.mock.calls[0]!;
		expect(atomic).toBe(true);
		expect(queries.map((query) => query.meta?.table.name).sort()).toEqual([
			'feed_videos',
			'feed_videos_by_author',
			'feed_videos_pending',
		]);
		expect(await repository.get(row.video_guid)).toEqual(row);
		expect((await repository.listByAuthor(AUTHOR, 10)).map((video) => video.video_guid)).toEqual([row.video_guid]);
		expect(await repository.listPending(pendingHour(row.created_id), pendingShard(row.video_guid), null, 10)).toEqual([
			row.video_guid,
		]);

		await repository.finishPending(row);
		expect(await repository.listPending(pendingHour(row.created_id), pendingShard(row.video_guid), null, 10)).toEqual(
			[],
		);
		await repository.deleteAuthorIndex(row);
		expect(await repository.listByAuthor(AUTHOR, 10)).toEqual([]);
		expect(await repository.get(row.video_guid)).not.toBeNull();

		const second = videoRow('0b1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f');
		await repository.create(second);
		await repository.delete(second);
		expect(await repository.get(second.video_guid)).toBeNull();
		expect(await repository.listByAuthor(AUTHOR, 10)).toEqual([]);
		expect(
			await repository.listPending(pendingHour(second.created_id), pendingShard(second.video_guid), null, 10),
		).toEqual([]);
	});

	it("lists an author's videos newest first and updates a row with its time", async () => {
		const older = videoRow('1a1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f', {
			created_id: createSnowflakeFromTimestamp(Date.now() - 60_000),
		});
		const newer = videoRow('1b1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f');
		await repository.create(older);
		await repository.create(newer);
		expect((await repository.listByAuthor(AUTHOR, 10)).map((video) => video.video_guid)).toEqual([
			newer.video_guid,
			older.video_guid,
		]);
		expect((await repository.listByAuthor(AUTHOR, 1)).map((video) => video.video_guid)).toEqual([newer.video_guid]);

		const before = (await repository.get(older.video_guid))!.updated_at;
		await new Promise((resolve) => setTimeout(resolve, 5));
		await repository.update(older.video_guid, {state: 'deleting', content: null});
		const updated = (await repository.get(older.video_guid))!;
		expect(updated.state).toBe('deleting');
		expect(updated.content).toBeNull();
		expect(updated.updated_at.getTime()).toBeGreaterThan(before.getTime());
		expect(updated.content_type).toBe('video/mp4');
	});

	it('claims a webhook once per guid and status within 60 s and releases it', async () => {
		const guid = '2a1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
		expect(await repository.claimWebhook(guid, 3)).toBe(true);
		expect(await repository.claimWebhook(guid, 3)).toBe(false);
		expect(await repository.claimWebhook(guid, 4)).toBe(true);
		await expectTtl(`feed:video:hook:${guid}:3`, 60);
		await repository.releaseWebhook(guid, 3);
		expect(await repository.claimWebhook(guid, 3)).toBe(true);
	});

	it('lets one holder take the video lock and releases it only with its token', async () => {
		const guid = '3a1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
		const token = await repository.lockVideo(guid);
		expect(token).toEqual(expect.any(String));
		expect(await repository.lockVideo(guid)).toBeNull();
		await expectTtl(`feed:video:lock:${guid}`, 60);
		await repository.unlockVideo(guid, 'not-the-token');
		expect(await repository.lockVideo(guid)).toBeNull();
		await repository.unlockVideo(guid, token!);
		const next = await repository.lockVideo(guid);
		expect(next).toEqual(expect.any(String));
		expect(next).not.toBe(token);
	});

	it('claims one scan and one tagging wait, locks evidence and counts attempts', async () => {
		const guid = '4a1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
		expect(await repository.claimScan(guid)).toBe(true);
		expect(await repository.claimScan(guid)).toBe(false);
		await expectTtl(`feed:video:scan:${guid}`, 300);
		expect(await repository.claimTagWait(guid)).toBe(true);
		expect(await repository.claimTagWait(guid)).toBe(false);
		await expectTtl(`feed:video:tagwait:${guid}`, 31 * 60);

		const evidence = await repository.lockEvidence(guid);
		expect(evidence).toEqual(expect.any(String));
		expect(await repository.lockEvidence(guid)).toBeNull();
		await expectTtl(`feed:video:evidence:${guid}`, 600);
		await repository.unlockEvidence(guid, evidence!);
		expect(await repository.lockEvidence(guid)).toEqual(expect.any(String));

		expect(await repository.countEvidenceAttempt(guid)).toBe(1);
		expect(await repository.countEvidenceAttempt(guid)).toBe(2);
		expect(await repository.countDeleteAttempt(guid)).toBe(1);
		expect(await repository.countDeleteAttempt(guid)).toBe(2);
		await expectTtl(`feed:video:delete_attempts:${guid}`, 30 * 86_400);
		await expectTtl(`feed:video:evidence_attempts:${guid}`, 30 * 86_400);

		expect(await repository.getReported(guid)).toBeNull();
		await repository.markReported(guid, 'attachments/1/2/original.mp4');
		expect(await repository.getReported(guid)).toBe('attachments/1/2/original.mp4');
		await expectTtl(`feed:video:reported:${guid}`, 30 * 86_400);
	});

	it('keeps the reconcile cursor for 7 days and lets one cron run hold the reconcile lock', async () => {
		expect(await repository.getReconcileCursor()).toBeNull();
		await repository.setReconcileCursor(493_530);
		expect(await repository.getReconcileCursor()).toBe(493_530);
		await expectTtl('feed:video:reconcile:cursor', 7 * 86_400);

		const token = await repository.lockReconcile();
		expect(token).toEqual(expect.any(String));
		expect(await repository.lockReconcile()).toBeNull();
		await expectTtl('feed:video:reconcile', 600);
		await repository.unlockReconcile(token!);
		expect(await repository.lockReconcile()).toEqual(expect.any(String));
	});

	it('keeps stuck videos in one set until they are cleared', async () => {
		const first = '5a1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
		const second = '5b1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
		expect(await repository.countStuck()).toBe(0);
		await repository.markStuck(first);
		await repository.markStuck(first);
		await repository.markStuck(second);
		expect(await repository.countStuck()).toBe(2);
		expect(await kv.ttl('feed:video:stuck')).toBe(-1);
		await repository.clearStuck(first);
		expect(await repository.countStuck()).toBe(1);
		await repository.clearStuck(first);
		expect(await repository.countStuck()).toBe(1);
	});

	it('pages the pending partition after a guid', async () => {
		const createdId = createSnowflakeFromTimestamp(Date.UTC(2026, 8, 27, 18, 30));
		expect(pendingHour(createdId)).toBe(Math.floor(Date.UTC(2026, 8, 27, 18, 30) / HOUR_MS));
		expect(pendingHourAt(Date.UTC(2026, 8, 27, 18, 59, 59))).toBe(pendingHour(createdId));
		// 0x0040 % 64 = 0x0080 % 64 = 0x00c0 % 64 = 0: one shard; 0x0041 lands in shard 1.
		const guids = [
			'00c01d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f',
			'00401d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f',
			'00801d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f',
		];
		const other = '00411d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
		expect(guids.map(pendingShard)).toEqual([0, 0, 0]);
		expect(pendingShard(other)).toBe(1);
		expect(pendingShard('ffff1d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f')).toBe(63);
		for (const guid of [...guids, other]) await repository.create(videoRow(guid, {created_id: createdId}));

		const hour = pendingHour(createdId);
		const first = await repository.listPending(hour, 0, null, 2);
		expect(first).toEqual([guids[1], guids[2]]);
		expect(await repository.listPending(hour, 0, first.at(-1)!, 2)).toEqual([guids[0]]);
		expect(await repository.listPending(hour, 0, guids[0]!, 2)).toEqual([]);
		expect(await repository.listPending(hour, 1, null, 10)).toEqual([other]);
		expect(await repository.listPending(hour + 1, 0, null, 10)).toEqual([]);
	});

	it('keeps a published video row without a TTL', async () => {
		expect(FeedVideos.defaultTtlSeconds).toBeUndefined();
		const single = vi.spyOn(InMemoryCassandraQueryExecutor.prototype, 'executeQuery');
		const batch = vi.spyOn(InMemoryCassandraQueryExecutor.prototype, 'executeBatch');
		const row = videoRow('6a1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f');
		await repository.create(row);
		await repository.update(row.video_guid, {state: 'published', post_id: 99n, content: null});
		await repository.finishPending(row);
		await repository.deleteAuthorIndex(row);

		const cql = [
			...single.mock.calls.map(([query]) => query.cql),
			...batch.mock.calls.flatMap(([queries]) => queries.map((query) => query.query)),
		];
		const videoWrites = cql.filter((text) => /\bfeed_videos\b/.test(text) && !text.startsWith('SELECT'));
		expect(videoWrites.length).toBeGreaterThanOrEqual(2);
		for (const text of videoWrites) expect(text).not.toMatch(/TTL/i);
		expect(await repository.get(row.video_guid)).toMatchObject({state: 'published', post_id: 99n});
	});
});

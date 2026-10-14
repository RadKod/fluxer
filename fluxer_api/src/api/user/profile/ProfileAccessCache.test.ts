// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {feedDayStart} from '@app/api/feed/FeedRepository';
import {ProfileAccessCache, STRANGER_DAILY_CAP} from '@app/api/user/profile/ProfileAccessCache';
import type {ProfileSide} from '@app/api/user/services/ProfileAccessService';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {beforeEach, describe, expect, it} from 'vitest';

const side = (audience: ProfileSide['audience'], guildIds: Array<string> = ['7']): ProfileSide => ({
	exists: true,
	bot: false,
	audience,
	feedHidden: false,
	publicHidden: false,
	spammer: true,
	guildIds,
});

const MISS = {state: 'miss'} as const;

describe('the profile access KV store (Epha 3 Oct 10:52, 14:10)', () => {
	let kv: MockKVProvider;
	let now: number;
	let cache: ProfileAccessCache;
	const id = createUserID(10n);
	const viewer = createUserID(20n);

	beforeEach(() => {
		kv = new MockKVProvider();
		now = 1_000_000;
		cache = new ProfileAccessCache(kv, () => now);
	});

	it('round-trips a side, a missing account, a relation and a view', async () => {
		await cache.writeSide(id, side('everyone', ['1', '2']), MISS);
		await cache.writeSide(createUserID(11n), {...side('only_me', []), exists: false, spammer: false}, MISS);
		await cache.writeRelation(
			viewer,
			id,
			{audience: 'close', bond: 'weak', blocked: true, friend: false, sharedGuild: true},
			MISS,
		);
		await cache.writeView(id, '{"row":{}}', MISS);
		const fresh = new ProfileAccessCache(kv, () => now); // no local copies: from KV
		expect(await fresh.readSide(id)).toEqual({state: 'hit', value: side('everyone', ['1', '2'])});
		expect((await fresh.readSide(createUserID(11n))).state === 'hit').toBe(true);
		const missing = await fresh.readSide(createUserID(11n));
		expect(missing.state === 'hit' && missing.value.exists).toBe(false);
		expect(await fresh.readRelation(viewer, id)).toEqual({
			state: 'hit',
			value: {audience: 'close', bond: 'weak', blocked: true, friend: false, sharedGuild: true},
		});
		expect(await fresh.readView(id)).toEqual({state: 'hit', value: '{"row":{}}'});
		expect(await fresh.readSide(createUserID(12n))).toEqual({state: 'miss'});
	});

	it('a fill after a plain miss never lands over a forget marker (SETNX)', async () => {
		const read = await cache.readSide(id);
		expect(read.state).toBe('miss');
		await cache.forgetSide(id); // a marker for 5 s
		await cache.writeSide(id, side('everyone'), read);
		expect((await cache.readSide(id)).state).toBe('forgotten');
	});

	it('a read that saw the marker writes its fresh side over it and keeps a local copy (denetim 14)', async () => {
		await cache.forgetSide(id);
		const read = await cache.readSide(id);
		expect(read.state).toBe('forgotten');
		await cache.writeSide(id, side('guilds'), read);
		expect(await cache.readSide(id)).toEqual({state: 'hit', value: side('guilds')});
		kv.getSpy.mockClear();
		await cache.readSide(id);
		expect(kv.getSpy).not.toHaveBeenCalled(); // the 2 s local copy
	});

	it('drops expired local copies on read and keeps at most 5 000 per kind', async () => {
		await cache.writeView(id, 'view', MISS);
		now += 2_000;
		kv.getSpy.mockClear();
		expect(await cache.readView(id)).toEqual({state: 'hit', value: 'view'});
		expect(kv.getSpy).toHaveBeenCalledTimes(1); // the copy was too old: read again from KV

		for (let owner = 1n; owner <= 5_001n; owner++) await cache.writeSide(createUserID(owner), side('guilds'), MISS);
		kv.getSpy.mockClear();
		await cache.readSide(createUserID(5_001n));
		expect(kv.getSpy).not.toHaveBeenCalled();
		await cache.readSide(createUserID(1n)); // the oldest copy went when the 5 001st came
		expect(kv.getSpy).toHaveBeenCalledTimes(1);
	});

	it('forgets a relation in both directions and a view at once', async () => {
		const relation = {audience: 'guilds', bond: 'guild', blocked: false, friend: false, sharedGuild: true} as const;
		await cache.writeRelation(viewer, id, relation, MISS);
		await cache.writeRelation(id, viewer, relation, MISS);
		await cache.writeView(id, 'view', MISS);
		await cache.forgetRelations(id, viewer);
		await cache.forgetView(id);
		expect((await cache.readRelation(viewer, id)).state).toBe('forgotten');
		expect((await cache.readRelation(id, viewer)).state).toBe('forgotten');
		expect((await cache.readView(id)).state).toBe('forgotten'); // the local copy went too
	});

	it('a fill that saw one forget never lands over a newer one (two privacy writes in a row)', async () => {
		await cache.forgetSide(id);
		const read = await cache.readSide(id);
		expect(read.state).toBe('forgotten');
		await cache.forgetSide(id); // the second write's forget, after this read
		await cache.writeSide(id, side('guilds'), read);
		expect((await cache.readSide(id)).state).toBe('forgotten');
	});

	it('a recomputed pair record replaces the record it read, never a block marker set after that read (Ş1)', async () => {
		const stale = {audience: 'guilds', bond: 'guild', blocked: false, friend: false, sharedGuild: true} as const;
		const fresh = {...stale, audience: 'close', bond: 'close'} as const;
		await cache.writeRelation(viewer, id, stale, MISS);
		const read = await cache.readRelation(viewer, id);
		expect(read.state).toBe('hit');
		await cache.writeRelation(viewer, id, fresh, read);
		expect(await cache.readRelation(viewer, id)).toEqual({state: 'hit', value: fresh});

		const again = await cache.readRelation(viewer, id);
		await cache.forgetRelations(id, viewer); // a block between the read and the write
		await cache.writeRelation(viewer, id, stale, again);
		expect((await cache.readRelation(viewer, id)).state).toBe('forgotten');
	});

	it('counts distinct strangers a day: a target opened today stays free, a new one waits for room', async () => {
		const day = 20_000;
		const opened = Array.from({length: STRANGER_DAILY_CAP}, (_, index) => String(1_000 + index));
		await kv.sadd(`profile:stranger:${viewer}:${day}`, ...opened); // the set itself, no spy on the cap
		expect(await cache.allowStranger(viewer, createUserID(1_000n), day)).toBe(true);
		expect(await cache.allowStranger(viewer, createUserID(99n), day)).toBe(false);
		expect(await cache.allowStranger(viewer, createUserID(99n), day + 1)).toBe(true);
		expect(await kv.scard(`profile:stranger:${viewer}:${day + 1}`)).toBe(1);
		expect(await cache.allowStranger(viewer, createUserID(99n), day + 1)).toBe(true); // a refresh adds nothing
		expect(await kv.scard(`profile:stranger:${viewer}:${day + 1}`)).toBe(1);
	});

	it("keeps a day's stranger set until an hour after that day, however late a target is added (CR-O7)", async () => {
		const day = 20_000;
		const key = `profile:stranger:${viewer}:${day}`;
		const hour = 3_600_000;
		now = feedDayStart(day).getTime() + 2 * hour;
		await cache.allowStranger(viewer, createUserID(1n), day);
		now = feedDayStart(day + 1).getTime() - hour;
		await cache.allowStranger(viewer, createUserID(2n), day);
		// Both adds aim at the same moment, the end of the day plus an hour: 23 h and 2 h from when they ran.
		expect(kv.expireSpy.mock.calls.filter(([expired]) => expired === key).map(([, seconds]) => seconds)).toEqual([
			23 * 3_600,
			2 * 3_600,
		]);
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {type ChannelID, createChannelID, createUserID, type UserID} from '@app/api/BrandedTypes';
import {startDockerContainer} from '@app/api/test/DockerTestContainer';
import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import {registerVoiceSeatMockScripts} from '@app/api/voice_seat/tests/VoiceSeatMockScripts';
import {VOICE_SEAT_CHANNEL_CHANGES_PER_WINDOW, VOICE_SEAT_HASH_TTL_S} from '@app/api/voice_seat/VoiceSeatLimits';
import {VoiceSeatRepository, voiceSeatsKey} from '@app/api/voice_seat/VoiceSeatRepository';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';
import {KVClient} from '@pkgs/kv_client/src/KVClient';
import {afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi} from 'vitest';

const dockerAvailable = spawnSync('docker', ['version'], {stdio: 'ignore'}).status === 0;
const LOUNGE = ['seat_A_01', 'seat_A_02', 'seat_B_01'];
const WATCH = 'seat_T01_Y1';
const USER: UserID = createUserID(7n);
const OTHER_USER: UserID = createUserID(8n);
const THIRD_USER: UserID = createUserID(9n);
const A = `user_${USER}_conn-a`;
const B = `user_${USER}_conn-b`;
const C = `user_${OTHER_USER}_conn-c`;
const D = `user_${THIRD_USER}_conn-d`;

let nextChannel = 1000n;

function repositoryContract(name: string, kvFactory: () => IKVProvider) {
	describe(`VoiceSeatRepository (${name})`, () => {
		let kv: IKVProvider;
		let repo: VoiceSeatRepository;
		let channelId: ChannelID;

		beforeEach(() => {
			kv = kvFactory();
			repo = new VoiceSeatRepository(kv);
			channelId = createChannelID(nextChannel++);
		});

		const join = (identity: string, userId: UserID, seats: ReadonlyArray<string> = LOUNGE) =>
			repo.take({channelId, identity, userId, mode: 'join', joinValue: `${userId}|eu|eu-1`, seats});

		it('auto picks the first free lounge seat in manifest order', async () => {
			await repo.take({channelId, identity: C, userId: OTHER_USER, mode: 'explicit', seats: ['seat_A_01']});
			expect(await repo.take({channelId, identity: A, userId: USER, mode: 'auto', seats: LOUNGE})).toEqual({
				seat: 'seat_A_02',
				status: 'ok',
				freed: null,
			});
		});

		it('auto for an identity already seated returns same', async () => {
			await join(A, USER);
			expect(await repo.take({channelId, identity: A, userId: USER, mode: 'auto', seats: LOUNGE})).toEqual({
				seat: 'seat_A_01',
				status: 'same',
				freed: null,
			});
		});

		it('second connection of a seated user stays standing on auto and takes over on explicit move, clearing the old attribute once', async () => {
			await join(A, USER);
			expect((await join(B, USER)).status).toBe('user_elsewhere');
			expect(await repo.take({channelId, identity: B, userId: USER, mode: 'explicit', seats: ['seat_B_01']})).toEqual({
				seat: 'seat_B_01',
				status: 'ok',
				freed: A,
			});
			expect(await repo.seatOf(channelId, A)).toBeNull();
			expect(await repo.holderOf(channelId, 'seat_A_01')).toBeNull();
			expect(await repo.userIdentity(channelId, USER)).toBe(B);
			expect(
				(await repo.take({channelId, identity: B, userId: USER, mode: 'explicit', seats: ['seat_A_02']})).freed,
			).toBeNull();
		});

		it('explicit taken → taken', async () => {
			await join(C, OTHER_USER);
			expect(await repo.take({channelId, identity: A, userId: USER, mode: 'explicit', seats: ['seat_A_01']})).toEqual({
				seat: null,
				status: 'taken',
				freed: null,
			});
		});

		it('full → full', async () => {
			await join(C, OTHER_USER, ['seat_A_01']);
			expect(await join(A, USER, ['seat_A_01'])).toEqual({seat: null, status: 'full', freed: null});
		});

		it('join writes the membership mark and the latest identity', async () => {
			await join(A, USER);
			expect(await repo.joinMark(channelId, A)).toBe(`${USER}|eu|eu-1`);
			expect(await kv.hget(voiceSeatsKey(channelId), `l:${USER}`)).toBe(A);
		});

		it('release frees seat and user mapping', async () => {
			await join(A, USER);
			expect(await repo.release({channelId, identity: A, userId: USER})).toEqual({seat: 'seat_A_01', heir: null});
			expect(await repo.seatOf(channelId, A)).toBeNull();
			expect(await repo.holderOf(channelId, 'seat_A_01')).toBeNull();
			expect(await repo.userIdentity(channelId, USER)).toBeNull();
			expect(await repo.joinMark(channelId, A)).toBeNull();
		});

		it('release hands the seat to the latest joined identity of the same user (page reload)', async () => {
			await join(A, USER);
			await join(B, USER);
			expect(await repo.release({channelId, identity: A, userId: USER})).toEqual({seat: 'seat_A_01', heir: B});
			expect(await repo.seatOf(channelId, B)).toBe('seat_A_01');
			expect(await repo.userIdentity(channelId, USER)).toBe(B);
		});

		it('leave before join for the same identity leaves no j: and no seat', async () => {
			await join(C, OTHER_USER);
			expect(await repo.release({channelId, identity: A, userId: USER, goneTtlS: 120})).toEqual({
				seat: null,
				heir: null,
			});
			expect(await join(A, USER)).toEqual({seat: null, status: 'gone', freed: null});
			expect(await repo.joinMark(channelId, A)).toBeNull();
			expect(await repo.seatOf(channelId, A)).toBeNull();
			expect(await kv.hget(voiceSeatsKey(channelId), `l:${USER}`)).toBeNull();
		});

		it('a leave that found the j: mark leaves no tombstone, so the identity can join again', async () => {
			await join(A, USER);
			await repo.release({channelId, identity: A, userId: USER, goneTtlS: 120});
			expect((await join(A, USER)).status).toBe('ok');
			expect(await repo.joinMark(channelId, A)).toBe(`${USER}|eu|eu-1`);
		});

		it('a leave, with or without a tombstone TTL, writes nothing to a channel with no seat hash', async () => {
			await repo.release({channelId, identity: A, userId: USER});
			await repo.release({channelId, identity: A, userId: USER, goneTtlS: 120});
			expect(await kv.exists(voiceSeatsKey(channelId))).toBe(0);
			expect((await join(A, USER)).status).toBe('ok');
		});

		it('markPresent writes only missing j: marks, skips tombstoned identities and writes no l: or seat', async () => {
			await join(A, USER);
			await repo.release({channelId, identity: C, userId: OTHER_USER, goneTtlS: 120});
			const D = `user_${OTHER_USER}_conn-d`;
			await repo.markPresent(channelId, [
				{identity: A, value: `${USER}|us|us-1`},
				{identity: C, value: `${OTHER_USER}|eu|eu-1`},
				{identity: D, value: `${OTHER_USER}|eu|eu-1`},
			]);
			expect(await repo.joinMark(channelId, A)).toBe(`${USER}|eu|eu-1`);
			expect(await repo.joinMark(channelId, C)).toBeNull();
			expect(await repo.joinMark(channelId, D)).toBe(`${OTHER_USER}|eu|eu-1`);
			expect(await kv.hget(voiceSeatsKey(channelId), `l:${OTHER_USER}`)).toBeNull();
			expect(await repo.seatOf(channelId, D)).toBeNull();
			expect(await kv.ttl(voiceSeatsKey(channelId))).toBeGreaterThan(VOICE_SEAT_HASH_TTL_S - 5);
		});

		it('a held seat absent from the new theme is replaced on auto/join', async () => {
			for (const mode of ['auto', 'join'] as const) {
				const identity = `user_${USER}_${mode}`;
				await repo.take({channelId, identity, userId: USER, mode: 'explicit', seats: ['seat_X_01']});
				const result = await repo.take({channelId, identity, userId: USER, mode, joinValue: 'v', seats: ['seat_A_02']});
				expect(result).toEqual({seat: 'seat_A_02', status: 'ok', freed: null});
				expect(await repo.holderOf(channelId, 'seat_X_01')).toBeNull();
				await repo.release({channelId, identity, userId: USER});
			}
		});

		it('a held seat absent from the new theme is dropped when the new theme is full, freeing the identity itself', async () => {
			await join(C, OTHER_USER, ['seat_A_01']);
			await repo.take({channelId, identity: A, userId: USER, mode: 'explicit', seats: ['seat_X_01']});
			expect(await repo.take({channelId, identity: A, userId: USER, mode: 'auto', seats: ['seat_A_01']})).toEqual({
				seat: null,
				status: 'full',
				freed: A,
			});
			expect(await repo.seatOf(channelId, A)).toBeNull();
			expect(await repo.holderOf(channelId, 'seat_X_01')).toBeNull();
			expect(await repo.userIdentity(channelId, USER)).toBeNull();
		});

		it('a held table seat outside the lounge candidates is kept on auto', async () => {
			await repo.take({channelId, identity: A, userId: USER, mode: 'explicit', seats: ['seat_T01_2']});
			expect(await repo.take({channelId, identity: A, userId: USER, mode: 'auto', seats: LOUNGE})).toEqual({
				seat: 'seat_T01_2',
				status: 'same',
				freed: null,
			});
		});

		// Watch seats ride at the end of every auto/join candidate list: kept by their holder, never given.
		it('auto/join never assigns a watch seat', async () => {
			await join(C, OTHER_USER, ['seat_A_01']);
			for (const mode of ['auto', 'join'] as const) {
				expect(
					await repo.take({channelId, identity: A, userId: USER, mode, joinValue: 'v', seats: ['seat_A_01', WATCH]}),
				).toEqual({seat: null, status: 'full', freed: null});
			}
			expect(await join(B, USER, [WATCH, 'seat_A_02'])).toEqual({seat: 'seat_A_02', status: 'ok', freed: null});
			expect(await repo.holderOf(channelId, WATCH)).toBeNull();
		});

		it('explicit takes a free watch seat', async () => {
			await join(A, USER);
			expect(await repo.take({channelId, identity: A, userId: USER, mode: 'explicit', seats: [WATCH]})).toEqual({
				seat: WATCH,
				status: 'ok',
				freed: null,
			});
			expect(await repo.holderOf(channelId, 'seat_A_01')).toBeNull();
			expect(await repo.seatOf(channelId, A)).toBe(WATCH);
		});

		it('a held watch seat survives a duplicate join webhook', async () => {
			await join(A, USER, [...LOUNGE, WATCH]);
			await repo.take({channelId, identity: A, userId: USER, mode: 'explicit', seats: [WATCH]});
			// Region move: LiveKit confirms the same identity again from another server.
			const again = {channelId, identity: A, userId: USER, mode: 'join' as const, joinValue: `${USER}|us|us-1`};
			expect(await repo.take({...again, seats: [...LOUNGE, WATCH]})).toEqual({
				seat: WATCH,
				status: 'same',
				freed: null,
			});
			expect(await repo.seatOf(channelId, A)).toBe(WATCH);
			expect(await repo.joinMark(channelId, A)).toBe(`${USER}|us|us-1`);
		});

		it('theme change drops a watch seat that left the theme', async () => {
			await join(C, OTHER_USER, ['seat_A_01']);
			await repo.take({channelId, identity: A, userId: USER, mode: 'explicit', seats: ['seat_T01_Y2']});
			expect(
				await repo.take({channelId, identity: A, userId: USER, mode: 'auto', seats: ['seat_A_01', WATCH]}),
			).toEqual({
				seat: null,
				status: 'full',
				freed: A,
			});
			expect(await repo.seatOf(channelId, A)).toBeNull();
			expect(await repo.holderOf(channelId, 'seat_T01_Y2')).toBeNull();
			expect(await repo.holderOf(channelId, WATCH)).toBeNull();
			expect(await repo.userIdentity(channelId, USER)).toBeNull();
		});

		it('table seat hold rule unchanged', async () => {
			await repo.take({channelId, identity: A, userId: USER, mode: 'explicit', seats: ['seat_T01_2']});
			expect(await join(A, USER, [...LOUNGE, WATCH])).toEqual({seat: 'seat_T01_2', status: 'same', freed: null});
			await repo.take({channelId, identity: C, userId: OTHER_USER, mode: 'explicit', seats: [WATCH]});
			const toTable = {channelId, identity: C, userId: OTHER_USER, mode: 'explicit' as const, seats: ['seat_T01_3']};
			expect(await repo.take(toTable)).toEqual({seat: 'seat_T01_3', status: 'ok', freed: null});
			expect(await repo.holderOf(channelId, WATCH)).toBeNull();
		});

		// A REST take (limited) is refused once the channel spent its window's budget, and only a real
		// change spends it; the hooks' and the table service's takes never count.
		it('a limited take: same, taken, user_elsewhere and full spend nothing; the change past the budget is limited', async () => {
			const limited = (identity: string, userId: UserID, mode: 'auto' | 'explicit', seats: ReadonlyArray<string>) =>
				repo.take({channelId, identity, userId, mode, seats, limited: true});
			vi.useFakeTimers({toFake: ['Date']}); // the mock's clock; Valkey's TIME runs on (a few ms for the whole test)
			onTestFinished(() => {
				vi.useRealTimers();
			});
			await join(C, OTHER_USER, ['seat_A_01']);
			expect(await limited(A, USER, 'explicit', ['seat_A_02'])).toEqual({seat: 'seat_A_02', status: 'ok', freed: null});
			for (let i = 0; i < VOICE_SEAT_CHANNEL_CHANGES_PER_WINDOW; i++) {
				expect(await limited(A, USER, 'explicit', ['seat_A_02'])).toMatchObject({status: 'same'});
				expect(await limited(A, USER, 'explicit', ['seat_A_01'])).toMatchObject({status: 'taken'});
				expect(await limited(B, USER, 'auto', LOUNGE)).toMatchObject({status: 'user_elsewhere'});
				expect(await limited(D, THIRD_USER, 'auto', ['seat_A_01', 'seat_A_02'])).toMatchObject({status: 'full'});
			}
			for (let i = 1; i < VOICE_SEAT_CHANNEL_CHANGES_PER_WINDOW; i++) {
				const seat = i % 2 === 1 ? 'seat_B_01' : 'seat_A_02';
				expect(await limited(A, USER, 'explicit', [seat])).toEqual({seat, status: 'ok', freed: null});
			}
			expect(await limited(A, USER, 'explicit', ['seat_A_02'])).toEqual({seat: null, status: 'limited', freed: null});
			expect(await repo.seatOf(channelId, A)).toBe('seat_B_01');
			expect(await repo.take({channelId, identity: A, userId: USER, mode: 'explicit', seats: ['seat_A_02']})).toEqual({
				seat: 'seat_A_02',
				status: 'ok',
				freed: null,
			});
			await kv.hdel(voiceSeatsKey(channelId), 'r:count', 'r:ends'); // what the window's end does
			expect(await limited(A, USER, 'explicit', ['seat_B_01'])).toMatchObject({status: 'ok'});
		});

		it('holdersOf returns each seat holder in order, null for a free seat', async () => {
			await join(A, USER);
			await join(C, OTHER_USER);
			expect(await repo.holdersOf(channelId, ['seat_B_01', 'seat_A_01', 'seat_A_02'])).toEqual([null, A, C]);
			expect(await repo.holdersOf(channelId, [])).toEqual([]);
		});

		it('vacate frees the seat without an heir and keeps the membership mark', async () => {
			await join(A, USER);
			await join(B, USER);
			expect(await repo.vacate({channelId, identity: A, userId: USER})).toBe('seat_A_01');
			expect(await repo.seatOf(channelId, B)).toBeNull();
			expect(await repo.userIdentity(channelId, USER)).toBeNull();
			expect(await repo.joinMark(channelId, A)).toBe(`${USER}|eu|eu-1`);
			expect(await repo.vacate({channelId, identity: A, userId: USER})).toBeNull();
		});

		it('TTL refreshed on every write', async () => {
			const key = voiceSeatsKey(channelId);
			await join(A, USER);
			expect(await kv.ttl(key)).toBeGreaterThan(VOICE_SEAT_HASH_TTL_S - 5);
			await kv.expire(key, 60);
			await repo.take({channelId, identity: B, userId: USER, mode: 'auto', seats: LOUNGE});
			expect(await kv.ttl(key)).toBeGreaterThan(VOICE_SEAT_HASH_TTL_S - 5);
			await kv.expire(key, 60);
			await repo.take({channelId, identity: A, userId: USER, mode: 'explicit', seats: ['seat_A_02']});
			expect(await kv.ttl(key)).toBeGreaterThan(VOICE_SEAT_HASH_TTL_S - 5);
			expect(VOICE_SEAT_HASH_TTL_S).toBe(604_800);
		});

		it('reconcile lock is taken once per window and the channel delete drops hash and lock', async () => {
			await join(A, USER);
			expect(await repo.tryReconcileLock(channelId)).toBe(true);
			expect(await repo.tryReconcileLock(channelId)).toBe(false);
			await repo.deleteChannel(channelId);
			expect(await kv.exists(voiceSeatsKey(channelId))).toBe(0);
			expect(await repo.tryReconcileLock(channelId)).toBe(true);
		});
	});
}

registerVoiceSeatMockScripts();
repositoryContract('mock', () => new MockKVProvider());

describe.skipIf(!dockerAvailable)('valkey', () => {
	const container = `fluxer-voiceseat-${process.pid.toString(36)}-${Date.now().toString(36)}`;
	let client: KVClient | null = null;

	beforeAll(async () => {
		const port = await freePort();
		startDockerContainer([
			'run',
			'-d',
			'--name',
			container,
			'-p',
			`127.0.0.1:${port}:6379`,
			'valkey/valkey:9.1-alpine',
		]);
		for (let attempt = 0; attempt < 120; attempt++) {
			const probe = spawnSync('docker', ['exec', container, 'valkey-cli', 'ping'], {encoding: 'utf8'});
			if (probe.stdout?.trim() === 'PONG') break;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		client = new KVClient(`redis://127.0.0.1:${port}`);
	}, 300_000);

	afterAll(() => {
		client?.close();
		spawnSync('docker', ['rm', '-f', container], {stdio: 'ignore'});
	});

	repositoryContract('valkey', () => {
		if (!client) throw new Error('valkey client is not ready');
		return client;
	});
});

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

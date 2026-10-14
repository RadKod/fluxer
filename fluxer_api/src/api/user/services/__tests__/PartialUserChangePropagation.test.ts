// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createUserID} from '@app/api/BrandedTypes';
import type {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {UserCacheService} from '@app/api/infrastructure/UserCacheService';
import type {RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import type {GuildMember} from '@app/api/models/GuildMember';
import type {User} from '@app/api/models/User';
import {
	dispatchPendingPartialUserChange,
	type PendingPartialUserChangeDeps,
} from '@app/api/user/services/PartialUserChangePropagation';
import {findLaneForTask, WORKER_LANES} from '@app/api/worker/WorkerLaneConfig';
import type {UserPartialResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {describe, expect, test, vi} from 'vitest';

const USER_ID = createUserID(1n);
const GUILD_IDS = [createGuildID(10n), createGuildID(11n)];
const USER = {id: USER_ID} as unknown as User;
const DIRTY_KEY = `propagate:dirty:{${USER_ID}}`;
const QUEUED_KEY = `propagate:queued:{${USER_ID}}`;
const LOCK_KEY = `propagate:lock:{${USER_ID}}`;

const USER_PARTIAL: UserPartialResponse = {
	id: USER_ID.toString(),
	username: 'ada',
	discriminator: '0001',
	global_name: null,
	avatar: 'newhash',
	avatar_color: null,
	flags: 0,
};

function createMember(): GuildMember {
	return {
		userId: USER_ID,
		nickname: null,
		avatarHash: null,
		bannerHash: null,
		accentColor: null,
		roleIds: new Set(),
		joinedAt: new Date(0),
		isMute: false,
		isDeaf: false,
		communicationDisabledUntil: null,
		profileFlags: 0,
		mentionFlags: 0,
		isPremiumSanitized: false,
	} as unknown as GuildMember;
}

async function createDeps(guildIds: Array<(typeof GUILD_IDS)[number]> = GUILD_IDS) {
	const kvClient = new MockKVProvider();
	await kvClient.setex(DIRTY_KEY, 60, 'pending');
	const dispatchGuild = vi.fn().mockResolvedValue(undefined);
	const getUserGuildIds = vi.fn().mockResolvedValue(guildIds);
	const getMember = vi.fn().mockResolvedValue(createMember());
	const deps: PendingPartialUserChangeDeps = {
		kvClient,
		userCacheService: {
			setUserPartialResponseFromUserInRequestCache: (_user: User, requestCache: RequestCache) => {
				requestCache.userPartials.set(USER_ID, USER_PARTIAL);
				return USER_PARTIAL;
			},
			getUserPartialResponse: async () => USER_PARTIAL,
		} as unknown as UserCacheService,
		gatewayService: {dispatchGuild} as unknown as IGatewayService,
		userRepository: {findUnique: async () => USER, getUserGuildIds},
		guildRepository: {getMember} as unknown as GuildRepository,
	};
	return {deps, kvClient, dispatchGuild, getUserGuildIds, getMember};
}

describe('dispatchPendingPartialUserChange', () => {
	test.each([
		[39_999, false],
		[40_000, true],
	])(
		'pauses admission at eighty percent of the member trigger from cached state alone: members=%s',
		async (memberCount, pause) => {
			const {deps, kvClient, dispatchGuild} = await createDeps();
			await kvClient.setex(`username:propagate:capacity:{${USER_ID}}`, 60, 'generation');
			const setUsernamePolicyConfig = vi.fn().mockResolvedValue(undefined);
			Object.assign(deps, {
				instanceConfigRepository: {
					getUsernameMigrationConfig: async () => ({state: 'selecting', epoch: 2}),
					setUsernamePolicyConfig,
				},
			});
			Object.assign(deps.guildRepository, {findUnique: vi.fn().mockResolvedValue({memberCount})});
			await dispatchPendingPartialUserChange(deps, USER_ID);
			expect(setUsernamePolicyConfig.mock.calls).toEqual(
				pause ? [[{admission: {global_per_second: 0, paused: true}}]] : [],
			);
			expect(dispatchGuild).toHaveBeenCalledTimes(2);
		},
	);
	test('adds no guild point reads to ordinary cosmetic propagation', async () => {
		const {deps} = await createDeps();
		const findUnique = vi.fn();
		Object.assign(deps.guildRepository, {findUnique});
		Object.assign(deps, {instanceConfigRepository: {getUsernameMigrationConfig: vi.fn()}});
		await dispatchPendingPartialUserChange(deps, USER_ID);
		expect(findUnique).not.toHaveBeenCalled();
	});
	test('pushes the current partial to every guild and clears the pending flag', async () => {
		const {deps, kvClient, dispatchGuild} = await createDeps();

		await dispatchPendingPartialUserChange(deps, USER_ID);

		expect(dispatchGuild).toHaveBeenCalledTimes(2);
		for (const [index, guildId] of GUILD_IDS.entries()) {
			const call = dispatchGuild.mock.calls[index]![0];
			expect(call.guildId).toBe(guildId);
			expect(call.event).toBe('GUILD_MEMBER_UPDATE');
			expect((call.data as {user: UserPartialResponse}).user).toEqual(USER_PARTIAL);
		}
		expect(await kvClient.get(DIRTY_KEY)).toBeNull();
	});

	test('dispatches nothing when the user is in no guilds', async () => {
		const {deps, dispatchGuild, getMember} = await createDeps([]);

		await dispatchPendingPartialUserChange(deps, USER_ID);

		expect(getMember).not.toHaveBeenCalled();
		expect(dispatchGuild).not.toHaveBeenCalled();
	});

	test('skips guilds the user is no longer a member of', async () => {
		const {deps, dispatchGuild, getMember} = await createDeps();
		getMember.mockResolvedValueOnce(null);

		await dispatchPendingPartialUserChange(deps, USER_ID);

		expect(dispatchGuild).toHaveBeenCalledTimes(1);
		expect(dispatchGuild.mock.calls[0]![0].guildId).toBe(GUILD_IDS[1]);
	});

	test('does nothing when no change is pending', async () => {
		const {deps, kvClient, dispatchGuild, getUserGuildIds} = await createDeps();
		await kvClient.del(DIRTY_KEY);

		await dispatchPendingPartialUserChange(deps, USER_ID);

		expect(getUserGuildIds).not.toHaveBeenCalled();
		expect(dispatchGuild).not.toHaveBeenCalled();
	});

	test('returns quietly while another task holds the lock, leaving the change for that task to pick up', async () => {
		const {deps, kvClient, dispatchGuild, getUserGuildIds} = await createDeps();
		await kvClient.setex(QUEUED_KEY, 60, '1');
		expect(await kvClient.acquireLock(LOCK_KEY, 'other-task', 30)).toBe(true);

		await expect(dispatchPendingPartialUserChange(deps, USER_ID)).resolves.toBeUndefined();

		expect(getUserGuildIds).not.toHaveBeenCalled();
		expect(dispatchGuild).not.toHaveBeenCalled();
		expect(await kvClient.get(DIRTY_KEY)).toBe('pending');
		expect(await kvClient.get(QUEUED_KEY)).toBeNull();
	});

	test('holds its lock longer than a background read can take', async () => {
		const {deps, kvClient} = await createDeps();

		await dispatchPendingPartialUserChange(deps, USER_ID);

		const lockTtls = kvClient.acquireLockSpy.mock.calls.filter(([key]) => key === LOCK_KEY).map(([, , ttl]) => ttl);
		expect(lockTtls).toHaveLength(1);
		expect(lockTtls[0]).toBeGreaterThanOrEqual(30);
	});
});

describe('propagatePartialUserChange lane', () => {
	test('runs on the lifecycle lane, away from mention delivery and with room to retry a gateway outage', () => {
		expect(findLaneForTask('propagatePartialUserChange')).toBe('lifecycle');
		const lane = WORKER_LANES.find((candidate) => candidate.name === 'lifecycle')!;
		expect(lane.maxDeliver).toBeGreaterThanOrEqual(25);
		expect(lane.ackWaitMs).toBeGreaterThanOrEqual(60_000);
	});
});

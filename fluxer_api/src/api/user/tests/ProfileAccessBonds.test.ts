// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {
	acceptInvite,
	blockUser,
	createChannelInvite,
	createFriendship,
	createGroupDmChannel,
	createGuild,
	getChannel,
	updateUserSettings,
} from '@app/api/channel/tests/ChannelTestUtils';
import {followDirectly} from '@app/api/feed/tests/FeedTestUtils';
import type {RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {getConnectionRepository, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import type {User} from '@app/api/models/User';
import type {UserSettings} from '@app/api/models/UserSettings';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {ProfileAccessService} from '@app/api/user/services/ProfileAccessService';
import {sendFriendRequest} from '@app/api/user/tests/RelationshipTestUtils';
import {ConnectionTypes, ConnectionVisibilityFlags} from '@fluxer/constants/src/ConnectionConstants';
import type {UserProfileFullResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

// the bond × level part of the one profile access rule. The viewers here are new accounts (no
// stranger standing), so the "public" cells of Tablo 1 are A1's matrix.
describe('the profile access rule by bond and level (Kapı 2 Tablo 1)', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	// The settings route for the levels it takes; the legacy 1 straight into the settings row (an older client's write).
	async function writeLevel(owner: TestAccount, level: number): Promise<void> {
		if (level !== 1) return updateUserSettings(harness, owner.token, {profile_privacy: level});
		await getUserRepository().patchSettings(createUserID(BigInt(owner.userId)), {profile_privacy: level});
	}

	async function sharedGuild(owner: TestAccount, viewer: TestAccount): Promise<void> {
		const guild = await createGuild(harness, owner.token, 'Shared');
		const channel = await getChannel(harness, owner.token, guild.system_channel_id!);
		const invite = await createChannelInvite(harness, owner.token, channel.id);
		await acceptInvite(harness, viewer.token, invite.code);
	}

	// A third account friends with both opens the group DM, so the two share it without being friends themselves.
	async function sharedGroupDm(owner: TestAccount, viewer: TestAccount): Promise<void> {
		const host = await createTestAccount(harness);
		await createFriendship(harness, host, owner);
		await createFriendship(harness, host, viewer);
		await createGroupDmChannel(harness, host.token, [owner.userId, viewer.userId]);
	}

	function getProfile(viewer: TestAccount, owner: TestAccount) {
		return createBuilder<UserProfileFullResponse>(harness, viewer.token).get(
			`/users/${owner.userId}/profile?with_mutual_friends=true&with_mutual_guilds=true`,
		);
	}

	type Outcome = 200 | 'limited' | 403;
	interface Row {
		bond: string;
		setup: (owner: TestAccount, viewer: TestAccount) => Promise<void>;
		expect: Record<number, Outcome>;
	}
	// level → expected: 200 = full profile, 'limited' = 200 + profile_limited, 403.
	const ROWS: Array<Row> = [
		{
			bond: 'friend',
			setup: (o, v) => createFriendship(harness, o, v),
			expect: {0: 200, 1: 200, 2: 200, 100: 200, 101: 'limited'},
		},
		{
			bond: 'mutual follow',
			setup: async (o, v) => {
				await followDirectly(v.userId, o.userId);
				await followDirectly(o.userId, v.userId);
			},
			expect: {0: 200, 1: 200, 2: 200, 100: 200, 101: 'limited'},
		},
		{
			bond: 'shared guild',
			setup: (o, v) => sharedGuild(o, v),
			expect: {0: 200, 1: 200, 2: 'limited', 100: 200, 101: 'limited'},
		},
		{
			bond: 'pending request',
			setup: async (o, v) => void (await sendFriendRequest(harness, v.token, o.userId)),
			expect: {0: 'limited', 1: 'limited', 2: 'limited', 100: 'limited', 101: 'limited'},
		},
		{
			bond: 'shared group DM',
			setup: (o, v) => sharedGroupDm(o, v),
			expect: {0: 'limited', 2: 'limited', 100: 'limited'},
		},
		{
			bond: 'one-way follow only',
			setup: (o, v) => followDirectly(v.userId, o.userId),
			expect: {0: 403, 2: 403, 100: 403, 101: 403},
		},
		{bond: 'nothing', setup: async () => {}, expect: {0: 403, 1: 403, 2: 403, 100: 403, 101: 403}},
	];

	describe.each(ROWS)('a viewer with $bond', ({setup, expect: byLevel}) => {
		it.each(Object.entries(byLevel))('level %s → %s', async (level, outcome) => {
			const owner = await createTestAccount(harness);
			const viewer = await createTestAccount(harness);
			await setup(owner, viewer);
			await writeLevel(owner, Number(level));
			const request = getProfile(viewer, owner);
			if (outcome === 403) return void (await request.expect(HTTP_STATUS.FORBIDDEN).execute());
			const profile = await request.execute();
			expect(profile.profile_limited === true).toBe(outcome === 'limited');
			// the mutual lists only on the full view.
			expect(profile.mutual_friends === undefined || outcome === 200).toBe(true);
			expect(profile.mutual_guilds === undefined || outcome === 200).toBe(true);
		});
	});

	it('a block either way limits a bonded viewer and refuses a stranger (Ş1)', async () => {
		for (const blockerIsOwner of [true, false]) {
			const owner = await createTestAccount(harness);
			const member = await createTestAccount(harness);
			const stranger = await createTestAccount(harness);
			await sharedGuild(owner, member);
			await writeLevel(owner, 100);
			if (blockerIsOwner) {
				await blockUser(harness, owner, member.userId);
				await blockUser(harness, owner, stranger.userId);
			} else {
				await blockUser(harness, member, owner.userId);
				await blockUser(harness, stranger, owner.userId);
			}
			const limited = await getProfile(member, owner).execute();
			expect(limited.profile_limited).toBe(true);
			expect(limited.mutual_guilds).toBeUndefined();
			await getProfile(stranger, owner).expect(HTTP_STATUS.FORBIDDEN).execute();
		}
	});

	it('a connection shown to friends only reaches a friend and not a guild member (field context from the access)', async () => {
		const owner = await createTestAccount(harness);
		const friend = await createTestAccount(harness);
		const member = await createTestAccount(harness);
		await createFriendship(harness, owner, friend);
		await sharedGuild(owner, member);
		await getConnectionRepository().create({
			user_id: createUserID(BigInt(owner.userId)),
			connection_id: `friends-only-${owner.userId}`,
			connection_type: ConnectionTypes.DOMAIN,
			identifier: `friends-only-${owner.userId}.example`,
			name: 'friends only',
			visibility_flags: ConnectionVisibilityFlags.FRIENDS,
			verification_token: 'token',
			verified: true,
		});
		const seenByFriend = await getProfile(friend, owner).execute();
		expect(seenByFriend.connected_accounts?.map((connection) => connection.name)).toEqual(['friends only']);
		const seenByMember = await getProfile(member, owner).execute();
		expect(seenByMember.profile_limited).toBeUndefined();
		expect(seenByMember.connected_accounts ?? []).toEqual([]);
	});

	it('one request reads the viewer guild IDs and private channels once, however many owners it judges (requestCache)', async () => {
		const viewerId = createUserID(1n);
		const getUserGuildIds = vi.fn(async (_userId: UserID) => []);
		const listPrivateChannels = vi.fn(async (_userId: UserID) => []);
		const service = new ProfileAccessService({
			users: {
				findUnique: async (id: UserID) => ({id, isBot: false, dateOfBirth: '2000-01-01', flags: 0n}) as unknown as User,
				getUserGuildIds,
			},
			settings: {findSettings: async () => ({profilePrivacy: 0}) as unknown as UserSettings},
			relationships: {getRelationship: async () => null, getIncomingRelationship: async () => null},
			channels: {listPrivateChannels},
			follows: {getFollow: async () => null, isFollowingCached: async () => false},
		});
		const requestCache = {} as RequestCache;
		for (let owner = 2n; owner < 32n; owner++) {
			expect((await service.resolve(viewerId, createUserID(owner), undefined, requestCache)).view).toBeNull();
		}
		expect(getUserGuildIds.mock.calls.filter(([id]) => id === viewerId)).toHaveLength(1);
		expect(listPrivateChannels).toHaveBeenCalledTimes(1);
	});
});

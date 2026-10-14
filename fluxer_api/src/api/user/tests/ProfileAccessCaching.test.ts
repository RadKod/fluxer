// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createGuildID, createUserID, type UserID} from '@app/api/BrandedTypes';
import {
	acceptInvite,
	blockUser,
	createChannelInvite,
	createFriendship,
	createGuild,
	getChannel,
	leaveGuild,
	updateUserSettings,
} from '@app/api/channel/tests/ChannelTestUtils';
import {followDirectly} from '@app/api/feed/tests/FeedTestUtils';
import {getProfileAccessCache, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import type {User} from '@app/api/models/User';
import type {UserSettings} from '@app/api/models/UserSettings';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {onUserBanned} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {ProfileAccessCache} from '@app/api/user/profile/ProfileAccessCache';
import {ProfileAccessService} from '@app/api/user/services/ProfileAccessService';
import {getProfile, sharedGuild} from '@app/api/user/tests/ProfileTestUtils';
import {sendFriendRequest} from '@app/api/user/tests/RelationshipTestUtils';
import {ProfilePrivacyLevels, UserFlags} from '@fluxer/constants/src/UserConstants';
import {types} from 'cassandra-driver';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const HOUR = 3_600_000;

// the profile access decision through the 60 s KV records — the owner side once per owner,
// whoever views, and a viewer–owner record that knows the level it was computed under.
describe('profile access through the cache (Epha 3 Oct 10:52)', () => {
	const owner = createUserID(100n);
	const sharedGuildId = createGuildID(7n);

	function fakeService(kv: MockKVProvider, level: number, follows?: {viewerFollows: boolean; ownerFollows: boolean}) {
		const deps = {
			users: {
				findUnique: vi.fn(
					async (id: UserID) => ({id, isBot: false, dateOfBirth: '2000-01-01', flags: 0n}) as unknown as User,
				),
				getUserGuildIds: vi.fn(async (_id: UserID) => [sharedGuildId]),
			},
			settings: {findSettings: vi.fn(async (_id: UserID) => ({profilePrivacy: level}) as unknown as UserSettings)},
			relationships: {
				getRelationship: vi.fn(async () => null),
				getIncomingRelationship: vi.fn(async () => null),
			},
			channels: {listPrivateChannels: vi.fn(async () => [])},
			follows: {
				getFollow: vi.fn(async (_userId: UserID, _targetId: UserID) => (follows?.viewerFollows ? {} : null)),
				isFollowingCached: vi.fn(async (_userId: UserID, _targetId: UserID) => follows?.ownerFollows ?? false),
			},
		};
		const cache = new ProfileAccessCache(kv);
		return {deps, cache, service: new ProfileAccessService({...deps, cache})};
	}
	const ownerReads = (deps: ReturnType<typeof fakeService>['deps']) => [
		deps.users.findUnique.mock.calls.filter(([id]) => id === owner).length,
		deps.settings.findSettings.mock.calls.filter(([id]) => id === owner).length,
		deps.users.getUserGuildIds.mock.calls.filter(([id]) => id === owner).length,
	];

	it('reads the owner side once: a second viewer costs no users, settings or user_guilds read', async () => {
		const kv = new MockKVProvider();
		const first = fakeService(kv, ProfilePrivacyLevels.ALL_GUILDS);
		expect((await first.service.resolve(createUserID(1n), owner)).view).toBe('full');
		expect((await first.service.resolve(createUserID(2n), owner)).view).toBe('full');
		expect(ownerReads(first.deps)).toEqual([1, 1, 1]);

		// Another API process (no local copy): the owner side and the pair record come from KV.
		const second = fakeService(kv, ProfilePrivacyLevels.ALL_GUILDS);
		expect((await second.service.resolve(createUserID(1n), owner)).view).toBe('full');
		expect(ownerReads(second.deps)).toEqual([0, 0, 0]);
		expect(second.deps.relationships.getRelationship).not.toHaveBeenCalled();
	});

	it("never reads the owner's user_following partition for a mutual follow (getFollow(owner, viewer) not called)", async () => {
		const viewer = createUserID(3n);
		const {deps, service} = fakeService(new MockKVProvider(), ProfilePrivacyLevels.FRIENDS_ONLY, {
			viewerFollows: true,
			ownerFollows: true,
		});
		expect((await service.resolve(viewer, owner)).view).toBe('full');
		expect(deps.follows.getFollow.mock.calls).toEqual([[viewer, owner]]);
		expect(deps.follows.isFollowingCached.mock.calls).toEqual([[owner, viewer]]);
	});

	it('a pair record recomputed while a block lands keeps the block marker (Ş1, no stale overwrite)', async () => {
		const viewer = createUserID(4n);
		const {deps, cache, service} = fakeService(new MockKVProvider(), ProfilePrivacyLevels.ALL_GUILDS);
		await service.resolve(viewer, owner); // the pair record under 'guilds'
		deps.settings.findSettings.mockResolvedValue({profilePrivacy: ProfilePrivacyLevels.FRIENDS_ONLY} as never);
		await cache.forgetSide(owner);
		// The block's forget lands while the recompute reads the relationships it predates.
		deps.relationships.getRelationship.mockImplementationOnce(async () => {
			await cache.forgetRelations(viewer, owner);
			return null;
		});
		await service.resolve(viewer, owner);
		expect((await cache.readRelation(viewer, owner)).state).toBe('forgotten');
	});

	describe('through the routes', () => {
		let harness: ApiTestHarness;
		beforeAll(async () => {
			harness = await createApiTestHarness();
		});
		afterEach(() => vi.useRealTimers());
		afterAll(async () => {
			await harness?.shutdown();
		});

		it('narrowing applies on the next request: 100 → 101 and the standing stranger gets 403 (G3)', async () => {
			const [owner, stranger] = [await createTestAccount(harness), await createTestAccount(harness)];
			await updateUserSettings(harness, owner.token, {profile_privacy: ProfilePrivacyLevels.EVERYONE});
			vi.useFakeTimers({now: Date.now() + 25 * HOUR, toFake: ['Date']}); // the stranger's standing (≥24 h)
			const opened = await getProfile(harness, stranger.token, owner).execute();
			expect(opened.profile_limited).toBeUndefined();
			await updateUserSettings(harness, owner.token, {profile_privacy: ProfilePrivacyLevels.ONLY_ME});
			await getProfile(harness, stranger.token, owner).expect(HTTP_STATUS.FORBIDDEN).execute();
		});

		it('a pair record computed under another level is recomputed, never reused (0 → 2: shared guild and mutual follow)', async () => {
			const [owner, viewer] = [await createTestAccount(harness), await createTestAccount(harness)];
			await sharedGuild(harness, owner, viewer);
			await followDirectly(viewer.userId, owner.userId);
			await followDirectly(owner.userId, viewer.userId);
			await updateUserSettings(harness, owner.token, {profile_privacy: ProfilePrivacyLevels.ALL_GUILDS});
			// Under 0 the shared guild alone decides (bond 'guild'); under 2 only the mutual follow opens the profile.
			expect((await getProfile(harness, viewer.token, owner).execute()).profile_limited).toBeUndefined();
			await updateUserSettings(harness, owner.token, {profile_privacy: ProfilePrivacyLevels.FRIENDS_ONLY});
			expect((await getProfile(harness, viewer.token, owner).execute()).profile_limited).toBeUndefined();
		});

		it('a block drops both pair records: each side gets the limited profile on the next request (G4)', async () => {
			// A shared guild outlives the block (a friendship does not: the block replaces it, and no bond means 403).
			const [owner, member] = [await createTestAccount(harness), await createTestAccount(harness)];
			await sharedGuild(harness, owner, member);
			expect((await getProfile(harness, member.token, owner).execute()).profile_limited).toBeUndefined();
			expect((await getProfile(harness, owner.token, member).execute()).profile_limited).toBeUndefined();
			await blockUser(harness, member, owner.userId);
			expect((await getProfile(harness, member.token, owner).execute()).profile_limited).toBe(true);
			expect((await getProfile(harness, owner.token, member).execute()).profile_limited).toBe(true);
		});

		// A bond made or broken reaches the cached decision on the next request, both ways.
		const outcome = async (token: string, owner: TestAccount) => {
			const {response, json} = await getProfile(harness, token, owner).executeRaw();
			if (response.status !== 200) return response.status;
			return (json as {profile_limited?: boolean}).profile_limited ? 'limited' : 'full';
		};
		const relationship = (from: TestAccount, to: TestAccount) =>
			createBuilder(harness, from.token).put(`/users/@me/relationships/${to.userId}`).body({});

		it('G-5: a friend request, its acceptance and an unfriend reach the profile on the next request', async () => {
			const [owner, viewer] = [await createTestAccount(harness), await createTestAccount(harness)];
			await updateUserSettings(harness, owner.token, {profile_privacy: ProfilePrivacyLevels.ALL_GUILDS});
			expect(await outcome(viewer.token, owner)).toBe(403);
			await sendFriendRequest(harness, viewer.token, owner.userId);
			expect(await outcome(viewer.token, owner)).toBe('limited');
			await relationship(owner, viewer).expect(HTTP_STATUS.NO_CONTENT, undefined).executeRaw();
			expect(await outcome(viewer.token, owner)).toBe('full');
			expect(await outcome(owner.token, viewer)).toBe('full');
			await createBuilder(harness, viewer.token)
				.delete(`/users/@me/relationships/${owner.userId}`)
				.expect(HTTP_STATUS.NO_CONTENT)
				.execute();
			expect(await outcome(viewer.token, owner)).toBe(403);
		});

		it('G-5: joining and leaving a shared guild reach the profile at once and forget only the member side', async () => {
			const [owner, viewer] = [await createTestAccount(harness), await createTestAccount(harness)];
			await updateUserSettings(harness, owner.token, {profile_privacy: ProfilePrivacyLevels.ALL_GUILDS});
			const guild = await createGuild(harness, owner.token, 'Shared');
			const channel = await getChannel(harness, owner.token, guild.system_channel_id!);
			const invite = await createChannelInvite(harness, owner.token, channel.id);
			expect(await outcome(viewer.token, owner)).toBe(403);
			expect(await outcome(owner.token, viewer)).toBe(403);

			const kv = harness.kvProvider as MockKVProvider; // the harness always injects the mock
			kv.setexSpy.mockClear();
			await acceptInvite(harness, viewer.token, invite.code);
			const forgotten = kv.setexSpy.mock.calls.map(([key]) => String(key)).filter((key) => key.startsWith('profile:'));
			expect(forgotten).toEqual([`profile:side:${viewer.userId}`]); // no pair record, however big the guild
			expect(await outcome(viewer.token, owner)).toBe('full');
			expect(await outcome(owner.token, viewer)).toBe('full');

			await leaveGuild(harness, viewer.token, guild.id);
			expect(await outcome(viewer.token, owner)).toBe(403);
			expect(await outcome(owner.token, viewer)).toBe(403);
		});

		it('G-5: a follow back under 2 opens the profile on the next request, an unfollow closes it', async () => {
			const [owner, viewer] = [await createTestAccount(harness), await createTestAccount(harness)];
			await updateUserSettings(harness, owner.token, {profile_privacy: ProfilePrivacyLevels.FRIENDS_ONLY});
			await followDirectly(viewer.userId, owner.userId);
			expect(await outcome(viewer.token, owner)).toBe(403);
			await followDirectly(owner.userId, viewer.userId);
			expect(await outcome(viewer.token, owner)).toBe('full');
			await createBuilder(harness, owner.token)
				.delete(`/users/${viewer.userId}/follow`)
				.expect(HTTP_STATUS.NO_CONTENT)
				.execute();
			expect(await outcome(viewer.token, owner)).toBe(403);
		});

		it('the deletion start and a subscription status write reach the cached profile view (they skip patchAccount)', async () => {
			const [owner, friend] = [await createTestAccount(harness), await createTestAccount(harness)];
			await createFriendship(harness, owner, friend);
			const repository = getUserRepository();
			const id = createUserID(BigInt(owner.userId));
			const viewState = async () => {
				await getProfile(harness, friend.token, owner).execute();
				return async () => (await getProfileAccessCache().readView(id)).state;
			};

			const afterSubscription = await viewState();
			expect(await afterSubscription()).toBe('hit');
			await repository.updateSubscriptionStatus(id, {
				premiumWillCancel: true,
				computedPremiumUntil: new Date(Date.now() + 24 * HOUR),
			});
			expect(await afterSubscription()).toBe('forgotten');

			const due = new Date(Date.now() - 1_000);
			const user = (await repository.findUnique(id))!;
			await repository.updateDeletionSchedule(user, {pending_deletion_at: due});
			const afterStart = await viewState();
			expect(await afterStart()).toBe('hit');
			expect((await repository.startDeletion(id, due))?.deletionStartedAt).toBeTruthy();
			expect(await afterStart()).toBe('forgotten');
		});

		// The owner side is in KV once someone has opened the profile.
		async function cachedSideOf(token: string, owner: TestAccount) {
			await getProfile(harness, token, owner).execute();
			const id = createUserID(BigInt(owner.userId));
			expect((await getProfileAccessCache().readSide(id)).state).toBe('hit');
			return id;
		}

		it('a permanent ban drops the owner side record', async () => {
			const [owner, friend] = [await createTestAccount(harness), await createTestAccount(harness)];
			await createFriendship(harness, owner, friend);
			const id = await cachedSideOf(friend.token, owner);
			await onUserBanned({userId: id});
			expect((await getProfileAccessCache().readSide(id)).state).toBe('forgotten');
		});

		it('a date of birth or flags write drops the owner side record; a last activity or bio write does not', async () => {
			const [owner, friend] = [await createTestAccount(harness), await createTestAccount(harness)];
			await createFriendship(harness, owner, friend);
			const repository = getUserRepository();
			const write = async (patch: Parameters<typeof repository.patchUpsert>[1]) => {
				const user = await repository.findUnique(createUserID(BigInt(owner.userId)));
				await repository.patchUpsert(user!.id, patch, user!.toRow());
			};
			const id = await cachedSideOf(friend.token, owner);
			await write({last_active_at: new Date(), bio: 'yeni'});
			expect((await getProfileAccessCache().readSide(id)).state).toBe('hit');
			await write({date_of_birth: types.LocalDate.fromString('2012-01-01')});
			expect((await getProfileAccessCache().readSide(id)).state).toBe('forgotten');
			await cachedSideOf(friend.token, owner);
			const user = await repository.findUnique(id);
			await write({flags: user!.flags | UserFlags.SPAMMER});
			expect((await getProfileAccessCache().readSide(id)).state).toBe('forgotten');
		});
	});
});

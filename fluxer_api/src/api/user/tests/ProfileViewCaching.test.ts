// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {
	acceptInvite,
	createChannelInvite,
	createFriendship,
	createGuild,
	getChannel,
	updateUserSettings,
} from '@app/api/channel/tests/ChannelTestUtils';
import {getPngDataUrl} from '@app/api/emoji/tests/EmojiTestUtils';
import {
	getBadgeRepository,
	getBadgeService,
	getConnectionRepository,
	getPioneerRepository,
	getPioneerService,
	getProfileAccessCache,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {User} from '@app/api/models/User';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {onUserAccountWritten} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {buildProfileView, encodeProfileView} from '@app/api/user/profile/ProfileViewProjection';
import {updateUserProfile} from '@app/api/user/tests/UserTestUtils';
import {ConnectionTypes, ConnectionVisibilityFlags} from '@fluxer/constants/src/ConnectionConstants';
import {ProfilePrivacyLevels, UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {UserProfileFullResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const DAY = 86_400_000;
const PNG_BASE64 = getPngDataUrl().split(',')[1]!; // BadgeService takes the bare base64

// drawing a profile reads the owner's users row, connections and badges only
// on a miss of the 60 s KV view; the owner side of the access decision is ProfileAccessService's, so
// its reads are not counted here.
describe('the profile view of the owner from the KV cache (G-1)', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	const idOf = (account: TestAccount): UserID => createUserID(BigInt(account.userId));

	function getProfile(viewer: TestAccount, owner: TestAccount, query = '') {
		return createBuilder<UserProfileFullResponse>(harness, viewer.token)
			.get(`/users/${owner.userId}/profile${query}`)
			.execute();
	}

	// The owner reads a request makes outside ProfileAccessService (its owner side is A1's, cached there).
	function ownerReads<T extends object>(target: T, method: keyof T & string, ownerId: UserID): Array<string> {
		const stacks: Array<string> = [];
		const original = (target[method] as (...args: Array<unknown>) => unknown).bind(target);
		vi.spyOn(target, method as never).mockImplementation(((id: unknown, ...rest: Array<unknown>) => {
			if (id === ownerId) {
				const stack = new Error().stack ?? '';
				if (!stack.includes('ProfileAccessService')) stacks.push(stack);
			}
			return original(id, ...rest);
		}) as never);
		return stacks;
	}

	async function friends(): Promise<{owner: TestAccount; viewer: TestAccount}> {
		const owner = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		await createFriendship(harness, owner, viewer);
		return {owner, viewer};
	}

	async function sharedGuild(owner: TestAccount, viewer: TestAccount): Promise<string> {
		const guild = await createGuild(harness, owner.token, 'Shared');
		const channel = await getChannel(harness, owner.token, guild.system_channel_id!);
		const invite = await createChannelInvite(harness, owner.token, channel.id);
		await acceptInvite(harness, viewer.token, invite.code);
		return guild.id;
	}

	it('a second viewer of a profile costs no users, connections or badges read of the owner', async () => {
		const {owner, viewer} = await friends();
		const second = await createTestAccount(harness);
		await createFriendship(harness, owner, second);
		const ownerId = idOf(owner);
		await getProfile(viewer, owner);
		const users = ownerReads(getUserRepository(), 'findUnique', ownerId);
		const connections = vi.spyOn(getConnectionRepository(), 'findByUserId');
		const badges = vi.spyOn(getBadgeRepository(), 'listUserBadges');
		const profile = await getProfile(second, owner);
		expect(profile.user.id).toBe(owner.userId);
		expect(users).toEqual([]);
		expect(connections).not.toHaveBeenCalledWith(ownerId);
		expect(badges).not.toHaveBeenCalledWith(ownerId);
	});

	it('a bio change shows on the next profile request (account write hook)', async () => {
		const {owner, viewer} = await friends();
		await updateUserProfile(harness, owner.token, {bio: 'before'});
		expect((await getProfile(viewer, owner)).user_profile?.bio).toBe('before');
		await updateUserProfile(harness, owner.token, {bio: 'after'});
		expect((await getProfile(viewer, owner)).user_profile?.bio).toBe('after');
	});

	it('an activity-only write keeps the cached view; any other column change forgets it', async () => {
		const {owner, viewer} = await friends();
		const ownerId = idOf(owner);
		await getProfile(viewer, owner);
		const row = (await getUserRepository().findUnique(ownerId))!.toRow();
		const cache = getProfileAccessCache();
		await onUserAccountWritten({
			previous: row,
			updated: {
				...row,
				terms_agreed_at: row.terms_agreed_at ? new Date(row.terms_agreed_at.getTime()) : null, // same value, new Date
				last_active_at: new Date(),
				last_active_ip: '198.51.100.1',
			},
		});
		expect((await cache.readView(ownerId)).state).toBe('hit');
		await onUserAccountWritten({previous: row, updated: {...row, pronouns: 'she/her'}});
		expect((await cache.readView(ownerId)).state).toBe('forgotten');
	});

	describe('a lapsed premium is repaired or stripped from the real row, never from the projection', () => {
		async function premiumOwner(until: Date): Promise<{owner: TestAccount; viewer: TestAccount; real: User}> {
			const {owner, viewer} = await friends();
			const repository = getUserRepository();
			const current = (await repository.findUnique(idOf(owner)))!;
			const real = await repository.patchUpsert(
				current.id,
				{
					premium_type: UserPremiumTypes.SUBSCRIPTION,
					premium_since: new Date(Date.now() - 60 * DAY),
					premium_until: until,
					premium_grace_ends_at: until,
				},
				current.toRow(),
			);
			return {owner, viewer, real};
		}

		// The view the projection would hold after the premium time ran out, while it is still in KV.
		async function cacheLapsedView(real: User): Promise<void> {
			const lapsed = new User({
				...real.toRow(),
				premium_until: new Date(Date.now() - DAY),
				premium_grace_ends_at: new Date(Date.now() - DAY),
			});
			const cache = getProfileAccessCache();
			await cache.writeView(
				real.id,
				encodeProfileView(buildProfileView(lapsed, [], [])),
				await cache.readView(real.id),
			);
		}

		it('strips with the real row: one users read, patchUpsert gets the real row, the view is forgotten', async () => {
			const {owner, viewer, real} = await premiumOwner(new Date(Date.now() - DAY));
			await cacheLapsedView(real);
			const users = ownerReads(getUserRepository(), 'findUnique', real.id);
			const realReads = ownerReads(getUserRepository(), 'findUniqueAssert', real.id);
			const patchUpsert = vi.spyOn(getUserRepository(), 'patchUpsert');
			const profile = await getProfile(viewer, owner);
			expect(users).toEqual([]);
			expect(realReads).toHaveLength(1);
			expect(patchUpsert).toHaveBeenCalledTimes(1);
			const base = patchUpsert.mock.calls[0]![2]!;
			expect(base.email).toBe(owner.email); // the real row, not the secret-free projection
			expect(base.version).toBe(real.version);
			expect(profile.premium_type).toBeUndefined();
			expect((await getProfileAccessCache().readView(real.id)).state).toBe('forgotten');
		});

		it('a stale lapsed projection over a paid row: no write, the real row answers, the view is forgotten', async () => {
			const {owner, viewer, real} = await premiumOwner(new Date(Date.now() + 30 * DAY));
			await cacheLapsedView(real);
			const patchUpsert = vi.spyOn(getUserRepository(), 'patchUpsert');
			const profile = await getProfile(viewer, owner);
			expect(patchUpsert).not.toHaveBeenCalled();
			expect(profile.premium_type).toBe(UserPremiumTypes.SUBSCRIPTION);
			expect((await getProfileAccessCache().readView(real.id)).state).toBe('forgotten');
		});
	});

	it('the guild-scoped popup (guild_id) still answers as today', async () => {
		const {owner, viewer} = await friends();
		const guildId = await sharedGuild(owner, viewer);
		const profile = await getProfile(viewer, owner, `?guild_id=${guildId}`);
		expect(profile.guild_member?.user.id).toBe(owner.userId);
		expect(profile.guild_member_profile).toBeDefined();
	});

	it('mutual friends and communities come only when asked for and only on the full view; communities read no owner user_guilds', async () => {
		const {owner, viewer} = await friends();
		const mutual = await createTestAccount(harness);
		await createFriendship(harness, owner, mutual);
		await createFriendship(harness, viewer, mutual);
		const guildId = await sharedGuild(owner, viewer);
		const ownerId = idOf(owner);
		const relationships = vi.spyOn(getUserRepository(), 'listRelationships');
		const guilds = ownerReads(getUserRepository(), 'getUserGuildIds', ownerId);

		const plain = await getProfile(viewer, owner);
		expect(plain.mutual_friends).toBeUndefined();
		expect(plain.mutual_guilds).toBeUndefined();
		expect(relationships).not.toHaveBeenCalledWith(ownerId);

		const asked = await getProfile(viewer, owner, '?with_mutual_friends=true&with_mutual_guilds=true');
		expect(asked.mutual_friends?.map((user) => user.id)).toEqual([mutual.userId]);
		expect(asked.mutual_guilds?.map((guild) => guild.id)).toEqual([guildId]);
		expect(guilds).toEqual([]);

		relationships.mockClear();
		await updateUserSettings(harness, owner.token, {profile_privacy: ProfilePrivacyLevels.ONLY_ME});
		const limited = await getProfile(viewer, owner, '?with_mutual_friends=true&with_mutual_guilds=true');
		expect(limited.profile_limited).toBe(true);
		expect(limited.mutual_friends).toBeUndefined();
		expect(limited.mutual_guilds).toBeUndefined();
		expect(relationships).not.toHaveBeenCalledWith(ownerId);
	});

	it('a hidden connection is gone from the next profile request', async () => {
		const {owner, viewer} = await friends();
		const connectionId = `site-${owner.userId}`;
		await getConnectionRepository().create({
			user_id: idOf(owner),
			connection_id: connectionId,
			connection_type: ConnectionTypes.DOMAIN,
			identifier: `${connectionId}.example`,
			name: 'site',
			visibility_flags: ConnectionVisibilityFlags.EVERYONE,
			verification_token: 'token',
			verified: true,
		});
		expect((await getProfile(viewer, owner)).connected_accounts?.map((connection) => connection.name)).toEqual([
			'site',
		]);
		await createBuilder(harness, owner.token)
			.patch(`/users/@me/connections/${ConnectionTypes.DOMAIN}/${connectionId}`)
			.body({visibility_flags: 0})
			.expect(204)
			.execute();
		expect((await getProfile(viewer, owner)).connected_accounts ?? []).toEqual([]);
	});

	it('a granted badge shows on the next profile request and a revoked one is gone', async () => {
		const {owner, viewer} = await friends();
		const badge = await getBadgeService().createBadge({icon: PNG_BASE64, description: 'Early supporter'});
		expect((await getProfile(viewer, owner)).badges ?? []).toEqual([]);
		await getBadgeService().grantBadge(idOf(owner), BigInt(badge.id));
		expect((await getProfile(viewer, owner)).badges?.map((shown) => shown.id)).toEqual([badge.id]);
		await getBadgeService().revokeBadge(idOf(owner), BigInt(badge.id));
		expect((await getProfile(viewer, owner)).badges ?? []).toEqual([]);
	});

	it('the Öncü badge (PioneerService, straight through the badge repository) shows and goes on the next request', async () => {
		const {owner, viewer} = await friends();
		const badge = await getBadgeService().createBadge({icon: PNG_BASE64, description: 'Öncü #{n}'});
		const pioneers = getPioneerRepository();
		await pioneers.ensureState();
		await pioneers.setStatus('off', 'open', BigInt(badge.id));
		expect((await getProfile(viewer, owner)).badges ?? []).toEqual([]);
		const slot = await getPioneerService().assign(idOf(owner));
		expect((await getProfile(viewer, owner)).badges?.map((shown) => shown.description)).toEqual([`Öncü #${slot}`]);
		await getPioneerService().revoke(idOf(owner));
		expect((await getProfile(viewer, owner)).badges ?? []).toEqual([]);
	});
});

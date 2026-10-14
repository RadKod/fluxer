// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createGuildID, createUserID, type GuildID, type UserID} from '@app/api/BrandedTypes';
import {createTestGuild} from '@app/api/emoji/tests/EmojiTestUtils';
import {UserCacheService} from '@app/api/infrastructure/UserCacheService';
import {createUsersServiceClient} from '@app/api/infrastructure/UsersServiceClient';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {
	getGatewayService,
	getKVClient,
	getWorkerService,
	setInjectedWorkerService,
} from '@app/api/middleware/ServiceRegistry';
import {
	getDiscriminatorService,
	getGuildRepository,
	getPremiumLedgerService,
	getPremiumStateReconciliationQueueService,
	getUserCacheService,
	getUserRepository,
	getVisionaryService,
} from '@app/api/middleware/ServiceSingletons';
import type {User} from '@app/api/models/User';
import {type PremiumGrantSource, PremiumLedgerService} from '@app/api/premium/ledger/PremiumLedgerService';
import {RpcSessionStartService} from '@app/api/rpc/RpcSessionStartService';
import {createTestStoreEntitlementService} from '@app/api/store_billing/tests/StoreBillingTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {SyncTaskWorkerService} from '@app/api/test/SyncTaskWorkerService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {checkIsPremium, createPremiumClearPatch} from '@app/api/user/UserHelpers';
import {mapUserToPartialResponse} from '@app/api/user/UserMappers';
import {processUser} from '@app/api/worker/tasks/ProcessExpiredPremiumSweep';
import processPremiumExpirations from '@app/api/worker/tasks/ProcessPremiumExpirations';
import propagatePartialUserChange from '@app/api/worker/tasks/PropagatePartialUserChange';
import {
	clearWorkerDependencies,
	getWorkerDependencies,
	setWorkerDependenciesForTest,
} from '@app/api/worker/WorkerContext';
import {PremiumFlags, PublicUserFlags, UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {GuildMemberResponse} from '@fluxer/schema/src/domains/guild/GuildMemberSchemas';
import type {UserProfileFullResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {ms} from 'itty-time';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type MockInstance, vi} from 'vitest';

// Micup: the premium badge is a derived bit in the public flags, so every write that starts or ends premium has to
// send the guild member lists a GUILD_MEMBER_UPDATE, and a write that leaves the bit alone must send none.

const NOW = new Date('2026-10-15T12:00:00.000Z');
const GUILD_AVATAR = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const HELPERS: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

interface GuildDispatch {
	guildId: {toString(): string};
	event: string;
	data: GuildMemberResponse;
}

describe('premium badge propagation to guild member lists', () => {
	let harness: ApiTestHarness;
	let dispatchGuild: MockInstance;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		setInjectedWorkerService(new SyncTaskWorkerService({propagatePartialUserChange}));
		setWorkerDependenciesForTest({
			kvClient: getKVClient(),
			storeEntitlementService: createTestStoreEntitlementService(),
			workerService: getWorkerService(),
			userRepository: getUserRepository(),
			guildRepository: getGuildRepository(),
			userCacheService: getUserCacheService(),
			gatewayService: getGatewayService(),
			premiumStateReconciliationQueueService: getPremiumStateReconciliationQueueService(),
		});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		clearWorkerDependencies();
		setInjectedWorkerService(new NoopWorkerService());
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	async function createGuildMember(): Promise<{userId: UserID; token: string; guildId: string}> {
		const account = await createTestAccount(harness);
		const guild = await createTestGuild(harness, account.token);
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(NOW);
		return {userId: createUserID(BigInt(account.userId)), token: account.token, guildId: guild.id};
	}

	async function readUser(userId: UserID): Promise<User> {
		return (await getUserRepository().findUnique(userId))!;
	}

	async function grantDays(userId: UserID, source: PremiumGrantSource, days: number, grantKey = 'order-1:premium') {
		await getPremiumLedgerService().grant({userId, grantKey, duration: {unit: 'days', quantity: days}, source});
	}

	async function grantOneDayAndLapse(userId: UserID): Promise<void> {
		await grantDays(userId, 'payriff', 1);
		vi.setSystemTime(NOW.getTime() + ms('1 day') + 1000);
	}

	function watchGuildDispatches(): void {
		dispatchGuild = vi.spyOn(NoopGatewayService.prototype, 'dispatchGuild');
	}

	async function startSession(user: User, guildIds: Array<GuildID> = []): Promise<User> {
		const sessionStart = new RpcSessionStartService({
			userRepository: getUserRepository(),
			guildRepository: getGuildRepository(),
			userCacheService: getUserCacheService(),
			gatewayService: getGatewayService(),
			discriminatorService: getDiscriminatorService(),
			premiumLedgerService: getPremiumLedgerService(),
		});
		const result = await sessionStart.processSessionStart({
			userData: {
				user,
				settings: null,
				guildSettings: [],
				notes: new Map(),
				readStates: [],
				guildIds,
				privateChannels: [],
				relationships: [],
				favoriteMemes: [],
				pinnedDMs: [],
				webAuthnCredentials: [],
			},
			requestCache: createRequestCache(),
			geoipCountryIso: null,
			clientIp: null,
		});
		return result.user;
	}

	// Queueing the propagation job throws, the way a full worker queue does; counts how often it was tried.
	let failedEnqueues = 0;
	function failPropagationQueue(): void {
		failedEnqueues = 0;
		setInjectedWorkerService(
			new SyncTaskWorkerService({
				propagatePartialUserChange: async () => {
					failedEnqueues += 1;
					throw new Error('worker queue is full');
				},
			}),
		);
	}

	function memberUpdates(guildId: string): Array<GuildMemberResponse> {
		return dispatchGuild.mock.calls
			.map(([params]) => params as GuildDispatch)
			.filter((params) => params.event === 'GUILD_MEMBER_UPDATE' && params.guildId.toString() === guildId)
			.map((params) => params.data);
	}

	// One entry per GUILD_MEMBER_UPDATE sent to the guild: whether its user carries the premium badge.
	function memberUpdateBadges(guildId: string): Array<boolean> {
		return memberUpdates(guildId).map((member) => (member.user.flags & PublicUserFlags.PREMIUM_BADGE) !== 0);
	}

	// A premium guild perk that the expired premium sanitization removes.
	async function giveGuildAvatar(userId: UserID, guildId: string): Promise<void> {
		const member = (await getGuildRepository().getMember(createGuildID(BigInt(guildId)), userId))!;
		await getGuildRepository().upsertMember({...member.toRow(), avatar_hash: GUILD_AVATAR});
	}

	function failPresenceDispatch(): void {
		vi.spyOn(NoopGatewayService.prototype, 'dispatchPresence').mockRejectedValue(new Error('gateway is down'));
	}

	function emptySweepResult() {
		return {
			processed: 0,
			stripped: 0,
			sanitized: 0,
			reconcileEnqueued: 0,
			storeRefreshEnqueued: 0,
			skipped: 0,
			failed: 0,
		};
	}

	it('a ledger grant (trial or paid) sends GUILD_MEMBER_UPDATE with the badge', async () => {
		for (const source of ['trial', 'payriff'] as const) {
			const {userId, guildId} = await createGuildMember();
			watchGuildDispatches();

			await grantDays(userId, source, 7);

			expect(checkIsPremium(await readUser(userId))).toBe(true);
			expect(memberUpdateBadges(guildId)).toEqual([true]);
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	});

	it('the hourly expiration job sends GUILD_MEMBER_UPDATE without the badge', async () => {
		const {userId, guildId} = await createGuildMember();
		await grantOneDayAndLapse(userId);
		watchGuildDispatches();

		await processPremiumExpirations({}, HELPERS);

		expect((await readUser(userId)).premiumType).toBeNull();
		expect(memberUpdateBadges(guildId)).toEqual([false]);
	});

	it('a session start that strips lapsed premium sends GUILD_MEMBER_UPDATE without the badge', async () => {
		const {userId, guildId} = await createGuildMember();
		await grantOneDayAndLapse(userId);
		watchGuildDispatches();

		await startSession(await readUser(userId));

		expect((await readUser(userId)).premiumType).toBeNull();
		expect(memberUpdateBadges(guildId)).toEqual([false]);
	});

	it('a profile read that strips lapsed premium sends GUILD_MEMBER_UPDATE without the badge', async () => {
		const {userId, token, guildId} = await createGuildMember();
		await grantOneDayAndLapse(userId);
		watchGuildDispatches();

		const profile = await createBuilder<UserProfileFullResponse>(harness, token)
			.get(`/users/${userId}/profile`)
			.execute();

		expect(profile.premium_type).toBeUndefined();
		expect((await readUser(userId)).premiumType).toBeNull();
		expect(memberUpdateBadges(guildId)).toEqual([false]);
	});

	it('a renewal that keeps premium sends no GUILD_MEMBER_UPDATE', async () => {
		const {userId, guildId} = await createGuildMember();
		await grantDays(userId, 'payriff', 30);
		watchGuildDispatches();

		await grantDays(userId, 'payriff', 30, 'order-2:premium');

		const user = await readUser(userId);
		expect(checkIsPremium(user)).toBe(true);
		expect(user.premiumGiftExtensionEndsAt).toEqual(new Date(NOW.getTime() + ms('60 days')));
		expect(memberUpdateBadges(guildId)).toEqual([]);
	});

	it('a premium account with the badge hidden sends nothing when premium starts or ends', async () => {
		const {userId, guildId} = await createGuildMember();
		await getUserRepository().patchUpsert(userId, {premium_flags: PremiumFlags.BADGE_HIDDEN});
		watchGuildDispatches();

		await grantDays(userId, 'payriff', 1);
		expect(checkIsPremium(await readUser(userId))).toBe(true);
		vi.setSystemTime(NOW.getTime() + ms('1 day') + 1000);
		await processPremiumExpirations({}, HELPERS);

		expect((await readUser(userId)).premiumType).toBeNull();
		expect(memberUpdateBadges(guildId)).toEqual([]);
	});

	// A failed announcement never undoes or hides the premium write it follows: every path logs it and moves on.
	it('a ledger repair still returns the repaired premium user when queueing the badge propagation fails', async () => {
		const {userId} = await createGuildMember();
		await grantDays(userId, 'payriff', 7);
		await getUserRepository().patchUpsert(userId, createPremiumClearPatch());
		failPropagationQueue();

		const {user} = await getPremiumLedgerService().ensureUserPremium(userId);

		expect(failedEnqueues).toBe(1);
		expect(checkIsPremium(user!)).toBe(true);
		expect(checkIsPremium(await readUser(userId))).toBe(true);
	});

	it('the expiration sweep still counts the user as stripped when queueing the badge propagation fails', async () => {
		const {userId} = await createGuildMember();
		await grantOneDayAndLapse(userId);
		failPropagationQueue();
		const result = {
			processed: 0,
			stripped: 0,
			sanitized: 0,
			reconcileEnqueued: 0,
			storeRefreshEnqueued: 0,
			skipped: 0,
			failed: 0,
		};

		await processUser(await readUser(userId), getWorkerDependencies(), result);

		expect(failedEnqueues).toBe(1);
		expect(result).toMatchObject({stripped: 1, failed: 0});
		expect((await readUser(userId)).premiumType).toBeNull();
	});

	it('a session start still returns the stripped user when queueing the badge propagation fails', async () => {
		const {userId} = await createGuildMember();
		await grantOneDayAndLapse(userId);
		failPropagationQueue();

		const user = await startSession(await readUser(userId));

		expect(failedEnqueues).toBe(1);
		expect(user.premiumType).toBeNull();
		expect((await readUser(userId)).premiumType).toBeNull();
	});

	it('a profile read still returns the stripped profile when queueing the badge propagation fails', async () => {
		const {userId, token} = await createGuildMember();
		await grantOneDayAndLapse(userId);
		failPropagationQueue();

		const profile = await createBuilder<UserProfileFullResponse>(harness, token)
			.get(`/users/${userId}/profile`)
			.execute();

		expect(failedEnqueues).toBe(1);
		expect(profile.premium_type).toBeUndefined();
		expect((await readUser(userId)).premiumType).toBeNull();
	});

	// The announcement is independent of the USER_UPDATE dispatch: nothing retries it once that dispatch has failed.
	it('a ledger grant still sends the badge when the USER_UPDATE dispatch fails', async () => {
		const {userId, guildId} = await createGuildMember();
		watchGuildDispatches();
		failPresenceDispatch();

		await grantDays(userId, 'payriff', 7);

		expect(checkIsPremium(await readUser(userId))).toBe(true);
		expect(memberUpdateBadges(guildId)).toEqual([true]);
	});

	it('the expiration sweep still sends the badge change when the USER_UPDATE dispatch fails', async () => {
		const {userId, guildId} = await createGuildMember();
		await grantOneDayAndLapse(userId);
		watchGuildDispatches();
		failPresenceDispatch();
		const result = emptySweepResult();

		await processUser(await readUser(userId), getWorkerDependencies(), result);

		expect(result).toMatchObject({failed: 1});
		expect((await readUser(userId)).premiumType).toBeNull();
		expect(memberUpdateBadges(guildId)).toEqual([false]);
	});

	// The announcement reads the member row, so it must come after the sanitization that removes the guild perks;
	// read before it, a late announcement would bring the removed guild avatar back.
	it('the hourly expiration job announces the badge change only after it has removed the guild perks', async () => {
		const {userId, guildId} = await createGuildMember();
		await giveGuildAvatar(userId, guildId);
		await grantOneDayAndLapse(userId);
		watchGuildDispatches();

		await processPremiumExpirations({}, HELPERS);

		expect(memberUpdates(guildId).map((member) => member.avatar)).toEqual([null, null]);
		expect(memberUpdateBadges(guildId)).toEqual([false, false]);
	});

	// Task F-Z: the users service keeps the crowned partial user until the announcement refreshes it, so the sanitization
	// reads the stripped one from the request cache, the way a session start does.
	it('the expiration sweep removes the guild perks without the badge while the users service still has it', async () => {
		const {userId, guildId} = await createGuildMember();
		await giveGuildAvatar(userId, guildId);
		await grantDays(userId, 'payriff', 1);
		const crowned = mapUserToPartialResponse(await readUser(userId));
		expect(crowned.flags & PublicUserFlags.PREMIUM_BADGE).not.toBe(0);
		vi.setSystemTime(NOW.getTime() + ms('1 day') + 1000);
		vi.spyOn(createUsersServiceClient(), 'getUserPartialResponses').mockResolvedValue(new Map([[userId, crowned]]));
		watchGuildDispatches();

		await processUser(await readUser(userId), getWorkerDependencies(), emptySweepResult());

		expect(memberUpdates(guildId).map((member) => member.avatar)).toEqual([null, null]);
		expect(memberUpdateBadges(guildId)).toEqual([false, false]);
	});

	it('a session start announces the badge change only after it has removed the guild perks', async () => {
		const {userId, guildId} = await createGuildMember();
		await giveGuildAvatar(userId, guildId);
		await grantOneDayAndLapse(userId);
		watchGuildDispatches();

		await startSession(await readUser(userId), [createGuildID(BigInt(guildId))]);

		expect(memberUpdates(guildId).map((member) => member.avatar)).toEqual([null, null]);
		expect(memberUpdateBadges(guildId)).toEqual([false, false]);
	});

	it('a ledger repair that an unlocked strip overtakes announces the badge again', async () => {
		const {userId, guildId} = await createGuildMember();
		await grantDays(userId, 'payriff', 7);
		// The user row lapses while the ledger still holds paid time: the case the repair exists for.
		const past = new Date(NOW.getTime() - ms('1 day'));
		await getUserRepository().patchUpsert(userId, {premium_gift_extension_ends_at: past, premium_grace_ends_at: past});
		watchGuildDispatches();
		const userRepository = getUserRepository();
		const readUserRow = userRepository.findUnique.bind(userRepository);
		vi.spyOn(userRepository, 'findUnique').mockImplementationOnce(async (id) => {
			const lapsed = (await readUserRow(id))!;
			// An unlocked strip (a profile view or a session start that checked the ledger before the paid time landed)
			// lands between the repair's read and its write, and announces the badge gone.
			await processUser(lapsed, getWorkerDependencies(), emptySweepResult());
			return lapsed;
		});

		await getPremiumLedgerService().ensureUserPremium(userId);

		expect(checkIsPremium(await readUser(userId))).toBe(true);
		expect(memberUpdateBadges(guildId)).toEqual([false, true]);
	});

	it('a profile read in a guild that strips lapsed premium answers without the badge', async () => {
		const {userId, token, guildId} = await createGuildMember();
		await grantOneDayAndLapse(userId);

		const profile = await createBuilder<UserProfileFullResponse>(harness, token)
			.get(`/users/${userId}/profile?guild_id=${guildId}`)
			.execute();

		expect((await readUser(userId)).premiumType).toBeNull();
		expect(profile.user.flags & PublicUserFlags.PREMIUM_BADGE).toBe(0);
		expect(profile.guild_member?.user.id).toBe(userId.toString());
		expect(profile.guild_member!.user.flags & PublicUserFlags.PREMIUM_BADGE).toBe(0);
	});

	// One users service cache invalidation per strip: the announcement already refreshes it.
	it('a session start that strips lapsed premium refreshes the users service cache once', async () => {
		const {userId} = await createGuildMember();
		await grantOneDayAndLapse(userId);
		const invalidateUserCache = vi.spyOn(UserCacheService.prototype, 'invalidateUserCache');

		await startSession(await readUser(userId));

		expect(invalidateUserCache).toHaveBeenCalledTimes(1);
	});

	it('a session start that strips premium with the badge hidden still refreshes the users service cache once', async () => {
		const {userId, guildId} = await createGuildMember();
		await getUserRepository().patchUpsert(userId, {premium_flags: PremiumFlags.BADGE_HIDDEN});
		await grantOneDayAndLapse(userId);
		watchGuildDispatches();
		const invalidateUserCache = vi.spyOn(UserCacheService.prototype, 'invalidateUserCache');

		await startSession(await readUser(userId));

		expect((await readUser(userId)).premiumType).toBeNull();
		expect(memberUpdateBadges(guildId)).toEqual([]);
		expect(invalidateUserCache).toHaveBeenCalledTimes(1);
	});

	it('the expiration sweep refreshes the users service cache once per strip', async () => {
		const {userId} = await createGuildMember();
		await grantOneDayAndLapse(userId);
		const invalidateUserCache = vi.spyOn(UserCacheService.prototype, 'invalidateUserCache');

		await processUser(await readUser(userId), getWorkerDependencies(), emptySweepResult());

		expect((await readUser(userId)).premiumType).toBeNull();
		expect(invalidateUserCache).toHaveBeenCalledTimes(1);
	});

	// PERKS_DISABLED takes the badge off, so the self-service switch announces both directions.
	it('switching premium perks off and on sends GUILD_MEMBER_UPDATE without and then with the badge', async () => {
		const {userId, token, guildId} = await createGuildMember();
		await grantDays(userId, 'payriff', 7);
		watchGuildDispatches();

		await createBuilder(harness, token).patch('/premium/perks-disabled').body({disabled: true}).execute();
		expect(memberUpdateBadges(guildId)).toEqual([false]);
		await createBuilder(harness, token).patch('/premium/perks-disabled').body({disabled: false}).execute();

		expect(memberUpdateBadges(guildId)).toEqual([false, true]);
	});

	it('switching premium perks off still succeeds when queueing the badge propagation fails', async () => {
		const {userId, token} = await createGuildMember();
		await grantDays(userId, 'payriff', 7);
		failPropagationQueue();

		await createBuilder(harness, token)
			.patch('/premium/perks-disabled')
			.body({disabled: true})
			.expect(HTTP_STATUS.OK)
			.execute();

		expect(failedEnqueues).toBe(1);
		expect(((await readUser(userId)).premiumFlags & PremiumFlags.PERKS_DISABLED) !== 0).toBe(true);
	});

	// Visionary is lifetime premium written outside the ledger, so its grant and take-back announce the badge themselves.
	describe('Visionary', () => {
		const visionary = () => getVisionaryService();

		async function visionaryGuildMember(): Promise<{userId: UserID; guildId: string}> {
			const member = await createGuildMember();
			await visionary().setTotal(1);
			return member;
		}

		it('an order delivery sends GUILD_MEMBER_UPDATE with the badge', async () => {
			const {userId, guildId} = await visionaryGuildMember();
			watchGuildDispatches();

			await visionary().deliverForOrder(userId, 1n);

			expect((await readUser(userId)).premiumType).toBe(UserPremiumTypes.LIFETIME);
			expect(memberUpdateBadges(guildId)).toEqual([true]);
		});

		it('an admin grant sends GUILD_MEMBER_UPDATE with the badge', async () => {
			const {userId, guildId} = await visionaryGuildMember();
			watchGuildDispatches();

			await visionary().adminGrant(userId);

			expect((await readUser(userId)).premiumType).toBe(UserPremiumTypes.LIFETIME);
			expect(memberUpdateBadges(guildId)).toEqual([true]);
		});

		it('a take-back with no ledger time sends GUILD_MEMBER_UPDATE without the badge', async () => {
			const {userId, guildId} = await visionaryGuildMember();
			await visionary().adminGrant(userId);
			watchGuildDispatches();

			await visionary().adminRevoke(userId);

			expect((await readUser(userId)).premiumType).toBeNull();
			expect(memberUpdateBadges(guildId)).toEqual([false]);
		});

		it('a take-back that paid ledger time outlasts never announces the badge off', async () => {
			const {userId, guildId} = await visionaryGuildMember();
			await grantDays(userId, 'payriff', 30);
			await visionary().adminGrant(userId);
			watchGuildDispatches();

			await visionary().adminRevoke(userId);

			expect((await readUser(userId)).premiumType).toBe(UserPremiumTypes.SUBSCRIPTION);
			expect(memberUpdateBadges(guildId)).not.toContain(false);
		});

		it('a subscriber who buys Visionary sends no GUILD_MEMBER_UPDATE', async () => {
			const {userId, guildId} = await visionaryGuildMember();
			await grantDays(userId, 'payriff', 30);
			watchGuildDispatches();

			await visionary().deliverForOrder(userId, 1n);

			expect((await readUser(userId)).premiumType).toBe(UserPremiumTypes.LIFETIME);
			expect(memberUpdateBadges(guildId)).toEqual([]);
		});

		it('a grant that an unlocked strip overtakes announces the badge again', async () => {
			const {userId, guildId} = await visionaryGuildMember();
			await grantOneDayAndLapse(userId);
			watchGuildDispatches();
			const userRepository = getUserRepository();
			const readUserRow = userRepository.findUnique.bind(userRepository);
			vi.spyOn(userRepository, 'findUnique').mockImplementationOnce(async (id) => {
				const lapsed = (await readUserRow(id))!;
				// A session start or profile view strips the lapsed premium between the grant's read and its write.
				await processUser(lapsed, getWorkerDependencies(), emptySweepResult());
				return lapsed;
			});

			await visionary().adminGrant(userId);

			expect((await readUser(userId)).premiumType).toBe(UserPremiumTypes.LIFETIME);
			expect(memberUpdateBadges(guildId)).toEqual([false, true]);
		});

		it('a grant and a take-back keep their writes when queueing the badge propagation fails', async () => {
			const {userId} = await visionaryGuildMember();
			failPropagationQueue();

			await visionary().adminGrant(userId);
			expect((await readUser(userId)).premiumType).toBe(UserPremiumTypes.LIFETIME);
			await visionary().adminRevoke(userId);

			expect(failedEnqueues).toBe(2);
			expect((await readUser(userId)).premiumType).toBeNull();
		});

		it('a take-back still announces the badge when writing the ledger time back fails', async () => {
			const {userId, guildId} = await visionaryGuildMember();
			await visionary().adminGrant(userId);
			watchGuildDispatches();
			vi.spyOn(PremiumLedgerService.prototype, 'ensureUserPremiumLocked').mockRejectedValueOnce(
				new Error('ledger unavailable'),
			);

			await expect(visionary().adminRevoke(userId)).rejects.toThrow('ledger unavailable');

			expect((await readUser(userId)).premiumType).toBeNull();
			expect(memberUpdateBadges(guildId)).toEqual([false]);
		});

		// A repeated take-back finds no Visionary and announces nothing, so the failed USER_UPDATE must come after.
		it('a grant and a take-back still announce the badge when the USER_UPDATE dispatch fails', async () => {
			const {userId, guildId} = await visionaryGuildMember();
			watchGuildDispatches();
			failPresenceDispatch();

			await expect(visionary().adminGrant(userId)).rejects.toThrow('gateway is down');
			await expect(visionary().adminRevoke(userId)).rejects.toThrow('gateway is down');

			expect((await readUser(userId)).premiumType).toBeNull();
			expect(memberUpdateBadges(guildId)).toEqual([true, false]);
		});
	});
});

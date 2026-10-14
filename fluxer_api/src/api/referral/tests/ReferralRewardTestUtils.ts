// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {
	REFERRAL_PENDING_COUNTER,
	REFERRAL_REJECTED_COUNTER,
	REFERRAL_VALID_COUNTER,
} from '@app/api/database/types/ReferralTypes';
import {KVCounterService} from '@app/api/infrastructure/KVCounterService';
import type {ReferralConfig, ReferralTierConfig} from '@app/api/instance/InstanceConfigRepository';
import type {User} from '@app/api/models/User';
import {ReferralRepository, type ReferralStatsField} from '@app/api/referral/ReferralRepository';
import {ReferralRewardService, type ReferralRewardServiceDeps} from '@app/api/referral/ReferralRewardService';
import type {RegistrationEventRecord} from '@app/api/risk/adapters/VelocityAdapter';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {getIpNetworkKey} from '@fluxer/ip_utils/src/IpAddress';
import type {ReferralTierReward} from '@fluxer/schema/src/domains/referral/ReferralRequestSchemas';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {vi} from 'vitest';

export const DAY_MS = 86_400_000;
export const REFERRER = createUserID(1490000000000000100n);
export const REFERRED_AT = new Date('2026-10-01T10:00:00.000Z');
export const daysAfter = (days: number) => new Date(REFERRED_AT.getTime() + days * DAY_MS);

export interface TestUser {
	id: UserID;
	flags: bigint;
	isBot: boolean;
	isSystem: boolean;
	email: string | null;
	emailVerified: boolean;
	lastActiveAt: Date | null;
	lastActiveIp: string | null;
	traits: Set<string>;
	tempBannedUntil: Date | null;
	deletionStartedAt: Date | null;
	pendingDeletionAt: Date | null;
}

export interface Job {
	task: string;
	payload: Record<string, unknown>;
	options?: {jobKey?: string};
}

const STATS_FIELDS: Record<string, ReferralStatsField> = {
	[REFERRAL_VALID_COUNTER]: 'valid_count',
	[REFERRAL_PENDING_COUNTER]: 'pending_count',
	[REFERRAL_REJECTED_COUNTER]: 'rejected_count',
};

// ReferralRewardService over the real repository on the in-memory Cassandra executor and KV counters on the mock KV;
// users, IP authorizations, registration events, cosmetics, the Premium ledger and the job queue are fakes.
export function createRewardFixture() {
	setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
	const repository = new ReferralRepository();
	const kvClient = new MockKVProvider();
	const kvCounterService = new KVCounterService(kvClient);
	for (const [namespace, field] of Object.entries(STATS_FIELDS)) {
		kvCounterService.register({
			namespace,
			readBase: async (id) => Number((await repository.getStats(createUserID(BigInt(id))))?.[field] ?? 0),
			flush: (id, value) => repository.writeStatsField(createUserID(BigInt(id)), field, value),
			recount: async () => 0,
		});
	}
	const config: ReferralConfig = {
		enabled: false,
		min_active_days: 3,
		daily_valid_cap: 50,
		ip_registration_limit: 3,
		tiers: [],
	};
	const users = new Map<bigint, TestUser>();
	const authorizedIps = new Map<bigint, Set<string>>();
	const registrations: Array<RegistrationEventRecord> = [];
	const jobs: Array<Job> = [];
	const cosmeticService = {deliverOwned: vi.fn(async () => 'delivered' as const)};
	const premiumLedgerService = {grant: vi.fn(async () => ({paidUntil: new Date(), newlyApplied: true}))};
	const deps = {
		repository,
		instanceConfigRepository: {
			getReferralConfig: async () => structuredClone(config),
			readStoredReferralConfig: async () => structuredClone(config),
		},
		kvCounterService,
		kvClient,
		userRepository: {
			findUnique: async (id: UserID) => (users.get(id) as unknown as User) ?? null,
			checkIpAuthorized: async (id: UserID, ip: string) => authorizedIps.get(id)?.has(ip) ?? false,
		},
		registrationEventsRepository: {
			listByIp: async (ip: string, since: Date) => registrations.filter((e) => e.ip === ip && e.createdAt >= since),
			listBySubnet: async (subnet: string, since: Date) =>
				registrations.filter(
					(e) => getIpNetworkKey(e.ip, {ipv4PrefixLength: 24, ipv6PrefixLength: 48}) === subnet && e.createdAt >= since,
				),
		},
		cosmeticService,
		premiumLedgerService,
		workerService: {
			addJob: async (task: string, payload: Record<string, unknown>, options?: {jobKey?: string}) => {
				jobs.push({task, payload, options});
				return BigInt(jobs.length);
			},
		},
	} as unknown as ReferralRewardServiceDeps;
	const service = new ReferralRewardService(deps);

	function addUser(id: bigint, patch: Partial<TestUser> = {}): TestUser {
		const user: TestUser = {
			id: createUserID(id),
			flags: 0n,
			isBot: false,
			isSystem: false,
			email: `user${id}@example.com`,
			emailVerified: true,
			lastActiveAt: daysAfter(3),
			lastActiveIp: null,
			traits: new Set(),
			tempBannedUntil: null,
			deletionStartedAt: null,
			pendingDeletionAt: null,
			...patch,
		};
		users.set(id, user);
		return user;
	}

	// A registration through REFERRER's link, as ReferralService.attachAtRegistration leaves it: the mapping, the check
	// at referred_at + N days and the pending count.
	async function refer(
		refereeId: bigint,
		opts: {referredAt?: Date; regIp?: string; riskBlocked?: boolean; referrerId?: UserID} = {},
	) {
		const referredAt = opts.referredAt ?? REFERRED_AT;
		const referrerId = opts.referrerId ?? REFERRER;
		const dueAt = new Date(referredAt.getTime() + config.min_active_days * DAY_MS);
		await repository.recordReferral(
			{
				refereeId: createUserID(refereeId),
				referrerId,
				referredAt,
				regIp: opts.regIp ?? `198.51.100.${Number(refereeId % 200n) + 1}`,
				riskBlocked: opts.riskBlocked ?? false,
			},
			{dueAt, ttlSeconds: 17 * 86_400},
		);
		await kvCounterService.add(REFERRAL_PENDING_COUNTER, referrerId.toString(), 1);
		return dueAt;
	}

	const counts = async (userId: UserID = REFERRER) => ({
		valid: await kvCounterService.get(REFERRAL_VALID_COUNTER, userId.toString()),
		pending: await kvCounterService.get(REFERRAL_PENDING_COUNTER, userId.toString()),
		rejected: await kvCounterService.get(REFERRAL_REJECTED_COUNTER, userId.toString()),
	});

	function addTier(id: string, threshold: number, reward: ReferralTierReward, enabled = true): ReferralTierConfig {
		const tier = {id, threshold, reward, enabled, created_at: REFERRED_AT.toISOString()};
		config.tiers.push(tier);
		return tier;
	}

	const setValid = (userId: UserID, count: number) =>
		kvCounterService.add(REFERRAL_VALID_COUNTER, userId.toString(), count);

	return {
		service,
		repository,
		kvClient,
		kvCounterService,
		config,
		users,
		authorizedIps,
		registrations,
		jobs,
		cosmeticService,
		premiumLedgerService,
		addUser,
		refer,
		counts,
		addTier,
		setValid,
	};
}

export type RewardFixture = ReturnType<typeof createRewardFixture>;

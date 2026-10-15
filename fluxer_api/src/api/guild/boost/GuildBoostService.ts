// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import {createGuildID, type GuildID, type UserID} from '@app/api/BrandedTypes';
import type {
	GuildBoostRow,
	GuildBoostStateRow,
	GuildEntitlementExpirationRow,
} from '@app/api/database/types/GuildBoostTypes';
import type {PremiumLedgerRow} from '@app/api/database/types/PremiumLedgerTypes';
import {GUILD_BOOST_COUNT_COUNTER} from '@app/api/guild/boost/GuildBoostCounters';
import {
	GUILD_BOOST_FEATURES,
	GUILD_BOOST_LEVELS,
	guildBoostFeatures,
	guildBoostTier,
} from '@app/api/guild/boost/GuildBoostLevels';
import type {GuildBoostRepository} from '@app/api/guild/boost/GuildBoostRepository';
import {mapGuildToGuildResponse} from '@app/api/guild/GuildModel';
import type {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import {setGuildVanityCode, withGuildVanityLock} from '@app/api/guild/services/data/GuildVanityService';
import {withGuildUpdateLock} from '@app/api/guild/services/GuildService';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {ISnowflakeService} from '@app/api/infrastructure/ISnowflakeService';
import type {KVCounterService} from '@app/api/infrastructure/KVCounterService';
import type {UserCacheService} from '@app/api/infrastructure/UserCacheService';
import type {InviteRepository} from '@app/api/invite/InviteRepository';
import {Logger} from '@app/api/Logger';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {resolveLimitSafe} from '@app/api/limits/LimitConfigUtils';
import {createLimitMatchContext} from '@app/api/limits/LimitMatchContextBuilder';
import type {RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import type {Guild} from '@app/api/models/Guild';
import type {User} from '@app/api/models/User';
import type {PremiumLedgerRepository} from '@app/api/premium/ledger/PremiumLedgerRepository';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import {getEffectivePremiumUntil, PREMIUM_GRACE_PERIOD_MS} from '@app/api/user/UserHelpers';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import type {WorkerTaskName} from '@app/api/worker/WorkerLaneConfig';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {PremiumFlags, UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {ConflictError} from '@fluxer/errors/src/domains/core/ConflictError';
import {MissingAccessError} from '@fluxer/errors/src/domains/core/MissingAccessError';
import {NotFoundError} from '@fluxer/errors/src/domains/core/NotFoundError';
import {UnknownGuildError} from '@fluxer/errors/src/domains/guild/UnknownGuildError';
import {PREMIUM_BOOST_SLOT_ID_REGEX} from '@fluxer/schema/src/domains/boost/BoostRequestSchemas';
import type {GuildBoostResponse, UserBoostSlotResponse} from '@fluxer/schema/src/domains/boost/BoostResponseSchemas';
import type {GuildResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';
import type {ICacheService} from '@pkgs/cache/src/ICacheService';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';
import {ms} from 'itty-time';
import {z} from 'zod';

interface GuildBoostServiceDeps {
	repository: GuildBoostRepository;
	guildRepository: GuildRepository;
	kvClient: IKVProvider;
	workerService: IWorkerService<WorkerTaskName>;
	gatewayService: IGatewayService;
	limitConfigService: LimitConfigService;
	snowflakeService: ISnowflakeService;
	kvCounterService: KVCounterService;
	cacheService: ICacheService;
	userRepository: Pick<UserRepository, 'findUnique'>;
	userCacheService: UserCacheService;
	inviteRepository: InviteRepository;
	premiumLedgerRepository: Pick<PremiumLedgerRepository, 'find'>;
}

// a lost level holds for 3 days, a custom invite code the level paid for stays reserved for
// 30 days after VANITY_URL goes, and a slot waits 7 days after it was put on a guild before it boosts again.
export const GUILD_BOOST_DOWNGRADE_GRACE_MS = ms('3 days');
export const GUILD_BOOST_VANITY_HOLD_MS = ms('30 days');
export const GUILD_BOOST_SLOT_COOLDOWN_MS = ms('7 days');
const GUILD_BOOST_OPEN_ENDED_RECHECK_MS = ms('30 days');
export const PREMIUM_SLOT_PREFIX = 'premium:';
// Same shard count as the table comment in GuildBoostTables.ts (guild_id % 16).
export const GUILD_ENTITLEMENT_EXPIRATION_SHARDS = 16;
// entitlement_id 0 marks a wake-up for the guild's own timers (level grace, vanity hold); other ids are boost ids.
export const GUILD_BOOST_TIMER_ENTITLEMENT_ID = 0n;

const RECOMPUTE_DIRTY_TTL_SECONDS = 3600;
const RECOMPUTE_QUEUED_TTL_SECONDS = 60;
const RECOUNT_INTERVAL_SECONDS = 86_400;
// Boosts landing within this window share one recompute and at most one GUILD_UPDATE.
const RECOMPUTE_DELAY_MS = 5000;
const MAX_SLOT_CAS_ATTEMPTS = 5;
const DAY_MS = ms('1 day');
// TEMPORARY: the hourly expiration run looks back 7 days; a worker outage longer than that leaves older rows unread.
// Keep a KV cursor of the oldest unsettled day (ProcessPremiumExpirations does) if outages that long ever happen.
const EXPIRATION_WINDOW_DAYS = 7;
const EXPIRATION_PAGE_SIZE = 500;
const EXPIRATION_ROW_CONCURRENCY = 16;
const UNAVAILABLE_FEATURES: ReadonlySet<string> = new Set([
	GuildFeatures.UNAVAILABLE_FOR_EVERYONE,
	GuildFeatures.UNAVAILABLE_FOR_EVERYONE_BUT_STAFF,
]);

type BoostRef = Pick<GuildBoostRow, 'guild_id' | 'boost_id' | 'user_id' | 'slot_id'>;

// Only the standard spelling counts, so a stored alias row (premium:00) is taken off by the expiration run.
export function parsePremiumSlotIndex(slotId: string): number | null {
	const match = PREMIUM_BOOST_SLOT_ID_REGEX.exec(slotId);
	return match ? Number(match[1]) : null;
}

export function guildEntitlementDay(at: Date): number {
	return Math.floor(at.getTime() / DAY_MS);
}

export function guildEntitlementShard(guildId: GuildID): number {
	return Number(guildId % BigInt(GUILD_ENTITLEMENT_EXPIRATION_SHARDS));
}

function recomputeDirtyKey(guildId: GuildID): string {
	return `boost:recompute:dirty:{${guildId}}`;
}

function recomputeQueuedKey(guildId: GuildID): string {
	return `boost:recompute:queued:{${guildId}}`;
}

function recountKey(guildId: GuildID): string {
	return `boost:recount:{${guildId}}`;
}

// The boost features a recompute is about to write to the guild, recorded before the guild write and cleared after the
// state write, so a recompute that stops in between does not leave them looking like an admin's.
function pendingFeaturesKey(guildId: GuildID): string {
	return `boost:features:pending:{${guildId}}`;
}

// the card-free trial pays for no slot, or many accounts could buy a level (and a custom invite code) for free.
function isTrialOnlyPremium(user: User, ledger: PremiumLedgerRow | null): boolean {
	if (!ledger?.trial_used_at || !ledger.paid_until || (ledger.applied_grants?.size ?? 0) > 0) {
		return false;
	}
	if (user.premiumType === UserPremiumTypes.LIFETIME || (user.premiumFlags & PremiumFlags.ENABLED_OVERRIDE) !== 0) {
		return false;
	}
	const until = getEffectivePremiumUntil(user);
	return until !== null && until.getTime() <= ledger.paid_until.getTime();
}

// When a boost's premium is next checked: when the account stops paying for its slots, grace included, or a month out
// when its premium has no end (lifetime, an override), so a boost whose premium is taken away later still comes off.
function premiumSlotsEndAt(user: User): Date {
	const recheckAt = new Date(Date.now() + GUILD_BOOST_OPEN_ENDED_RECHECK_MS);
	if (user.premiumType === UserPremiumTypes.LIFETIME || (user.premiumFlags & PremiumFlags.ENABLED_OVERRIDE) !== 0) {
		return recheckAt;
	}
	const until = getEffectivePremiumUntil(user);
	if (!until) {
		return recheckAt;
	}
	const graceEnd = user.premiumGraceEndsAt?.getTime() ?? until.getTime() + PREMIUM_GRACE_PERIOD_MS;
	return new Date(Math.max(until.getTime(), graceEnd));
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	return a.size === b.size && [...a].every((value) => b.has(value));
}

function sameTime(a: Date | null, b: Date | null): boolean {
	return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

function stateChanged(before: GuildBoostStateRow, after: GuildBoostStateRow): boolean {
	return (
		before.boost_count !== after.boost_count ||
		before.premium_tier !== after.premium_tier ||
		!setsEqual(before.granted_features ?? new Set(), after.granted_features ?? new Set()) ||
		!setsEqual(before.suppressed_features ?? new Set(), after.suppressed_features ?? new Set()) ||
		!sameTime(before.downgrade_at, after.downgrade_at) ||
		!sameTime(before.vanity_release_at, after.vanity_release_at)
	);
}

const pendingFeatures = z
	.array(z.string().refine((feature) => GUILD_BOOST_FEATURES.has(feature)))
	.max(GUILD_BOOST_FEATURES.size);
const pendingTimestamp = z.number().int().min(0).max(8_640_000_000_000_000);
const pendingChangeSchema = z
	.object({
		format_version: z.literal(1),
		operation_version: z.number().int().min(1).max(2_147_483_647),
		previous_granted: pendingFeatures,
		previous_suppressed: pendingFeatures,
		add: pendingFeatures,
		remove: pendingFeatures,
		granted: pendingFeatures,
		suppressed: pendingFeatures,
		boost_count: z.number().int().nonnegative(),
		premium_tier: z.number().int().min(0).max(GUILD_BOOST_LEVELS.length),
		downgrade_at: pendingTimestamp.nullable(),
		vanity_release_at: pendingTimestamp.nullable(),
		updated_at: pendingTimestamp,
		release_vanity: z.boolean(),
	})
	.strict();
type PendingFeatureChange = z.infer<typeof pendingChangeSchema>;

function readPendingChange(state: GuildBoostStateRow): PendingFeatureChange | null {
	if (state.pending_feature_changes == null) return null;
	try {
		if (state.pending_feature_changes.length > 16_384) throw new Error('Oversized guild boost feature intent');
		const pending = pendingChangeSchema.parse(JSON.parse(state.pending_feature_changes));
		if (pending.operation_version !== state.version + 1) throw new Error('Stale guild boost feature intent');
		return pending;
	} catch (error) {
		Logger.warn({error, guildId: state.guild_id.toString()}, 'Ignoring invalid guild boost feature intent');
		return null;
	}
}

function completedState(state: GuildBoostStateRow, pending: PendingFeatureChange): GuildBoostStateRow {
	return {
		guild_id: state.guild_id,
		boost_count: pending.boost_count,
		premium_tier: pending.premium_tier,
		granted_features: new Set(pending.granted),
		suppressed_features: new Set(pending.suppressed),
		downgrade_at: pending.downgrade_at === null ? null : new Date(pending.downgrade_at),
		vanity_release_at: pending.vanity_release_at === null ? null : new Date(pending.vanity_release_at),
		updated_at: new Date(pending.updated_at),
		version: pending.operation_version,
		pending_feature_changes: null,
	};
}

export interface GuildBoostPlan {
	tier: number;
	add: Set<string>;
	remove: Set<string>;
	features: Set<string>;
	granted: Set<string>;
	suppressed: Set<string>;
	downgradeAt: Date | null;
	vanityReleaseAt: Date | null;
	releaseVanity: boolean;
}

/**
 * Works out a guild's level and boost features from its boost count and stored boost state. Only the features the
 * boosts added (`granted_features`) are ever removed, so a feature an admin gave stays. A granted feature that is gone
 * from the guild was taken away by someone else (owners cannot toggle these), so it becomes suppressed and boosting
 * never adds it back until an admin does. `pending` are the features an earlier recompute recorded before its guild
 * write; those on the guild are the boosts' own even when that recompute stopped before its state write.
 */
export function planGuildBoost(
	guild: Pick<Guild, 'features' | 'premiumTier' | 'vanityUrlCode'>,
	count: number,
	state: GuildBoostStateRow | null,
	now: Date,
	pending: ReadonlyArray<string> = [],
): GuildBoostPlan {
	const heldTier = state?.premium_tier ?? guild.premiumTier ?? 0;
	const target = guildBoostTier(count);
	let tier = target;
	let downgradeAt: Date | null = null;
	if (target < heldTier) {
		downgradeAt = state?.downgrade_at ?? new Date(now.getTime() + GUILD_BOOST_DOWNGRADE_GRACE_MS);
		if (now < downgradeAt) {
			tier = heldTier;
		} else {
			downgradeAt = null;
		}
	}
	const current = guild.features;
	const landed = pending.filter((feature) => current.has(feature));
	const grantedBefore = [...new Set([...(state?.granted_features ?? []), ...landed])].filter((feature) =>
		GUILD_BOOST_FEATURES.has(feature),
	);
	const suppressed = new Set(
		[...(state?.suppressed_features ?? [])].filter(
			(feature) => GUILD_BOOST_FEATURES.has(feature) && !current.has(feature),
		),
	);
	for (const feature of grantedBefore) {
		if (!current.has(feature)) suppressed.add(feature);
	}
	const desired = guildBoostFeatures(tier);
	const kept = grantedBefore.filter((feature) => current.has(feature));
	const add = new Set([...desired].filter((feature) => !current.has(feature) && !suppressed.has(feature)));
	const remove = new Set(kept.filter((feature) => !desired.has(feature)));
	const features = new Set([...current].filter((feature) => !remove.has(feature)));
	for (const feature of add) features.add(feature);
	const granted = new Set([...kept.filter((feature) => !remove.has(feature)), ...add]);
	let vanityReleaseAt = state?.vanity_release_at ?? null;
	if (remove.has(GuildFeatures.VANITY_URL) && guild.vanityUrlCode != null) {
		vanityReleaseAt = new Date((state?.downgrade_at ?? now).getTime() + GUILD_BOOST_VANITY_HOLD_MS);
	}
	if (features.has(GuildFeatures.VANITY_URL)) {
		vanityReleaseAt = null;
	}
	const releaseVanity = vanityReleaseAt !== null && now >= vanityReleaseAt;
	return {tier, add, remove, features, granted, suppressed, downgradeAt, vanityReleaseAt, releaseVanity};
}

export class GuildBoostService {
	constructor(private readonly deps: GuildBoostServiceDeps) {}

	async applyAdminFeatureChanges(
		guildId: GuildID,
		addFeatures: ReadonlyArray<string>,
		removeFeatures: ReadonlyArray<string>,
	): Promise<Guild> {
		return withGuildUpdateLock(this.deps.cacheService, guildId, async () => {
			let guild = await this.deps.guildRepository.findUnique(guildId);
			if (!guild) throw new UnknownGuildError();
			let state = await this.deps.repository.getState(guildId);
			if (state && readPendingChange(state)) {
				({guild, state} = await this.finishPendingChange(guild, state));
			}
			const features = new Set(guild.features);
			const legacyRaw = await this.deps.kvClient.get(pendingFeaturesKey(guildId));
			const legacy = legacyRaw === null ? [] : pendingFeatures.parse(JSON.parse(legacyRaw));
			const granted = new Set(
				[...(state?.granted_features ?? []), ...legacy.filter((feature) => features.has(feature))].filter((feature) =>
					GUILD_BOOST_FEATURES.has(feature),
				),
			);
			const suppressed = new Set(state?.suppressed_features ?? []);
			for (const feature of addFeatures) {
				features.add(feature);
				granted.delete(feature);
				suppressed.delete(feature);
			}
			for (const feature of removeFeatures) {
				features.delete(feature);
				granted.delete(feature);
				if (GUILD_BOOST_FEATURES.has(feature)) suppressed.add(feature);
			}
			const plan: GuildBoostPlan = {
				tier: state?.premium_tier ?? guild.premiumTier ?? 0,
				features,
				granted,
				suppressed,
				add: new Set([...features].filter((feature) => !guild.features.has(feature))),
				remove: new Set([...guild.features].filter((feature) => !features.has(feature))),
				downgradeAt: state?.downgrade_at ?? null,
				vanityReleaseAt: state?.vanity_release_at ?? null,
				releaseVanity: false,
			};
			return (await this.commitPlan(guild, state, plan, state?.boost_count ?? 0, new Date())).guild;
		});
	}

	private async finishPendingChange(
		guild: Guild,
		state: GuildBoostStateRow,
		plannedFeatures?: Set<string>,
	): Promise<{guild: Guild; state: GuildBoostStateRow}> {
		const pending = readPendingChange(state)!;
		// The durable intent now contains legacy ownership; an old KV array must not outlive an admin decision.
		await this.deps.kvClient.del(pendingFeaturesKey(guild.id));
		const features =
			plannedFeatures ?? new Set([...guild.features].filter((feature) => !pending.remove.includes(feature)));
		for (const feature of pending.add) features.add(feature);
		if (!setsEqual(features, guild.features) || pending.premium_tier !== (guild.premiumTier ?? 0)) {
			guild = await this.deps.guildRepository.upsertPartial(
				guild.id,
				{features, premium_tier: pending.premium_tier},
				guild.toRow(),
			);
		}
		const next = completedState(state, pending);
		if (pending.release_vanity) {
			guild = (await this.releaseHeldVanity(guild)) ?? guild;
			next.vanity_release_at = null;
		}
		await this.deps.repository.putState(next);
		return {guild, state: next};
	}

	private async commitPlan(
		guild: Guild,
		state: GuildBoostStateRow | null,
		plan: GuildBoostPlan,
		count: number,
		now: Date,
	): Promise<{guild: Guild; state: GuildBoostStateRow}> {
		const next: GuildBoostStateRow = {
			guild_id: guild.id,
			boost_count: count,
			premium_tier: plan.tier,
			granted_features: plan.granted,
			suppressed_features: plan.suppressed,
			downgrade_at: plan.downgradeAt,
			vanity_release_at: plan.vanityReleaseAt,
			updated_at: now,
			version: (state?.version ?? 0) + 1,
			pending_feature_changes: null,
		};
		const needsIntent =
			plan.add.size > 0 ||
			plan.remove.size > 0 ||
			plan.releaseVanity ||
			plan.tier !== (guild.premiumTier ?? 0) ||
			!state ||
			!setsEqual(state.granted_features ?? new Set(), plan.granted) ||
			!setsEqual(state.suppressed_features ?? new Set(), plan.suppressed);
		if (!needsIntent) {
			if (stateChanged(state!, next)) {
				await this.deps.repository.putState(next);
				return {guild, state: next};
			}
			return {guild, state: state!};
		}
		const onlyBoostFeatures = (features: Iterable<string>) =>
			[...features].filter((feature) => GUILD_BOOST_FEATURES.has(feature));
		const pending = pendingChangeSchema.parse({
			format_version: 1,
			operation_version: next.version,
			previous_granted: onlyBoostFeatures(state?.granted_features ?? []),
			previous_suppressed: onlyBoostFeatures(state?.suppressed_features ?? []),
			add: onlyBoostFeatures(plan.add),
			remove: onlyBoostFeatures(plan.remove),
			granted: onlyBoostFeatures(plan.granted),
			suppressed: onlyBoostFeatures(plan.suppressed),
			boost_count: count,
			premium_tier: plan.tier,
			downgrade_at: plan.downgradeAt?.getTime() ?? null,
			vanity_release_at: plan.vanityReleaseAt?.getTime() ?? null,
			updated_at: now.getTime(),
			release_vanity: plan.releaseVanity,
		});
		// Previous ownership stays on the row until the guild and the final state both reflect the intent.
		const pendingState: GuildBoostStateRow = {
			...(state ?? {...next, granted_features: null, suppressed_features: null}),
			version: next.version - 1,
			pending_feature_changes: JSON.stringify(pending),
		};
		await this.deps.repository.putState(pendingState);
		return this.finishPendingChange(guild, pendingState, plan.features);
	}

	async getLiveBoostCount(guildId: GuildID): Promise<number> {
		return this.deps.kvCounterService.get(GUILD_BOOST_COUNT_COUNTER, guildId.toString());
	}

	// "reserved but closed": from the end of the level grace until the level comes back or the 30 day hold ends, the
	// guild keeps its custom invite code but no one joins through it. Read only for a vanity join without VANITY_URL.
	async isVanityHeld(guildId: GuildID): Promise<boolean> {
		const state = await this.deps.repository.getState(guildId);
		return state != null && (state.vanity_release_at != null || readPendingChange(state)?.vanity_release_at != null);
	}

	async getSlotCount(user: User): Promise<number> {
		const max = resolveLimitSafe(
			this.deps.limitConfigService.getConfigSnapshot(),
			createLimitMatchContext({user}),
			'max_boost_slots',
			0,
		);
		if (max <= 0) {
			return 0;
		}
		const ledger = await this.deps.premiumLedgerRepository.find(user.id);
		return isTrialOnlyPremium(user, ledger) ? 0 : Math.floor(max);
	}

	async listSlots(user: User): Promise<Array<UserBoostSlotResponse>> {
		const count = await this.getSlotCount(user);
		const rows = new Map((await this.deps.repository.listSlots(user.id)).map((row) => [row.slot_id, row]));
		return mapWithConcurrency(Array.from({length: count}), 4, async (_, index) => {
			const id = `${PREMIUM_SLOT_PREFIX}${index}`;
			const row = rows.get(id);
			// A slot left on a deleted guild is free; the next boost with it reclaims it.
			const inUse = row?.guild_id != null && (await this.deps.guildRepository.findUnique(row.guild_id)) !== null;
			return {
				id,
				guild_id: inUse ? row!.guild_id!.toString() : null,
				boost_id: inUse && row!.boost_id != null ? row!.boost_id.toString() : null,
				assigned_at: inUse && row!.assigned_at ? row!.assigned_at.toISOString() : null,
			};
		});
	}

	async listBoosts(params: {
		guildId: GuildID;
		limit: number;
		before?: bigint;
		requestCache: RequestCache;
	}): Promise<Array<GuildBoostResponse>> {
		const rows = await this.deps.repository.listBoostsNewestFirst(params.guildId, params.limit, params.before);
		return this.mapBoosts(rows, params.requestCache);
	}

	async boost(params: {
		user: User;
		guild: GuildResponse;
		slotId: string;
		requestCache: RequestCache;
	}): Promise<GuildBoostResponse> {
		const {user, guild, slotId, requestCache} = params;
		const {repository} = this.deps;
		if (guild.features.some((feature) => UNAVAILABLE_FEATURES.has(feature))) {
			throw new MissingAccessError();
		}
		const guildId = createGuildID(BigInt(guild.id));
		const index = parsePremiumSlotIndex(slotId);
		if (index === null || index >= (await this.getSlotCount(user))) {
			throw new NotFoundError({code: APIErrorCodes.NOT_FOUND});
		}
		let slot = await repository.getSlot(user.id, slotId);
		if (!slot) {
			await repository.createSlotIfAbsent(user.id, slotId, 'premium');
			slot = await repository.getSlot(user.id, slotId);
		}
		if (!slot) {
			throw new ConflictError({code: APIErrorCodes.CONFLICT});
		}
		if (slot.guild_id === guildId && slot.boost_id != null) {
			return this.recordBoost(slot.boost_id, slot.assigned_at, {user, guildId, slotId, requestCache, counted: false});
		}
		const staleGuildId = slot.guild_id;
		if (staleGuildId != null && (await this.deps.guildRepository.findUnique(staleGuildId)) !== null) {
			throw new ConflictError({code: APIErrorCodes.CONFLICT});
		}
		const now = new Date();
		if (slot.assigned_at && now.getTime() - slot.assigned_at.getTime() < GUILD_BOOST_SLOT_COOLDOWN_MS) {
			throw new ConflictError({code: APIErrorCodes.CONFLICT});
		}
		const boostId = await this.deps.snowflakeService.generate();
		// The slot CAS on the user's own partition is the only conditional write: exactly one guild wins the slot, and
		// the guild's partition and row take plain writes only.
		if (!(await repository.claimSlot(slot, {guildId, boostId, at: now}))) {
			const winner = await repository.getSlot(user.id, slotId);
			if (winner?.guild_id === guildId && winner.boost_id != null) {
				return this.recordBoost(winner.boost_id, winner.assigned_at, {
					user,
					guildId,
					slotId,
					requestCache,
					counted: false,
				});
			}
			throw new ConflictError({code: APIErrorCodes.CONFLICT});
		}
		if (staleGuildId != null && slot.boost_id != null) {
			await repository.deleteBoost(staleGuildId, slot.boost_id);
		}
		return this.recordBoost(boostId, now, {user, guildId, slotId, requestCache, counted: true});
	}

	async removeBoost(params: {userId: UserID; guildId: GuildID; boostId: bigint}): Promise<void> {
		const row = await this.deps.repository.getBoost(params.guildId, params.boostId);
		if (!row) {
			throw new NotFoundError({code: APIErrorCodes.NOT_FOUND});
		}
		if (row.user_id !== params.userId) {
			throw new MissingAccessError();
		}
		await this.removeBoostRow(row);
	}

	// leaving, being kicked or banned takes the member's boosts off the guild and frees their slots. A slot put on
	// the guild after `leftAt` belongs to a later membership (the member came back) and stays.
	async removeMemberBoosts(guildId: GuildID, userId: UserID, leftAt?: Date): Promise<void> {
		for (const slot of await this.deps.repository.listSlots(userId)) {
			if (slot.guild_id !== guildId || slot.boost_id == null) continue;
			if (leftAt && slot.assigned_at && slot.assigned_at.getTime() > leftAt.getTime()) continue;
			await this.removeBoostRow({guild_id: guildId, boost_id: slot.boost_id, user_id: userId, slot_id: slot.slot_id});
		}
	}

	/**
	 * The member removal path (kick, ban, leave, account deletion) calls this once the member row is gone. It never
	 * throws, so a failed boost cleanup cannot stop the removal; the removeMemberBoosts job retries it.
	 */
	async removeMemberBoostsOrQueue(guildId: GuildID, userId: UserID): Promise<void> {
		const leftAt = new Date();
		try {
			await this.removeMemberBoosts(guildId, userId);
		} catch (error) {
			const context = {guildId: guildId.toString(), userId: userId.toString()};
			Logger.warn({...context, error}, 'Taking the boosts of a removed member off failed; queued for retry');
			await this.deps.workerService
				.addJob('removeMemberBoosts', {...context, leftAt: leftAt.toISOString()})
				.catch((queueError: unknown) =>
					Logger.error({...context, error: queueError}, 'Failed to queue removeMemberBoosts'),
				);
		}
	}

	// Account deletion: every boost comes off and the slot rows go. Safe to run again.
	async deleteUserBoosts(userId: UserID): Promise<void> {
		for (const slot of await this.deps.repository.listSlots(userId)) {
			if (slot.guild_id != null && slot.boost_id != null) {
				await this.removeBoostRow({
					guild_id: slot.guild_id,
					boost_id: slot.boost_id,
					user_id: userId,
					slot_id: slot.slot_id,
				});
			}
		}
		await this.deps.repository.deleteSlots(userId);
	}

	async harvestUserBoosts(userId: UserID): Promise<unknown> {
		const slots = await this.deps.repository.listSlots(userId);
		return {
			slots: slots.map((slot) => ({
				id: slot.slot_id,
				source: slot.source,
				guild_id: slot.guild_id?.toString() ?? null,
				boost_id: slot.boost_id?.toString() ?? null,
				assigned_at: slot.assigned_at?.toISOString() ?? null,
			})),
		};
	}

	async recomputeDirty(guildId: GuildID): Promise<void> {
		const {kvClient} = this.deps;
		await kvClient.del(recomputeQueuedKey(guildId));
		const pending = await kvClient.get(recomputeDirtyKey(guildId));
		if (pending === null) {
			return;
		}
		await this.recountOncePerDay(guildId);
		// A held lock throws; the job is retried and the dirty flag is still set.
		await this.recompute(guildId);
		await kvClient.releaseLock(recomputeDirtyKey(guildId), pending);
		if ((await kvClient.get(recomputeDirtyKey(guildId))) !== null) {
			await this.enqueueRecompute(guildId);
		}
	}

	// Once a day per recomputed guild, before the level is worked out: recounts the boost rows their slots back, drops
	// rows no slot backs (a PUT that lost to a DELETE on the same slot) and fixes a count a request that died between its
	// slot write and its counter delta left off by one.
	// TEMPORARY: the recount runs inside the recompute job (≤ 10^5 rows, seconds at worst). Trigger: a recount over 5 s
	// -> queue it as its own rebuildCounter job and mark the guild dirty when it changes the count.
	private async recountOncePerDay(guildId: GuildID): Promise<void> {
		const {kvClient} = this.deps;
		if (!(await kvClient.setnx(recountKey(guildId), '1', RECOUNT_INTERVAL_SECONDS))) {
			return;
		}
		try {
			await this.deps.kvCounterService.rebuild(GUILD_BOOST_COUNT_COUNTER, guildId.toString());
		} catch (error) {
			Logger.warn({error, guildId: guildId.toString()}, 'Failed to recount guild boosts; the next recompute retries');
			await kvClient.del(recountKey(guildId));
		}
	}

	async recompute(guildId: GuildID): Promise<void> {
		const {repository, guildRepository, kvClient} = this.deps;
		const result = await withGuildUpdateLock(this.deps.cacheService, guildId, async () => {
			let guild = await guildRepository.findUnique(guildId);
			if (!guild) return null;
			const original = guild;
			let state = await repository.getState(guildId);
			const recovered = state ? readPendingChange(state) : null;
			if (state?.pending_feature_changes != null && !recovered) {
				state = {...state, pending_feature_changes: null};
				await repository.putState(state);
			}
			const recoveredChangeLanded =
				recovered !== null &&
				(recovered.add.some((feature) => original.features.has(feature)) ||
					recovered.remove.some((feature) => !original.features.has(feature)) ||
					(original.premiumTier === recovered.premium_tier && original.premiumTier !== state!.premium_tier));
			if (recovered) {
				({guild, state} = await this.finishPendingChange(guild, state!));
			}
			const pendingRaw = await kvClient.get(pendingFeaturesKey(guildId));
			const pending = pendingRaw === null ? [] : pendingFeatures.parse(JSON.parse(pendingRaw));
			const count = await this.getLiveBoostCount(guildId);
			const now = new Date();
			const plan = planGuildBoost(guild, count, state, now, pending);
			({guild, state} = await this.commitPlan(guild, state, plan, count, now));
			if (pendingRaw !== null) await kvClient.del(pendingFeaturesKey(guildId));
			const wakeAt = [state.downgrade_at, state.vanity_release_at]
				.filter((at): at is Date => at !== null)
				.sort((a, b) => a.getTime() - b.getTime())[0];
			if (wakeAt) {
				await repository.addExpiration({
					day: guildEntitlementDay(wakeAt),
					shard: guildEntitlementShard(guildId),
					guild_id: guildId,
					entitlement_id: GUILD_BOOST_TIMER_ENTITLEMENT_ID,
				});
			}
			const changed =
				!setsEqual(original.features, guild.features) ||
				original.premiumTier !== guild.premiumTier ||
				original.vanityUrlCode !== guild.vanityUrlCode ||
				recoveredChangeLanded;
			return changed ? {changed: guild, count} : null;
		});
		if (result) {
			// Only public feature, tier and vanity changes fan out; count and grace metadata do not.
			await this.deps.gatewayService.dispatchGuild({
				guildId,
				event: 'GUILD_UPDATE',
				data: {...mapGuildToGuildResponse(result.changed), premium_subscription_count: result.count},
			});
		}
	}

	async processExpirations(now: Date): Promise<void> {
		const today = guildEntitlementDay(now);
		for (let day = today - EXPIRATION_WINDOW_DAYS; day <= today; day++) {
			for (let shard = 0; shard < GUILD_ENTITLEMENT_EXPIRATION_SHARDS; shard++) {
				let after: GuildEntitlementExpirationRow | undefined;
				for (;;) {
					const rows = await this.deps.repository.listExpirations(day, shard, EXPIRATION_PAGE_SIZE, after);
					await mapWithConcurrency(rows, EXPIRATION_ROW_CONCURRENCY, async (row) => {
						try {
							await this.processExpirationRow(row);
						} catch (error) {
							Logger.warn(
								{error, guildId: row.guild_id.toString(), entitlementId: row.entitlement_id.toString()},
								'Failed to process a guild entitlement expiration; the next run retries it',
							);
						}
					});
					if (rows.length < EXPIRATION_PAGE_SIZE) {
						break;
					}
					after = rows[rows.length - 1];
				}
			}
		}
	}

	private async processExpirationRow(row: GuildEntitlementExpirationRow): Promise<void> {
		const {repository} = this.deps;
		if (row.entitlement_id === GUILD_BOOST_TIMER_ENTITLEMENT_ID) {
			// Deleted before the recompute is queued: the recompute writes the row again while a timer is still running.
			// Written back when the queueing fails, so the next hourly run wakes the guild again.
			await repository.deleteExpiration(row);
			try {
				await this.markDirty(row.guild_id);
			} catch (error) {
				await repository.addExpiration(row);
				throw error;
			}
			return;
		}
		const boost = await repository.getBoost(row.guild_id, row.entitlement_id);
		if (!boost) {
			await repository.deleteExpiration(row);
			return;
		}
		const user = await this.deps.userRepository.findUnique(boost.user_id);
		const index = parsePremiumSlotIndex(boost.slot_id);
		if (!user || index === null || index >= (await this.getSlotCount(user))) {
			await this.removeBoostRow(boost);
			await repository.deleteExpiration(row);
			return;
		}
		const endsAt = premiumSlotsEndAt(user);
		if (guildEntitlementDay(endsAt) > row.day) {
			await repository.addExpiration({...row, day: guildEntitlementDay(endsAt)});
			await repository.deleteExpiration(row);
		}
	}

	// Writes the boost row of a slot that now points at the guild. Only the request whose slot CAS applied counts it; a
	// repeated or racing request rewrites the identical row (created_at is the slot's assigned_at), which also finishes
	// a request that died after its CAS. A count such a death missed is fixed by the daily recount (recountOncePerDay).
	private async recordBoost(
		boostId: bigint,
		assignedAt: Date | null,
		params: {user: User; guildId: GuildID; slotId: string; requestCache: RequestCache; counted: boolean},
	): Promise<GuildBoostResponse> {
		const {user, guildId} = params;
		const row: GuildBoostRow = {
			guild_id: guildId,
			boost_id: boostId,
			user_id: user.id,
			slot_id: params.slotId,
			created_at: assignedAt ?? new Date(0),
		};
		await this.deps.repository.putBoost(row);
		if (params.counted) {
			await this.deps.kvCounterService.add(GUILD_BOOST_COUNT_COUNTER, guildId.toString(), 1);
		}
		await this.deps.repository.addExpiration({
			day: guildEntitlementDay(premiumSlotsEndAt(user)),
			shard: guildEntitlementShard(guildId),
			guild_id: guildId,
			entitlement_id: boostId,
		});
		await this.markDirty(guildId);
		const [response] = await this.mapBoosts([row], params.requestCache);
		return response!;
	}

	private async removeBoostRow(ref: BoostRef): Promise<void> {
		const {repository} = this.deps;
		for (let attempt = 0; attempt < MAX_SLOT_CAS_ATTEMPTS; attempt++) {
			const slot = await repository.getSlot(ref.user_id, ref.slot_id);
			// The row goes last, so a removal that failed after freeing the slot is retried from the row and its recompute
			// is queued again.
			if (!slot || slot.guild_id !== ref.guild_id || slot.boost_id !== ref.boost_id) {
				// The slot no longer backs this boost, so whoever freed it already counted it down.
				await this.markDirty(ref.guild_id);
				await repository.deleteBoost(ref.guild_id, ref.boost_id);
				return;
			}
			if (await repository.freeSlot(slot)) {
				await this.deps.kvCounterService.add(GUILD_BOOST_COUNT_COUNTER, ref.guild_id.toString(), -1);
				await this.markDirty(ref.guild_id);
				await repository.deleteBoost(ref.guild_id, ref.boost_id);
				return;
			}
		}
		throw new ConflictError({code: APIErrorCodes.CONFLICT});
	}

	// Called under the guild update lock with the guild as it now stands; returns the guild after the release.
	private async releaseHeldVanity(guild: Guild): Promise<Guild | null> {
		if (guild.features.has(GuildFeatures.VANITY_URL) || guild.vanityUrlCode == null) {
			return null;
		}
		const {guildRepository, inviteRepository} = this.deps;
		return withGuildVanityLock(guild.id, async () => {
			const current = await guildRepository.findUnique(guild.id);
			if (!current || current.features.has(GuildFeatures.VANITY_URL) || current.vanityUrlCode == null) {
				return null;
			}
			return setGuildVanityCode({guildRepository, inviteRepository}, current, null);
		});
	}

	private async markDirty(guildId: GuildID): Promise<void> {
		await this.deps.kvClient.setex(recomputeDirtyKey(guildId), RECOMPUTE_DIRTY_TTL_SECONDS, randomUUID());
		await this.enqueueRecompute(guildId);
	}

	private async enqueueRecompute(guildId: GuildID): Promise<void> {
		const {kvClient} = this.deps;
		if (!(await kvClient.setnx(recomputeQueuedKey(guildId), '1', RECOMPUTE_QUEUED_TTL_SECONDS))) {
			return;
		}
		try {
			await this.deps.workerService.addJob(
				'recomputeGuildBoost',
				{guildId: guildId.toString()},
				{runAt: new Date(Date.now() + RECOMPUTE_DELAY_MS), skipLedger: true},
			);
		} catch (error) {
			await kvClient.del(recomputeQueuedKey(guildId));
			throw error;
		}
	}

	private async mapBoosts(rows: Array<GuildBoostRow>, requestCache: RequestCache): Promise<Array<GuildBoostResponse>> {
		const users = await this.deps.userCacheService.getUserPartialResponses(
			[...new Set(rows.map((row) => row.user_id))],
			requestCache,
		);
		const responses: Array<GuildBoostResponse> = [];
		for (const row of rows) {
			const user = users.get(row.user_id);
			if (!user) {
				Logger.warn({userId: row.user_id.toString()}, 'Skipped a guild boost whose user could not be loaded');
				continue;
			}
			responses.push({
				id: row.boost_id.toString(),
				guild_id: row.guild_id.toString(),
				user,
				created_at: row.created_at.toISOString(),
			});
		}
		return responses;
	}
}

// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {getContentMessage} from '@app/api/content_i18n/ContentI18n';
import type {CosmeticService} from '@app/api/cosmetics/CosmeticService';
import {type ReferralRewardRow, referralPendingMonth} from '@app/api/database/types/ReferralTypes';
import type {ISnowflakeService} from '@app/api/infrastructure/ISnowflakeService';
import type {
	InstanceConfigRepository,
	ReferralConfig,
	ReferralTierConfig,
} from '@app/api/instance/InstanceConfigRepository';
import {Logger} from '@app/api/Logger';
import type {User} from '@app/api/models/User';
import type {ReferralRepository} from '@app/api/referral/ReferralRepository';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import type {WorkerTaskName} from '@app/api/worker/WorkerLaneConfig';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ConflictError} from '@fluxer/errors/src/domains/core/ConflictError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {NotFoundError} from '@fluxer/errors/src/domains/core/NotFoundError';
import type {
	CreateReferralTierRequest,
	DeliverReferralRewardRequest,
	ReferralTierReward,
	UpdateReferralSettingsRequest,
	UpdateReferralTierRequest,
} from '@fluxer/schema/src/domains/referral/ReferralRequestSchemas';
import type {
	AdminReferralPendingRewardsResponse,
	AdminReferralResponse,
	AdminReferralRewardResponse,
	AdminReferralSettings,
	AdminUserReferralsResponse,
	ReferralTierResponse,
} from '@fluxer/schema/src/domains/referral/ReferralResponseSchemas';
import type {IEmailService} from '@pkgs/email/src/IEmailService';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';

export interface ReferralAdminServiceDeps {
	repository: ReferralRepository;
	instanceConfigRepository: InstanceConfigRepository;
	cosmeticService: CosmeticService;
	userRepository: UserRepository;
	workerService: IWorkerService<WorkerTaskName>;
	emailService: IEmailService;
	snowflakeService: ISnowflakeService;
}

const MAX_TIERS = 50;

function adminSettings(config: ReferralConfig): AdminReferralSettings {
	const {enabled, min_active_days, daily_valid_cap, ip_registration_limit} = config;
	return {enabled, min_active_days, daily_valid_cap, ip_registration_limit};
}

function tierResponse(tier: ReferralTierConfig): ReferralTierResponse {
	const {id, threshold, reward, enabled} = tier;
	return {id, threshold, reward, enabled};
}

function rewardOf(row: ReferralRewardRow): ReferralTierReward {
	return JSON.parse(row.reward) as ReferralTierReward;
}

function adminView(config: ReferralConfig): AdminReferralResponse {
	return {settings: adminSettings(config), tiers: config.tiers.map(tierResponse)};
}

// text staff type for the referrer never carries the off-site code, stored or just sent.
function refuseCode(field: string, text: string | null | undefined, codes: ReadonlyArray<string | null | undefined>) {
	const lower = text?.toLowerCase();
	if (lower && codes.some((code) => code && lower.includes(code.toLowerCase()))) {
		throw InputValidationError.create(field, 'The text must not contain the reward code');
	}
}

export class ReferralAdminService {
	constructor(readonly deps: ReferralAdminServiceDeps) {}

	async getAdminView(): Promise<AdminReferralResponse> {
		return adminView(await this.deps.instanceConfigRepository.readStoredReferralConfig());
	}

	async updateSettings(
		patch: UpdateReferralSettingsRequest,
	): Promise<{before: AdminReferralSettings; after: AdminReferralResponse}> {
		const next = Object.fromEntries(
			Object.entries(patch).filter(([, value]) => value !== undefined),
		) as Partial<ReferralConfig>;
		let before = null as ReferralConfig | null;
		const after = await this.deps.instanceConfigRepository.updateReferralConfig((current) => {
			before = current;
			return next;
		});
		return {before: adminSettings(before!), after: adminView(after)};
	}

	async createTier(request: CreateReferralTierRequest, adminUserId: UserID): Promise<ReferralTierResponse> {
		if (request.reward.type === 'cosmetic') {
			const item = await this.deps.cosmeticService.getItem(BigInt(request.reward.item_id));
			if (item?.availability !== 'owned') {
				throw InputValidationError.create('reward.item_id', 'Pick an owned-availability cosmetic item');
			}
		}
		const tier: ReferralTierConfig = {
			id: (await this.deps.snowflakeService.generate()).toString(),
			threshold: request.threshold,
			reward: request.reward,
			enabled: request.enabled,
			created_at: new Date().toISOString(),
		};
		await this.deps.instanceConfigRepository.updateReferralConfig((current) => {
			if (current.tiers.length >= MAX_TIERS) {
				throw InputValidationError.create('threshold', `At most ${MAX_TIERS} tiers; reuse a disabled one`);
			}
			return {tiers: [...current.tiers, tier]};
		});
		if (tier.enabled) await this.enqueueBackfill(tier.id, adminUserId);
		return tierResponse(tier);
	}

	// The reward never changes. Lowering the threshold or turning the tier on grants it to referrers now at
	// it; raising it or turning it off takes nothing back.
	async updateTier(
		tierId: bigint,
		patch: UpdateReferralTierRequest,
		adminUserId: UserID,
	): Promise<{before: ReferralTierResponse; after: ReferralTierResponse}> {
		const id = tierId.toString();
		let before = null as ReferralTierConfig | null;
		const config = await this.deps.instanceConfigRepository.updateReferralConfig((current) => {
			before = current.tiers.find((tier) => tier.id === id) ?? null;
			if (!before) throw new NotFoundError({code: APIErrorCodes.NOT_FOUND});
			const updated = {
				...before,
				threshold: patch.threshold ?? before.threshold,
				enabled: patch.enabled ?? before.enabled,
			};
			return {tiers: current.tiers.map((tier) => (tier.id === id ? updated : tier))};
		});
		const old = before!;
		const after = config.tiers.find((tier) => tier.id === id)!;
		if (after.enabled && (!old.enabled || after.threshold < old.threshold)) {
			await this.enqueueBackfill(id, adminUserId);
		}
		return {before: tierResponse(old), after: tierResponse(after)};
	}

	private async enqueueBackfill(tierId: string, adminUserId: UserID): Promise<void> {
		await this.deps.workerService.addJob('backfillReferralTier', {
			tier_id: tierId,
			admin_user_id: adminUserId.toString(),
		});
	}

	async listPendingRewards(
		month: string,
		cursor: string | null,
		limit: number,
	): Promise<AdminReferralPendingRewardsResponse> {
		const [page, config] = await Promise.all([
			this.deps.repository.listPendingRewards(month, cursor, limit),
			this.deps.instanceConfigRepository.readStoredReferralConfig(),
		]);
		// A tier's reward never changes, so the tier list answers it; the frozen row only when a stored
		// tier was lost.
		const rewards = new Map(config.tiers.map((tier) => [tier.id, tier.reward]));
		const items = await Promise.all(
			page.items.map(async (row) => ({
				user_id: row.user_id.toString(),
				tier_id: row.tier_id.toString(),
				reward: rewards.get(row.tier_id.toString()) ?? rewardOf(await this.requireReward(row.user_id, row.tier_id)),
				created_at: row.created_at.toISOString(),
			})),
		);
		return {month, items, next_cursor: page.nextCursor};
	}

	// Counts are the flushed referral_stats base, at most one counter flush behind. Never an IP or an off-site code.
	async getUserReferrals(userId: UserID, cursor: string | null, limit: number): Promise<AdminUserReferralsResponse> {
		const {repository} = this.deps;
		const [own, stats, rewards, page] = await Promise.all([
			repository.getUserReferral(userId),
			repository.getStats(userId),
			repository.getRewards(userId),
			repository.listReferrals(userId, cursor, limit),
		]);
		return {
			user_id: userId.toString(),
			code: own?.code ?? null,
			referrer_id: own?.referrer_id?.toString() ?? null,
			counts: {
				pending: Number(stats?.pending_count ?? 0n),
				valid: Number(stats?.valid_count ?? 0n),
				rejected: Number(stats?.rejected_count ?? 0n),
			},
			rewards: rewards.map((row) => ({
				tier_id: row.tier_id.toString(),
				reward: rewardOf(row),
				status: row.status,
				granted_at: row.granted_at.toISOString(),
				delivered_at: row.delivered_at?.toISOString() ?? null,
				delivered_by: row.delivered_by?.toString() ?? null,
				note: row.note ?? null,
				has_code: row.code != null,
			})),
			referees: page.items.map((row) => ({
				referee_id: row.referee_id.toString(),
				state: row.state,
				reason: row.reason ?? null,
				referred_at: row.referred_at.toISOString(),
			})),
			next_cursor: page.nextCursor,
		};
	}

	// pending_admin → delivered once (LWT); the code goes only into the reward row. With a code the referrer gets a
	// system DM and an email, neither carrying it.
	async deliver(
		userId: UserID,
		tierId: bigint,
		request: DeliverReferralRewardRequest,
		adminUserId: UserID,
	): Promise<AdminReferralRewardResponse> {
		const reward = await this.requireReward(userId, tierId);
		const deliveredAt = new Date();
		const code = request.code ?? null;
		refuseCode('note', request.note, [code, reward.code]);
		const delivered =
			reward.status === 'pending_admin' &&
			(await this.deps.repository.setRewardStatus(userId, tierId, 'pending_admin', {
				status: 'delivered',
				delivered_at: deliveredAt,
				delivered_by: adminUserId,
				code,
				note: request.note ?? null,
			}));
		if (!delivered)
			throw new ConflictError({code: APIErrorCodes.CONFLICT, message: 'The reward is not waiting for delivery'});
		await this.deps.repository.deletePendingReward({
			month: referralPendingMonth(reward.granted_at),
			created_at: reward.granted_at,
			user_id: userId,
			tier_id: tierId,
		});
		if (code !== null) await this.tellRewardReady(userId);
		return {
			user_id: userId.toString(),
			tier_id: tierId.toString(),
			status: 'delivered',
			delivered_at: deliveredAt.toISOString(),
			has_code: code !== null,
		};
	}

	// A system DM about an off-site reward; its status stays. Text carrying the stored code is refused.
	async notify(userId: UserID, tierId: bigint, content: string): Promise<void> {
		const reward = await this.requireReward(userId, tierId);
		if (reward.status !== 'pending_admin' && reward.status !== 'delivered') {
			throw new ConflictError({code: APIErrorCodes.CONFLICT, message: 'Only an off-site reward takes a message'});
		}
		refuseCode('content', content, [reward.code]);
		await this.sendSystemDm(userId, content);
	}

	private async requireReward(userId: UserID, tierId: bigint): Promise<ReferralRewardRow> {
		const reward = (await this.deps.repository.getRewards(userId)).find((row) => row.tier_id === tierId);
		if (!reward) throw new NotFoundError({code: APIErrorCodes.NOT_FOUND});
		return reward;
	}

	private sendSystemDm(userId: UserID, content: string) {
		return this.deps.workerService.addJob(
			'sendSystemDm',
			{content, user_ids: [userId.toString()]},
			{requireLedger: true},
		);
	}

	// The delivery is already stored: a failed notice is logged, never thrown, so the admin does not retry into a 409.
	// The DM is Fluxer's content message in the referrer's locale; the code itself is only in their settings.
	private async tellRewardReady(userId: UserID): Promise<void> {
		let user: User | null = null;
		try {
			user = await this.deps.userRepository.findUnique(userId);
			await this.sendSystemDm(userId, getContentMessage('referral.reward_ready', user?.locale));
		} catch (error) {
			Logger.error({error, userId: userId.toString()}, 'Failed to queue the referral reward DM');
		}
		try {
			if (user?.email)
				await this.deps.emailService.sendReferralRewardReadyEmail(user.email, user.username, user.locale);
		} catch (error) {
			Logger.error({error, userId: userId.toString()}, 'Failed to send the referral reward email');
		}
	}
}

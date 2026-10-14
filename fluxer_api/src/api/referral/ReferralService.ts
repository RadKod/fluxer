// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomInt} from 'node:crypto';
import type {UserID} from '@app/api/BrandedTypes';
import {
	REFERRAL_DECISION_WINDOW_DAYS,
	REFERRAL_PENDING_COUNTER,
	REFERRAL_REJECTED_COUNTER,
	REFERRAL_VALID_COUNTER,
} from '@app/api/database/types/ReferralTypes';
import type {KVCounterService} from '@app/api/infrastructure/KVCounterService';
import type {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {Logger} from '@app/api/Logger';
import type {ReferralRepository} from '@app/api/referral/ReferralRepository';
import {MS_PER_DAY, SECONDS_PER_DAY} from '@fluxer/date_utils/src/DateConstants';
import {
	isReferralCodeShape,
	REFERRAL_CODE_ALPHABET,
	REFERRAL_CODE_LENGTH,
} from '@fluxer/schema/src/domains/referral/ReferralCode';
import type {ReferralTierReward} from '@fluxer/schema/src/domains/referral/ReferralRequestSchemas';
import type {ReferralMeResponse} from '@fluxer/schema/src/domains/referral/ReferralResponseSchemas';

export interface ReferralServiceDeps {
	repository: ReferralRepository;
	instanceConfigRepository: InstanceConfigRepository;
	kvCounterService: KVCounterService;
}

export interface ReferralRegistration {
	refereeId: UserID;
	code: string | null | undefined;
	ip: string;
	riskBlocked: boolean;
	now: Date;
}

// 50 bits, so guessing a live code is hopeless and a clash is rare.
const CODE_ATTEMPTS = 5;

function generateCode(): string {
	let code = '';
	for (let i = 0; i < REFERRAL_CODE_LENGTH; i++)
		code += REFERRAL_CODE_ALPHABET[randomInt(REFERRAL_CODE_ALPHABET.length)];
	return code;
}

export class ReferralService {
	constructor(readonly deps: ReferralServiceDeps) {}

	isValidCodeShape(code: string): boolean {
		return isReferralCodeShape(code);
	}

	/** The own referral view; while the programme is open the first read creates the code (closed: no code, none made). */
	async getMe(userId: UserID): Promise<ReferralMeResponse> {
		const {repository, instanceConfigRepository, kvCounterService} = this.deps;
		const id = userId.toString();
		const [config, mapping, rewards, valid, pending, rejected] = await Promise.all([
			instanceConfigRepository.getReferralConfig(),
			repository.getUserReferral(userId),
			repository.getRewards(userId),
			kvCounterService.get(REFERRAL_VALID_COUNTER, id),
			kvCounterService.get(REFERRAL_PENDING_COUNTER, id),
			kvCounterService.get(REFERRAL_REJECTED_COUNTER, id),
		]);
		const code = config.enabled ? (mapping?.code ?? (await this.createCode(userId))) : null;
		return {
			enabled: config.enabled,
			code,
			counts: {valid: Math.max(0, valid), pending: Math.max(0, pending), rejected: Math.max(0, rejected)},
			min_active_days: config.min_active_days,
			tiers: config.tiers
				.filter((tier) => tier.enabled)
				.sort((a, b) => a.threshold - b.threshold)
				.map((tier) => ({id: tier.id, threshold: tier.threshold, reward: tier.reward})),
			rewards: rewards.map((reward) => ({
				tier_id: reward.tier_id.toString(),
				reward: JSON.parse(reward.reward) as ReferralTierReward,
				status: reward.status,
				granted_at: reward.granted_at.toISOString(),
				delivered_at: reward.delivered_at?.toISOString() ?? null,
				// the off-site code staff typed in, to its owner only.
				code: reward.status === 'delivered' ? (reward.code ?? null) : null,
			})),
		};
	}

	private async createCode(userId: UserID): Promise<string> {
		const {repository} = this.deps;
		for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
			const code = generateCode();
			if (!(await repository.insertCodeIfAbsent(code, userId, new Date()))) continue;
			if (await repository.setOwnCode(userId, code)) return code;
			// A racing first read set its code first.
			const current = (await repository.getUserReferral(userId))?.code;
			if (current) return current;
		}
		throw new Error('No free referral code after 5 attempts');
	}

	/**
	 * Links a new account to the owner of `code` (never throws, so it never fails a registration). An unknown,
	 * malformed or own code, or a closed programme, writes nothing.
	 */
	async attachAtRegistration({refereeId, code, ip, riskBlocked, now}: ReferralRegistration): Promise<void> {
		try {
			const normalized = code?.trim().toLowerCase();
			if (!normalized || !this.isValidCodeShape(normalized)) return;
			const {repository, instanceConfigRepository, kvCounterService} = this.deps;
			const config = await instanceConfigRepository.getReferralConfig();
			if (!config.enabled) return;
			const referrerId = await repository.getCodeOwner(normalized);
			if (referrerId === null || referrerId === refereeId) return;
			const dueAt = new Date(now.getTime() + config.min_active_days * MS_PER_DAY);
			// The check row outlives its due time by the decision window.
			await repository.recordReferral(
				{refereeId, referrerId, referredAt: now, regIp: ip, riskBlocked},
				{dueAt, ttlSeconds: (config.min_active_days + REFERRAL_DECISION_WINDOW_DAYS) * SECONDS_PER_DAY},
			);
			await kvCounterService.add(REFERRAL_PENDING_COUNTER, referrerId.toString(), 1);
		} catch (error) {
			Logger.warn({userId: refereeId.toString(), error}, '[ReferralService] Failed to record the referral');
		}
	}
}

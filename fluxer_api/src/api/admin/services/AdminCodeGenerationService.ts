// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {SYSTEM_USER_ID} from '@app/api/constants/Core';
import type {GiftCodeDurationType, GiftCodeRow} from '@app/api/database/types/PaymentTypes';
import {generateUniqueGiftCode, mapGiftCodeDurationToMonths} from '@app/api/models/GiftCode';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';

const MAX_CODES_PER_REQUEST = 100;
const DURATION_TYPES = new Set<GiftCodeDurationType>(['days', 'weeks', 'months', 'years']);

interface GenerateGiftCodesOptions {
	count: number;
	durationType: GiftCodeDurationType;
	durationQuantity: number;
	createdByUserId?: UserID;
}

export class AdminCodeGenerationService {
	constructor(private readonly userRepository: UserRepository) {}

	async generateGiftCodes(options: GenerateGiftCodesOptions): Promise<Array<string>> {
		const {count, durationType, durationQuantity} = this.validateOptions(options);
		return this.createCodes(count, {
			duration_months: mapGiftCodeDurationToMonths(durationType, durationQuantity),
			duration_type: durationType,
			duration_quantity: durationQuantity,
			cosmetic_item_id: null,
		});
	}

	// Item codes (shop, 3.4): each gives the item instead of premium time, so the rows carry no duration.
	async generateCosmeticGiftCodes(options: {count: number; itemId: bigint}): Promise<Array<string>> {
		this.validateCount(options.count);
		return this.createCodes(options.count, {
			duration_months: null,
			duration_type: null,
			duration_quantity: null,
			cosmetic_item_id: options.itemId,
		});
	}

	private async createCodes(
		count: number,
		grant: Pick<GiftCodeRow, 'duration_months' | 'duration_type' | 'duration_quantity' | 'cosmetic_item_id'>,
	): Promise<Array<string>> {
		const codes: Array<string> = [];
		for (let i = 0; i < count; i += 1) {
			const code = await generateUniqueGiftCode((candidate) => this.userRepository.findGiftCode(candidate));
			const giftCodeRow: GiftCodeRow = {
				code,
				...grant,
				created_at: new Date(),
				// TEMPORARY: every admin code (premium and item) has the system user as creator, and
				// GiftCodeRepository leaves those out of gift_codes_by_creator so no single partition grows; admin codes are
				// then found only by the code itself (no batch listing or batch revoke). Trigger: 500 000 admin codes
				// issued, or a leaked batch to revoke. Path: a batch index keyed by batch id and time bucket
				// (e.g. gift_codes_by_batch ((batch_id, bucket), code)), written here; additive migration.
				created_by_user_id: SYSTEM_USER_ID,
				redeemed_at: null,
				redeemed_by_user_id: null,
				stripe_payment_intent_id: null,
				visionary_sequence_number: null,
				checkout_session_id: null,
				version: 1,
			};
			await this.userRepository.createGiftCode(giftCodeRow);
			codes.push(code);
		}
		return codes;
	}

	private validateCount(count: number): void {
		if (!Number.isInteger(count) || count < 1 || count > MAX_CODES_PER_REQUEST) {
			throw new Error(`Gift code count must be between 1 and ${MAX_CODES_PER_REQUEST}`);
		}
	}

	private validateOptions(options: GenerateGiftCodesOptions): GenerateGiftCodesOptions {
		this.validateCount(options.count);
		if (!DURATION_TYPES.has(options.durationType)) {
			throw new Error(`Unsupported gift code duration type: ${options.durationType}`);
		}
		if (!Number.isInteger(options.durationQuantity) || options.durationQuantity < 1) {
			throw new Error('Gift code duration quantity must be a positive integer');
		}
		return options;
	}
}

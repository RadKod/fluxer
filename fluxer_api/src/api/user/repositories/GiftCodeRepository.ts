// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {SYSTEM_USER_ID} from '@app/api/constants/Core';
import {
	BatchBuilder,
	deleteOneOrMany,
	executeConditional,
	fetchMany,
	fetchOne,
	upsertOne,
} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import type {GiftCodeRow} from '@app/api/database/types/PaymentTypes';
import {GiftCode, mapGiftCodeDurationToMonths, mapGiftDurationMonthsToFields} from '@app/api/models/GiftCode';
import {GiftCodes, GiftCodesByCreator, GiftCodesByPaymentIntent, GiftCodesByRedeemer} from '@app/api/Tables';
import {GiftCodeAlreadyRedeemedError} from '@fluxer/errors/src/domains/payment/GiftCodeAlreadyRedeemedError';
import {UnknownGiftCodeError} from '@fluxer/errors/src/domains/payment/UnknownGiftCodeError';

const MAX_REVOKE_ATTEMPTS = 3;

const FETCH_GIFT_CODES_BY_CREATOR_QUERY = GiftCodesByCreator.selectCql({
	where: GiftCodesByCreator.where.eq('created_by_user_id'),
});
const FETCH_GIFT_CODES_BY_REDEEMER_QUERY = GiftCodesByRedeemer.selectCql({
	where: GiftCodesByRedeemer.where.eq('redeemed_by_user_id'),
});
const FETCH_GIFT_CODE_BY_PAYMENT_INTENT_QUERY = GiftCodesByPaymentIntent.selectCql({
	columns: ['code'],
	where: GiftCodesByPaymentIntent.where.eq('stripe_payment_intent_id'),
	limit: 1,
});
const FETCH_GIFT_CODE_QUERY = GiftCodes.selectCql({
	where: GiftCodes.where.eq('code'),
	limit: 1,
});

function normaliseGiftCodeRowForWrite(data: GiftCodeRow): GiftCodeRow {
	// An item code carries no premium time, so no duration is written that a reader could take for one.
	if (data.cosmetic_item_id != null) {
		return {
			...data,
			duration_type: null,
			duration_quantity: null,
			duration_months: null,
			revoked_at: data.revoked_at ?? null,
			premium_reversed_seconds: data.premium_reversed_seconds ?? null,
		};
	}
	let durationType = data.duration_type ?? null;
	let durationQuantity = data.duration_quantity ?? null;
	let durationMonths = data.duration_months ?? null;
	if (durationType === null || durationQuantity === null) {
		if (durationType !== null || durationQuantity !== null) {
			throw new Error('Gift code duration_type and duration_quantity must both be set when either is present');
		}
		if (durationMonths === null) {
			throw new Error('Gift code duration is missing from both duration_type/duration_quantity and duration_months');
		}
		const derivedDuration = mapGiftDurationMonthsToFields(durationMonths);
		durationType = derivedDuration.durationType;
		durationQuantity = derivedDuration.durationQuantity;
	}
	const normalisedDurationMonths = mapGiftCodeDurationToMonths(durationType, durationQuantity);
	if (normalisedDurationMonths !== null) {
		durationMonths = normalisedDurationMonths;
	}
	return {
		...data,
		duration_type: durationType,
		duration_quantity: durationQuantity,
		duration_months: durationMonths,
		revoked_at: data.revoked_at ?? null,
		cosmetic_item_id: data.cosmetic_item_id ?? null,
		premium_reversed_seconds: data.premium_reversed_seconds ?? null,
	};
}

export class GiftCodeRepository {
	async createGiftCode(data: GiftCodeRow): Promise<void> {
		const normalisedData = normaliseGiftCodeRowForWrite(data);
		await upsertOne(GiftCodes.insert(normalisedData));
		const batch = new BatchBuilder();
		// Micup: admin-issued keys are all created by the system user, so indexing them would pile every sold key into
		// one partition. The index only serves a user listing, or exporting, the gifts they bought themselves.
		if (normalisedData.created_by_user_id !== SYSTEM_USER_ID) {
			batch.addPrepared(
				GiftCodesByCreator.upsertAll({
					created_by_user_id: normalisedData.created_by_user_id,
					code: normalisedData.code,
				}),
			);
		}
		if (normalisedData.stripe_payment_intent_id) {
			batch.addPrepared(
				GiftCodesByPaymentIntent.upsertAll({
					stripe_payment_intent_id: normalisedData.stripe_payment_intent_id,
					code: normalisedData.code,
				}),
			);
		}
		if (normalisedData.redeemed_by_user_id) {
			batch.addPrepared(
				GiftCodesByRedeemer.upsertAll({
					redeemed_by_user_id: normalisedData.redeemed_by_user_id,
					code: normalisedData.code,
				}),
			);
		}
		await batch.execute();
	}

	async findGiftCode(code: string): Promise<GiftCode | null> {
		const row = await fetchOne<GiftCodeRow>(FETCH_GIFT_CODE_QUERY, {code});
		if (!row) {
			return null;
		}
		return new GiftCode(row);
	}

	async findGiftCodeByPaymentIntent(paymentIntentId: string): Promise<GiftCode | null> {
		const row = await fetchOne<{
			code: string;
		}>(FETCH_GIFT_CODE_BY_PAYMENT_INTENT_QUERY, {
			stripe_payment_intent_id: paymentIntentId,
		});
		if (!row) {
			return null;
		}
		return this.findGiftCode(row.code);
	}

	async findGiftCodesByCreator(userId: UserID): Promise<Array<GiftCode>> {
		const codes = await fetchMany<{
			code: string;
		}>(FETCH_GIFT_CODES_BY_CREATOR_QUERY, {
			created_by_user_id: userId,
		});
		if (codes.length === 0) {
			return [];
		}
		const gifts: Array<GiftCode> = [];
		for (const {code} of codes) {
			const gift = await this.findGiftCode(code);
			if (gift) {
				gifts.push(gift);
			}
		}
		return gifts;
	}

	async findGiftCodesByRedeemer(userId: UserID): Promise<Array<GiftCode>> {
		const codes = await fetchMany<{
			code: string;
		}>(FETCH_GIFT_CODES_BY_REDEEMER_QUERY, {
			redeemed_by_user_id: userId,
		});
		if (codes.length === 0) {
			return [];
		}
		const gifts: Array<GiftCode> = [];
		for (const {code} of codes) {
			const gift = await this.findGiftCode(code);
			if (gift) {
				gifts.push(gift);
			}
		}
		return gifts;
	}

	// Redemption is a version compare-and-set, so one code can never go to two users even when the
	// KV lock and sentinels in front of it are lost. Every code is created with version 1; a row
	// without a version is refused by the conditional write rather than redeemed unguarded.
	async redeemGiftCode(code: string, userId: UserID): Promise<void> {
		const row = await fetchOne<GiftCodeRow>(FETCH_GIFT_CODE_QUERY, {code});
		if (row?.revoked_at != null) {
			throw new UnknownGiftCodeError();
		}
		const applied =
			row !== null &&
			row.redeemed_by_user_id == null &&
			(await executeConditional(
				GiftCodes.conditionalPatchByPk(
					{code},
					{
						redeemed_by_user_id: Db.set(userId),
						redeemed_at: Db.set(new Date()),
						version: Db.set(row.version + 1),
					},
					{version: row.version},
				),
			));
		if (!applied) {
			throw new GiftCodeAlreadyRedeemedError();
		}
		await upsertOne(
			GiftCodesByRedeemer.upsertAll({
				redeemed_by_user_id: userId,
				code,
			}),
		);
	}

	async unredeemGiftCode(code: string, userId: UserID): Promise<void> {
		const row = await fetchOne<GiftCodeRow>(FETCH_GIFT_CODE_QUERY, {code});
		if (row === null || row.redeemed_by_user_id !== userId) {
			return;
		}
		const applied = await executeConditional(
			GiftCodes.conditionalPatchByPk(
				{code},
				{
					redeemed_by_user_id: Db.set(null),
					redeemed_at: Db.set(null),
					version: Db.set(row.version + 1),
				},
				{version: row.version},
			),
		);
		if (applied) {
			await deleteOneOrMany(GiftCodesByRedeemer.deleteByPk({redeemed_by_user_id: userId, code}));
		}
	}

	// Revocation takes the same version compare-and-set as redemption, so a code is never both redeemed and
	// revoked: whichever write lands first wins. An already revoked code is left as it is.
	async revokeGiftCode(code: string): Promise<void> {
		for (let attempt = 0; attempt < MAX_REVOKE_ATTEMPTS; attempt++) {
			const row = await fetchOne<GiftCodeRow>(FETCH_GIFT_CODE_QUERY, {code});
			if (row === null) {
				throw new UnknownGiftCodeError();
			}
			if (row.revoked_at != null) {
				return;
			}
			if (row.redeemed_by_user_id != null) {
				throw new GiftCodeAlreadyRedeemedError();
			}
			const applied = await executeConditional(
				GiftCodes.conditionalPatchByPk(
					{code},
					{revoked_at: Db.set(new Date()), version: Db.set(row.version + 1)},
					{version: row.version},
				),
			);
			if (applied) {
				return;
			}
		}
		throw new Error('Gift code revocation lost too many concurrent updates');
	}

	async unrevokeGiftCode(code: string): Promise<void> {
		await upsertOne(GiftCodes.patchByPk({code}, {revoked_at: Db.set(null)}));
	}

	async revokeGiftCodeForStoreRefund(code: string, purchaserId: UserID, redeemerId: UserID | null): Promise<void> {
		for (let attempt = 0; attempt < MAX_REVOKE_ATTEMPTS; attempt++) {
			const row = await fetchOne<GiftCodeRow>(FETCH_GIFT_CODE_QUERY, {code});
			if (
				row === null ||
				row.created_by_user_id !== purchaserId ||
				row.redeemed_by_user_id !== redeemerId ||
				row.stripe_payment_intent_id != null
			) {
				throw new UnknownGiftCodeError();
			}
			if (row.revoked_at != null) {
				return;
			}
			if (
				await executeConditional(
					GiftCodes.conditionalPatchByPk(
						{code},
						{revoked_at: Db.set(new Date()), version: Db.set(row.version + 1)},
						{version: row.version, created_by_user_id: purchaserId, redeemed_by_user_id: redeemerId},
					),
				)
			) {
				return;
			}
		}
		throw new Error('Store gift refund revocation lost too many concurrent updates');
	}

	async markGiftPremiumReversed(gift: GiftCode, seconds: number): Promise<boolean> {
		return executeConditional(
			GiftCodes.conditionalPatchByPk(
				{code: gift.code},
				{premium_reversed_seconds: Db.set(seconds)},
				{created_by_user_id: gift.createdByUserId, premium_reversed_seconds: null},
			),
		);
	}

	async clearGiftPremiumReversed(code: string, seconds: number): Promise<boolean> {
		return executeConditional(
			GiftCodes.conditionalPatchByPk(
				{code},
				{premium_reversed_seconds: Db.set(null)},
				{premium_reversed_seconds: seconds},
			),
		);
	}

	async linkGiftCodeToCheckoutSession(code: string, checkoutSessionId: string): Promise<void> {
		await upsertOne(
			GiftCodes.patchByPk(
				{code},
				{
					checkout_session_id: Db.set(checkoutSessionId),
				},
			),
		);
	}
}

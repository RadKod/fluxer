// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';

type Nullish<T> = T | null;
export type GiftCodeDurationType = 'days' | 'weeks' | 'months' | 'years';

export interface GiftCodeRow {
	code: string;
	duration_months: Nullish<number>;
	duration_type?: Nullish<GiftCodeDurationType>;
	duration_quantity?: Nullish<number>;
	created_at: Date;
	created_by_user_id: UserID;
	redeemed_at: Nullish<Date>;
	redeemed_by_user_id: Nullish<UserID>;
	stripe_payment_intent_id: Nullish<string>;
	visionary_sequence_number: Nullish<number>;
	checkout_session_id: Nullish<string>;
	revoked_at?: Nullish<Date>;
	// Micup item codes (shop, 3.4): the cosmetic the code gives instead of premium time. Optional on purpose: the one
	// writer, GiftCodeRepository.createGiftCode, normalises it to null.
	cosmetic_item_id?: Nullish<bigint>;
	premium_reversed_seconds?: Nullish<number>;
	version: number;
}

export interface PaymentRow {
	checkout_session_id: string;
	user_id: UserID;
	stripe_customer_id: Nullish<string>;
	payment_intent_id: Nullish<string>;
	subscription_id: Nullish<string>;
	invoice_id: Nullish<string>;
	price_id: Nullish<string>;
	product_type: Nullish<string>;
	amount_cents: number;
	currency: string;
	status: string;
	is_gift: boolean;
	gift_code: Nullish<string>;
	purchase_geoip_country_code: Nullish<string>;
	purchase_client_country_code: Nullish<string>;
	eu_withdrawal_waiver_required: boolean;
	eu_withdrawal_waiver_accepted: boolean;
	eu_withdrawal_waiver_accepted_at: Nullish<Date>;
	eu_withdrawal_waiver_text_version: Nullish<string>;
	created_at: Date;
	completed_at: Nullish<Date>;
	version: number;
}

export interface PaymentBySubscriptionRow {
	subscription_id: string;
	checkout_session_id: string;
	user_id: UserID;
	price_id: string;
	product_type: string;
}

export interface VisionarySlotRow {
	slot_index: number;
	user_id: UserID | null;
	// Micup Visionary sale. Optional so upstream's partial writes stay valid.
	version?: Nullish<number>; // CAS counter; rows sanalyer opens start at 1, rows without one are never handed out
	order_id?: Nullish<bigint>; // the order holding the number, kept after it is taken (retry proof)
	held_until?: Nullish<Date>; // no owner: end of a pending order's hold; an owner: when an admin took the number back
}

export const PAYMENT_COLUMNS = [
	'checkout_session_id',
	'user_id',
	'stripe_customer_id',
	'payment_intent_id',
	'subscription_id',
	'invoice_id',
	'price_id',
	'product_type',
	'amount_cents',
	'currency',
	'status',
	'is_gift',
	'gift_code',
	'purchase_geoip_country_code',
	'purchase_client_country_code',
	'eu_withdrawal_waiver_required',
	'eu_withdrawal_waiver_accepted',
	'eu_withdrawal_waiver_accepted_at',
	'eu_withdrawal_waiver_text_version',
	'created_at',
	'completed_at',
	'version',
] as const;
export const PAYMENT_BY_SUBSCRIPTION_COLUMNS = [
	'subscription_id',
	'checkout_session_id',
	'user_id',
	'price_id',
	'product_type',
] as const;
export const PAYMENT_BY_PAYMENT_INTENT_COLUMNS = ['payment_intent_id', 'checkout_session_id'] as const;
export const PAYMENT_BY_USER_COLUMNS = ['user_id', 'created_at', 'checkout_session_id'] as const;
export const GIFT_CODE_COLUMNS = [
	'code',
	'duration_months',
	'duration_type',
	'duration_quantity',
	'created_at',
	'created_by_user_id',
	'redeemed_at',
	'redeemed_by_user_id',
	'stripe_payment_intent_id',
	'visionary_sequence_number',
	'checkout_session_id',
	'revoked_at',
	'cosmetic_item_id',
	'premium_reversed_seconds',
	'version',
] as const;
export const GIFT_CODE_BY_CREATOR_COLUMNS = ['created_by_user_id', 'code'] as const;
export const GIFT_CODE_BY_PAYMENT_INTENT_COLUMNS = ['stripe_payment_intent_id', 'code'] as const;
export const GIFT_CODE_BY_REDEEMER_COLUMNS = ['redeemed_by_user_id', 'code'] as const;
export const VISIONARY_SLOT_COLUMNS = ['slot_index', 'user_id', 'version', 'order_id', 'held_until'] as const;

export interface PaymentByPaymentIntentRow {
	payment_intent_id: string;
	checkout_session_id: string;
}

export interface PaymentByUserRow {
	user_id: UserID;
	created_at: Date;
	checkout_session_id: string;
}

export interface GiftCodeByCreatorRow {
	created_by_user_id: UserID;
	code: string;
}

export interface GiftCodeByPaymentIntentRow {
	stripe_payment_intent_id: string;
	code: string;
}

export interface GiftCodeByRedeemerRow {
	redeemed_by_user_id: UserID;
	code: string;
}

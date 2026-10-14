// SPDX-License-Identifier: AGPL-3.0-or-later

import {GenericErrorModal} from '@app/features/app/components/alerts/GenericErrorModal';
import {Endpoints} from '@app/features/app/constants/Endpoints';
import InstanceSnapshotStore from '@app/features/app/state/InstanceSnapshotStore';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import Cosmetics from '@app/features/cosmetics/state/Cosmetics';
import DeveloperOptions from '@app/features/devtools/state/DeveloperOptions';
import {GiftAcceptModal} from '@app/features/expressions/components/modals/GiftAcceptModal';
import {GiftSendToFriendModal} from '@app/features/expressions/components/modals/GiftSendToFriendModal';
import Gifts from '@app/features/gift/state/Gifts';
import {
	FAILED_TO_REDEEM_GIFT_DESCRIPTOR,
	GIFT_ALREADY_REDEEMED_TITLE_DESCRIPTOR,
	GIFT_NOT_FOUND_TITLE_DESCRIPTOR,
} from '@app/features/gift/utils/GiftMessageDescriptors';
import {extractGiftCode} from '@app/features/gift/utils/GiftUtils';
import {
	currentInstanceTarget,
	type InstanceHTTPTarget,
	instanceRequest,
} from '@app/features/platform/transport/InstanceHTTP';
import {http} from '@app/features/platform/transport/RestTransport';
import {HttpError} from '@app/features/platform/types/EndpointError';
import {Logger} from '@app/features/platform/utils/AppLogger';
import ShopCatalog from '@app/features/shop/state/ShopCatalog';
import {
	ALREADY_OWNED_CODE_KEPT_DESCRIPTOR,
	ALREADY_OWNED_DESCRIPTOR,
} from '@app/features/shop/utils/ShopMessageDescriptors';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import * as UserProfileCommands from '@app/features/user/commands/UserProfileCommands';
import Users from '@app/features/user/state/Users';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {MS_PER_DAY} from '@fluxer/date_utils/src/DateConstants';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {ShopCodeResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import type {UserPartial} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import type {I18n} from '@lingui/core';
import {msg} from '@lingui/core/macro';

const GIFT_REDEEMED_SUCCESSFULLY_DESCRIPTOR = msg({
	message: 'Gift redeemed!',
	comment: 'Success toast after a gift code is successfully redeemed.',
});
const INVALID_GIFT_CODE_DESCRIPTOR = msg({
	comment: 'Gift redemption error modal title for an invalid or already used code.',
	message: 'Invalid gift code',
});
const THIS_GIFT_CODE_IS_INVALID_OR_HAS_ALREADY_BEEN_REDEEMED_DESCRIPTOR = msg({
	comment: 'Gift redemption error modal body for an invalid or already used code.',
	message: 'This code is invalid or already used.',
});
const THIS_GIFT_CODE_HAS_ALREADY_BEEN_REDEEMED_DESCRIPTOR = msg({
	comment: 'Gift redemption error modal body for a code that was already redeemed.',
	message: 'This code was already redeemed.',
});
const THIS_GIFT_CODE_COULD_NOT_BE_FOUND_DESCRIPTOR = msg({
	comment: 'Gift redemption error modal body for a code that does not exist.',
	message: "This code doesn't exist.",
});
const WE_COULDN_T_REDEEM_THIS_GIFT_CODE_PLEASE_TRY_AGAIN_DESCRIPTOR = msg({
	comment: 'Generic gift redemption error modal body. Keep calm and concise.',
	message: "Couldn't redeem this gift. Try again.",
});

interface ApiErrorResponse {
	code?: string;
	message?: string;
	errors?: Record<string, unknown>;
}

const logger = new Logger('Gifts');
const MOCK_USER_PARTIAL: UserPartial = {
	id: '000000000000000000',
	username: 'MockUser',
	discriminator: '0000',
	global_name: null,
	avatar: null,
	avatar_color: null,
	flags: 0,
};

export type GiftDurationType = 'days' | 'weeks' | 'months' | 'years';

function mapLegacyDurationMonthsToFields(durationMonths: number): {
	duration_type: GiftDurationType;
	duration_quantity: number;
} {
	if (durationMonths !== 0 && durationMonths % 12 === 0) {
		return {
			duration_type: 'years',
			duration_quantity: durationMonths / 12,
		};
	}
	return {
		duration_type: 'months',
		duration_quantity: durationMonths,
	};
}

function currentUserPartial(): UserPartial {
	const currentUser = Users.getCurrentUser();
	return currentUser
		? {
				id: currentUser.id,
				username: currentUser.username,
				discriminator: currentUser.discriminator,
				global_name: currentUser.globalName,
				avatar: currentUser.avatar,
				avatar_color: currentUser.avatarColor ?? null,
				flags: currentUser.flags,
			}
		: MOCK_USER_PARTIAL;
}

function errorCode(error: HttpError): string | undefined {
	return (error.body as ApiErrorResponse | undefined)?.code;
}

function giftErrorModal(title: string, message: string): void {
	ModalCommands.push(
		modal(() => (
			<GenericErrorModal
				title={title}
				message={message}
				data-flx="gift.gift-commands.gift-error-modal.generic-error-modal"
			/>
		)),
	);
}

function handleRedeemFailure(i18n: I18n, code: string, target: InstanceHTTPTarget, error: HttpError): void {
	switch (errorCode(error)) {
		case APIErrorCodes.CANNOT_REDEEM_PLUTONIUM_WITH_VISIONARY:
			ModalCommands.push(
				modal(() => (
					<GiftSendToFriendModal
						code={code}
						data-flx="gift.gift-commands.handle-redeem-failure.gift-send-to-friend-modal"
					/>
				)),
			);
			break;
		case APIErrorCodes.UNKNOWN_GIFT_CODE:
			Gifts.markAsInvalid(code, target);
			giftErrorModal(
				i18n._(INVALID_GIFT_CODE_DESCRIPTOR),
				i18n._(THIS_GIFT_CODE_IS_INVALID_OR_HAS_ALREADY_BEEN_REDEEMED_DESCRIPTOR),
			);
			break;
		// The code stays unused; the account's item list was stale, so it catches up and the dialog shows "owned".
		case APIErrorCodes.COSMETIC_ALREADY_OWNED:
			void Cosmetics.load();
			giftErrorModal(i18n._(ALREADY_OWNED_DESCRIPTOR), i18n._(ALREADY_OWNED_CODE_KEPT_DESCRIPTOR));
			break;
		case APIErrorCodes.GIFT_CODE_ALREADY_REDEEMED:
			Gifts.markAsRedeemed(code, target);
			giftErrorModal(
				i18n._(GIFT_ALREADY_REDEEMED_TITLE_DESCRIPTOR),
				i18n._(THIS_GIFT_CODE_HAS_ALREADY_BEEN_REDEEMED_DESCRIPTOR),
			);
			break;
		default:
			if (error.status === 404) {
				Gifts.markAsInvalid(code, target);
				giftErrorModal(i18n._(GIFT_NOT_FOUND_TITLE_DESCRIPTOR), i18n._(THIS_GIFT_CODE_COULD_NOT_BE_FOUND_DESCRIPTOR));
			} else {
				giftErrorModal(
					i18n._(FAILED_TO_REDEEM_GIFT_DESCRIPTOR),
					i18n._(WE_COULDN_T_REDEEM_THIS_GIFT_CODE_PLEASE_TRY_AGAIN_DESCRIPTOR),
				);
			}
	}
}

function fallbackRedeemFailure(i18n: I18n): void {
	giftErrorModal(
		i18n._(FAILED_TO_REDEEM_GIFT_DESCRIPTOR),
		i18n._(WE_COULDN_T_REDEEM_THIS_GIFT_CODE_PLEASE_TRY_AGAIN_DESCRIPTOR),
	);
}

function mockGiftMetadata(): Array<GiftMetadata> {
	const userPartial = currentUserPartial();
	const now = new Date();
	const sevenDaysAgo = new Date(now.getTime() - 7 * MS_PER_DAY);
	const twoDaysAgo = new Date(now.getTime() - 2 * MS_PER_DAY);
	const durationMonths = DeveloperOptions.mockGiftDurationMonths ?? 12;
	const isRedeemed = DeveloperOptions.mockGiftRedeemed ?? false;
	const duration = mapLegacyDurationMonthsToFields(durationMonths);
	return [
		{
			code: 'MOCK-GIFT-TEST-1234',
			duration_type: duration.duration_type,
			duration_quantity: duration.duration_quantity,
			created_at: sevenDaysAgo.toISOString(),
			created_by: userPartial,
			redeemed_at: isRedeemed ? twoDaysAgo.toISOString() : null,
			redeemed_by: isRedeemed ? userPartial : null,
		},
	];
}

// Premium time. Every gift screen reads this shape; an item code never takes it.
export interface Gift {
	kind?: 'premium';
	code: string;
	duration_type: GiftDurationType;
	duration_quantity: number;
	redeemed: boolean;
	created_by?: UserPartial;
}

// An item code (mirror instances only): redeeming adds the item to the account and wears it.
export interface CosmeticGift {
	kind: 'cosmetic';
	code: string;
	redeemed: boolean;
	item: CosmeticItemResponse;
}

export type AnyGift = Gift | CosmeticGift;

export interface GiftMetadata {
	code: string;
	duration_type: GiftDurationType;
	duration_quantity: number;
	created_at: string;
	created_by: UserPartial;
	redeemed_at: string | null;
	redeemed_by: UserPartial | null;
}

function giftFromShopCode({code, redeemed, grant}: ShopCodeResponse): AnyGift {
	return grant.type === 'cosmetic'
		? {kind: 'cosmetic', code, redeemed, item: grant.item}
		: {code, redeemed, duration_type: grant.duration_type, duration_quantity: grant.duration_quantity};
}

// GET /gifts/:code answers an item code as unknown, so old clients never show it as premium time; a mirror
// instance, where item codes exist, previews every code through the shop instead.
export async function fetch(rawCode: string, target: InstanceHTTPTarget = currentInstanceTarget()): Promise<AnyGift> {
	const code = extractGiftCode(rawCode);
	try {
		const selfHosted =
			InstanceSnapshotStore.get(target.instanceKey)?.features.self_hosted ?? RuntimeConfig.isSelfHosted();
		const gift = selfHosted
			? giftFromShopCode(
					(await instanceRequest<ShopCodeResponse>({method: 'GET', path: Endpoints.SHOP_CODE(code), target})).body,
				)
			: (await instanceRequest<Gift>({method: 'GET', path: Endpoints.GIFT(code), target})).body;
		logger.debug('Gift fetched', {code});
		return gift;
	} catch (error) {
		logger.error('Gift fetch failed', error);
		throw error;
	}
}

export async function fetchWithCoalescing(
	rawCode: string,
	target: InstanceHTTPTarget = currentInstanceTarget(),
): Promise<AnyGift> {
	return Gifts.fetchGift(extractGiftCode(rawCode), target);
}

export async function openAcceptModal(
	rawCode: string,
	target: InstanceHTTPTarget = currentInstanceTarget(),
): Promise<void> {
	const code = extractGiftCode(rawCode);
	void fetchWithCoalescing(code, target).catch(() => {});
	ModalCommands.pushWithKey(
		modal(() => (
			<GiftAcceptModal code={code} target={target} data-flx="gift.gift-commands.open-accept-modal.gift-accept-modal" />
		)),
		`gift-accept-${code}`,
	);
}

export async function redeem(
	i18n: I18n,
	rawCode: string,
	target: InstanceHTTPTarget = currentInstanceTarget(),
): Promise<void> {
	const code = extractGiftCode(rawCode);
	const item = Gifts.getGift(code, target)?.item?.item ?? null;
	try {
		await instanceRequest({method: 'POST', path: Endpoints.GIFT_REDEEM(code), target});
		logger.info('Gift redeemed', {code});
		Gifts.markAsRedeemed(code, target);
		if (item) {
			// The server added the item and wore it; the gift dialog says so, so no toast.
			void Cosmetics.load();
			if (item.type === 'profile_effect') UserProfileCommands.clearCurrentUserProfiles();
		} else {
			ToastCommands.success(i18n._(GIFT_REDEEMED_SUCCESSFULLY_DESCRIPTOR));
		}
		// Only a session that opened the shop holds a catalog; premium time changes its member discount.
		if (ShopCatalog.status !== 'idle') void ShopCatalog.load(true);
	} catch (error) {
		logger.error('Gift redeem failed', error);
		if (error instanceof HttpError) {
			handleRedeemFailure(i18n, code, target, error);
		} else {
			fallbackRedeemFailure(i18n);
		}
		throw error;
	}
}

export async function fetchUserGifts(): Promise<Array<GiftMetadata>> {
	if (DeveloperOptions.mockGiftInventory) {
		logger.debug('Returning mock user gifts', {count: 1});
		return mockGiftMetadata();
	}
	try {
		const response = await http.get<Array<GiftMetadata>>(Endpoints.USER_GIFTS);
		const gifts = response.body;
		logger.debug('User gifts fetched', {count: gifts.length});
		return gifts;
	} catch (error) {
		logger.error('User gifts fetch failed', error);
		throw error;
	}
}

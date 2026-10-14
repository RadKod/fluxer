// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {SYSTEM_USER_ID} from '@app/api/constants/Core';
import {requireAdminACL} from '@app/api/middleware/AdminMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import {assertGiftCodesAvailable} from '@app/api/stripe/services/StripeGiftService';
import type {HonoApp} from '@app/api/types/HonoEnv';
import type {IUserRepository} from '@app/api/user/IUserRepository';
import {Validator} from '@app/api/Validator';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {GiftCodeAlreadyRedeemedError} from '@fluxer/errors/src/domains/payment/GiftCodeAlreadyRedeemedError';
import {UnknownGiftCodeError} from '@fluxer/errors/src/domains/payment/UnknownGiftCodeError';
import {
	CodesResponse,
	GenerateGiftCodesRequest,
	RevokeGiftCodesRequest,
	RevokeGiftCodesResponse,
} from '@fluxer/schema/src/domains/admin/AdminSchemas';
import {GenerateCosmeticGiftCodesRequest} from '@fluxer/schema/src/domains/shop/ShopAdminSchemas';

function trimTrailingSlash(value: string): string {
	return value.endsWith('/') ? value.slice(0, -1) : value;
}

async function revokeGiftCodes(
	userRepository: IUserRepository,
	codes: ReadonlyArray<string>,
): Promise<RevokeGiftCodesResponse> {
	const result: RevokeGiftCodesResponse = {revoked: [], already_redeemed: [], not_found: []};
	for (const code of new Set(codes)) {
		try {
			await userRepository.revokeGiftCode(code);
			result.revoked.push(code);
		} catch (error) {
			if (error instanceof GiftCodeAlreadyRedeemedError) {
				result.already_redeemed.push(code);
			} else if (error instanceof UnknownGiftCodeError) {
				result.not_found.push(code);
			} else {
				throw error;
			}
		}
	}
	return result;
}

export function CodesAdminController(app: HonoApp) {
	app.post(
		'/admin/gift-codes',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_CODE_GENERATION),
		requireAdminACL(AdminACLs.GIFT_CODES_GENERATE),
		Validator('json', GenerateGiftCodesRequest),
		OpenAPI({
			operationId: 'create_admin_gift_codes',
			summary: 'Issue gift codes',
			description:
				'Create one-use Plus gift codes with an explicit positive duration and return their complete redemption links. Lifetime gifts are not supported. On self-hosted instances the premium mode must be mirror. Requires GIFT_CODES_GENERATE permission.',
			responseSchema: CodesResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			assertGiftCodesAvailable();
			const adminService = ctx.get('adminService');
			const {count, duration_type, duration_quantity} = ctx.req.valid('json');
			const codes = await adminService.codeGenerationService.generateGiftCodes({
				count,
				durationType: duration_type,
				durationQuantity: duration_quantity,
				createdByUserId: Config.instance.selfHosted ? ctx.get('adminUserId') : SYSTEM_USER_ID,
			});
			await adminService.auditService.createAuditLog({
				adminUserId: ctx.get('adminUserId'),
				targetType: 'gift_code',
				targetId: BigInt(0),
				action: 'generate_gift_codes',
				auditLogReason: ctx.get('auditLogReason'),
				metadata: new Map([
					['count', codes.length.toString()],
					['duration_type', duration_type],
					['duration_quantity', duration_quantity.toString()],
				]),
			});
			const baseUrl = trimTrailingSlash(Config.endpoints.gift);
			return ctx.json({
				codes: codes.map((code) => `${baseUrl}/${code}`),
			});
		},
	);
	app.post(
		'/admin/gift-codes/cosmetic',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_CODE_GENERATION),
		requireAdminACL(AdminACLs.GIFT_CODES_GENERATE),
		requireAdminACL(AdminACLs.COSMETICS_MANAGE),
		Validator('json', GenerateCosmeticGiftCodesRequest),
		OpenAPI({
			operationId: 'create_admin_cosmetic_gift_codes',
			summary: 'Issue cosmetic item codes',
			description:
				'Create one-use codes that each give one owned-availability cosmetic item instead of premium time, and return their complete redemption links. Not available on self-hosted instances unless premium_mode is mirror. Requires GIFT_CODES_GENERATE and COSMETICS_MANAGE permissions.',
			responseSchema: CodesResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			assertGiftCodesAvailable();
			const adminService = ctx.get('adminService');
			const {count, item_id} = ctx.req.valid('json');
			const item = await ctx.get('cosmeticService').getItem(item_id);
			if (item?.availability !== 'owned') {
				throw InputValidationError.create('item_id', 'Pick an owned-availability cosmetic item');
			}
			const codes = await adminService.codeGenerationService.generateCosmeticGiftCodes({count, itemId: item_id});
			await adminService.auditService.createAuditLog({
				adminUserId: ctx.get('adminUserId'),
				targetType: 'gift_code',
				targetId: BigInt(0),
				action: 'generate_cosmetic_gift_codes',
				auditLogReason: ctx.get('auditLogReason'),
				metadata: new Map([
					['count', codes.length.toString()],
					['item_id', item_id.toString()],
				]),
			});
			const baseUrl = trimTrailingSlash(Config.endpoints.gift);
			return ctx.json({
				codes: codes.map((code) => `${baseUrl}/${code}`),
			});
		},
	);
	app.post(
		'/admin/gift-codes/revoke',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_CODE_GENERATION),
		requireAdminACL(AdminACLs.GIFT_CODES_REVOKE),
		Validator('json', RevokeGiftCodesRequest),
		OpenAPI({
			operationId: 'revoke_admin_gift_codes',
			summary: 'Revoke gift codes',
			description:
				'Revoke unredeemed gift codes so they can no longer be redeemed. Redeemed codes are left unchanged and listed separately, as are unknown codes. Not available on self-hosted instances unless premium_mode is mirror. Requires GIFT_CODES_REVOKE permission.',
			responseSchema: RevokeGiftCodesResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			assertGiftCodesAvailable();
			const {codes} = ctx.req.valid('json');
			const result = await revokeGiftCodes(ctx.get('userRepository'), codes);
			await ctx.get('adminService').auditService.createAuditLog({
				adminUserId: ctx.get('adminUserId'),
				targetType: 'gift_code',
				targetId: BigInt(0),
				action: 'revoke_gift_codes',
				auditLogReason: ctx.get('auditLogReason'),
				metadata: new Map([
					['count', codes.length.toString()],
					['revoked', result.revoked.length.toString()],
					['already_redeemed', result.already_redeemed.length.toString()],
					['not_found', result.not_found.length.toString()],
				]),
			});
			return ctx.json(result);
		},
	);
}

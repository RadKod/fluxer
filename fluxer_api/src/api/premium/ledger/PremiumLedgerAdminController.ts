// SPDX-License-Identifier: AGPL-3.0-or-later

import {recordAdminWrite} from '@app/api/admin/AdminAuditRecorder';
import {createUserID} from '@app/api/BrandedTypes';
import {requireAdminACL} from '@app/api/middleware/AdminMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {getEarlyPlusBadgeService} from '@app/api/middleware/ServiceSingletons';
import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {Validator} from '@app/api/Validator';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {UserIdParam} from '@fluxer/schema/src/domains/common/CommonParamSchemas';
import {EndUserPremiumResponse} from '@fluxer/schema/src/domains/premium/PremiumLedgerSchemas';

export function PremiumLedgerAdminController(app: HonoApp) {
	app.post(
		'/admin/users/:user_id/premium/end',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_USER_MODIFY),
		requireAdminACL(AdminACLs.USER_UPDATE_FLAGS),
		Validator('param', UserIdParam),
		OpenAPI({
			operationId: 'end_admin_user_premium',
			summary: 'End user premium now',
			description:
				'Ends the paid premium time of the account now, for example after a refund; every kind of premium time the account holds ends. Repeating it changes nothing. Emits USER_UPDATE. Requires USER_UPDATE_FLAGS permission.',
			responseSchema: EndUserPremiumResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const userId = createUserID(ctx.req.valid('param').user_id);
			const {previousPaidUntil, paidUntil} = await ctx.get('premiumLedgerService').endPaidPremium(userId);
			await recordAdminWrite(ctx, {
				targetType: 'user',
				targetId: userId,
				action: 'end_user_premium',
				metadata: {previous_paid_until: previousPaidUntil?.toISOString()},
			});
			// After the audit entry: a failed take-back answers 500, and repeating the call takes it back.
			await getEarlyPlusBadgeService().revoke(userId);
			return ctx.json({
				previous_paid_until: previousPaidUntil?.toISOString() ?? null,
				paid_until: paidUntil?.toISOString() ?? null,
			});
		},
	);
}

// SPDX-License-Identifier: AGPL-3.0-or-later

import {AdminAuditService} from '@app/api/admin/services/AdminAuditService';
import {createUserID} from '@app/api/BrandedTypes';
import {getReferralRewardService} from '@app/api/middleware/ServiceSingletons';
import {createReferralGrantAuditor} from '@app/api/worker/tasks/utils/ReferralGrantAudit';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const Snowflake = z.string().regex(/^[1-9]\d{0,18}$/u);
const PayloadSchema = z.object({
	tier_id: Snowflake,
	admin_user_id: Snowflake,
	cursor: z.string().max(64).nullish(),
	granted: z.number().int().nonnegative().optional(),
});

// One page of a tier backfill per job: the cursor rides in the payload and the job queues the next page
// itself, so no account list is held in memory (no runAdminBulkJob), and pages run one after another, which bounds the
// grant rate. No DM or e-mail; a referral_grant system entry per reward, and one summary entry, by the admin who
// opened or lowered the tier, after the last page.
const backfillReferralTier: WorkerTaskHandler = async (rawPayload, helpers) => {
	const payload = PayloadSchema.parse(rawPayload);
	const page = await getReferralRewardService().backfillTierPage(
		payload.tier_id,
		payload.cursor ?? null,
		createReferralGrantAuditor(),
	);
	const granted = (payload.granted ?? 0) + page.granted;
	if (page.nextCursor) {
		await helpers.addJob(
			'backfillReferralTier',
			{tier_id: payload.tier_id, admin_user_id: payload.admin_user_id, cursor: page.nextCursor, granted},
			{jobKey: `${payload.tier_id}:${page.nextCursor}`},
		);
		return;
	}
	const deps = getWorkerDependencies();
	await new AdminAuditService(deps.adminRepository, deps.snowflakeService).createAuditLog({
		adminUserId: createUserID(BigInt(payload.admin_user_id)),
		targetType: 'referral_tier',
		targetId: BigInt(payload.tier_id),
		action: 'referral_backfill',
		auditLogReason: null,
		metadata: new Map([
			['tier_id', payload.tier_id],
			['granted', String(granted)],
			['job_id', helpers.jobId.toString()],
		]),
	});
};

export default backfillReferralTier;

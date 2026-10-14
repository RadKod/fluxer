// SPDX-License-Identifier: AGPL-3.0-or-later

import {AdminAuditService} from '@app/api/admin/services/AdminAuditService';
import type {UserID} from '@app/api/BrandedTypes';
import {SYSTEM_USER_ID} from '@app/api/constants/Core';
import type {ReferralGranted} from '@app/api/referral/ReferralRewardService';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';

// The system audit entry of one granted referral reward, from the grant job and the tier backfill alike: the tier
// and the reward type only, never an off-site code.
export function createReferralGrantAuditor(): (userId: UserID, granted: ReferralGranted) => Promise<void> {
	const deps = getWorkerDependencies();
	const auditService = new AdminAuditService(deps.adminRepository, deps.snowflakeService);
	return async (userId, granted) => {
		await auditService.createAuditLog({
			adminUserId: SYSTEM_USER_ID,
			targetType: 'user',
			targetId: userId,
			action: 'referral_grant',
			auditLogReason: null,
			metadata: new Map([
				['tier_id', granted.tier_id],
				['reward_type', granted.reward_type],
			]),
		});
	};
}

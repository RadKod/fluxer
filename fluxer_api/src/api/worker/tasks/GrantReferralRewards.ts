// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {getReferralRewardService} from '@app/api/middleware/ServiceSingletons';
import {createReferralGrantAuditor} from '@app/api/worker/tasks/utils/ReferralGrantAudit';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({user_id: z.string().regex(/^[1-9]\d{0,18}$/u)});

// Grants the tiers a referrer's valid count reached. Each finished reward gets a system audit entry at once, with the
// tier and the reward type only: never an off-site code.
const grantReferralRewards: WorkerTaskHandler = async (rawPayload) => {
	const userId = createUserID(BigInt(PayloadSchema.parse(rawPayload).user_id));
	const audit = createReferralGrantAuditor();
	await getReferralRewardService().grantDue(userId, {
		backfill: false,
		onGranted: (granted) => audit(userId, granted),
	});
};

export default grantReferralRewards;

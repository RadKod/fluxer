// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {REFERRAL_CHECK_SHARDS} from '@app/api/database/types/ReferralTypes';
import {getReferralRewardService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	referee_id: z.string().regex(/^[1-9]\d{0,18}$/u),
	slot: z.number().int().nonnegative(),
	shard: z
		.number()
		.int()
		.min(0)
		.max(REFERRAL_CHECK_SHARDS - 1),
});

// Decides one referral whose check row is due (job key <referee_id>:<slot>).
const evaluateReferral: WorkerTaskHandler = async (rawPayload) => {
	const {referee_id, slot, shard} = PayloadSchema.parse(rawPayload);
	await getReferralRewardService().evaluate(createUserID(BigInt(referee_id)), {slot, shard}, new Date());
};

export default evaluateReferral;

// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {getFollowService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	userId: z.string(),
	targetId: z.string(),
});

// retries the follow removal of a block whose inline attempt failed; a throw leaves it to the lane's retries.
const removeBlockedFollows: WorkerTaskHandler = async (payload) => {
	const {userId, targetId} = PayloadSchema.parse(payload);
	await getFollowService().removeFollowsBetween(createUserID(BigInt(userId)), createUserID(BigInt(targetId)));
};

export default removeBlockedFollows;

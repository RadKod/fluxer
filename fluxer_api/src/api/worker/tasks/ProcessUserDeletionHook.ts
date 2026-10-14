// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {Logger} from '@app/api/Logger';
import {runUserDeletionHook} from '@app/api/user/lifecycle/UserLifecycleHooks';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	userId: z.string(),
	hook: z.string(),
});

// Micup: one registered account deletion hook (see UserLifecycleHooks); a throw leaves the job to the lane's retries.
const processUserDeletionHook: WorkerTaskHandler = async (payload) => {
	const {userId, hook} = PayloadSchema.parse(payload);
	try {
		await runUserDeletionHook(hook, {userId: createUserID(BigInt(userId))});
	} catch (error) {
		Logger.error({error, userId, hook}, 'User deletion hook failed');
		throw error;
	}
};

export default processUserDeletionHook;

// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {dispatchPendingPartialUserChange} from '@app/api/user/services/PartialUserChangePropagation';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	userId: z.string().regex(/^\d+$/),
});

const propagatePartialUserChange: WorkerTaskHandler = async (payload) => {
	const {userId} = PayloadSchema.parse(payload);
	await dispatchPendingPartialUserChange(getWorkerDependencies(), createUserID(BigInt(userId)));
};

export default propagatePartialUserChange;

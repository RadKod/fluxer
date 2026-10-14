// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {getPioneerService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({userId: z.string().regex(/^\d+$/)});

// Micup Öncü: numbers one account; idempotent, a throw leaves it to the lifecycle lane's retries.
const assignPioneerBadge: WorkerTaskHandler = async (payload) => {
	const {userId} = PayloadSchema.parse(payload);
	await getPioneerService().assignFromQueue(createUserID(BigInt(userId)));
};

export default assignPioneerBadge;

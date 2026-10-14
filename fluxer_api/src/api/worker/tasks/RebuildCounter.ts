// SPDX-License-Identifier: AGPL-3.0-or-later

import {getKVCounterService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	namespace: z.string().min(1),
	id: z.string().min(1),
});

const rebuildCounter: WorkerTaskHandler = async (payload, helpers) => {
	const {namespace, id} = PayloadSchema.parse(payload);
	const value = await getKVCounterService().rebuild(namespace, id);
	helpers.logger.info({namespace, id, value}, 'Rebuilt KV counter from a full recount');
};

export default rebuildCounter;

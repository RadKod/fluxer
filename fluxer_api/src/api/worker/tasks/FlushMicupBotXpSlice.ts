// SPDX-License-Identifier: AGPL-3.0-or-later

import {createMicupBotLevels} from '@app/api/guild/micupbot/MicupBotLevels';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({slice: z.number().int().min(0).max(15), minute: z.number().int().min(0)});
const flushMicupBotXpSlice: WorkerTaskHandler = async (payload) => {
	const parsed = PayloadSchema.parse(payload);
	await createMicupBotLevels(getWorkerDependencies()).flushSlice(parsed);
};
export default flushMicupBotXpSlice;

// SPDX-License-Identifier: AGPL-3.0-or-later

import {createMicupBotVoiceRunner} from '@app/api/guild/micupbot/MicupBotVoice';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	turn: z.number().int().min(0),
	slot_start: z.number().int().min(0).max(4080).multipleOf(16),
});
const runMicupBotVoiceSlots: WorkerTaskHandler = async (payload) => {
	const parsed = PayloadSchema.parse(payload);
	await createMicupBotVoiceRunner(getWorkerDependencies()).runSlots(parsed);
};
export default runMicupBotVoiceSlots;

// SPDX-License-Identifier: AGPL-3.0-or-later

import {createMicupBotVoiceRunner} from '@app/api/guild/micupbot/MicupBotVoice';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({});
const queueMicupBotVoiceSlots: WorkerTaskHandler = async (payload) => {
	PayloadSchema.parse(payload);
	await createMicupBotVoiceRunner(getWorkerDependencies()).queueSlots(Date.now());
};
export default queueMicupBotVoiceSlots;

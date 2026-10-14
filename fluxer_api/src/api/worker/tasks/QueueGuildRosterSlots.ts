// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildRosterRuntime} from '@app/api/guild/roster/GuildRosterRuntime';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({phase: z.enum(['announce', 'check'])});

const queueGuildRosterSlots: WorkerTaskHandler = async (payload) => {
	const {phase} = PayloadSchema.parse(payload);
	await createGuildRosterRuntime(getWorkerDependencies()).queueSlots(phase, Date.now());
};

export default queueGuildRosterSlots;

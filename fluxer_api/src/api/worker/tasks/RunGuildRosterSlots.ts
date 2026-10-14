// SPDX-License-Identifier: AGPL-3.0-or-later

import {ROSTER_SLOT_COUNT} from '@app/api/database/types/GuildRosterTypes';
import {ROSTER_SLOTS_PER_JOB} from '@app/api/guild/roster/GuildRosterConstants';
import {createGuildRosterRuntime} from '@app/api/guild/roster/GuildRosterRuntime';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	phase: z.enum(['announce', 'check']),
	hour: z.number().int(),
	slot_start: z
		.number()
		.int()
		.min(0)
		.max(ROSTER_SLOT_COUNT - ROSTER_SLOTS_PER_JOB)
		.multipleOf(ROSTER_SLOTS_PER_JOB),
});

const runGuildRosterSlots: WorkerTaskHandler = async (payload) => {
	const {phase, hour, slot_start} = PayloadSchema.parse(payload);
	await createGuildRosterRuntime(getWorkerDependencies()).runSlots(phase, hour, slot_start);
};

export default runGuildRosterSlots;

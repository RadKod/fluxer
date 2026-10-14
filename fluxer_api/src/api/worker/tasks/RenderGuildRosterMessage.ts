// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID} from '@app/api/BrandedTypes';
import {createGuildRosterRuntime} from '@app/api/guild/roster/GuildRosterRuntime';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import {SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	guild_id: SnowflakeType,
	event_id: SnowflakeType,
	hour: z.number().int(),
	run_at: z.number().int().optional(),
});

const renderGuildRosterMessage: WorkerTaskHandler = async (payload) => {
	const {guild_id, event_id, hour, run_at} = PayloadSchema.parse(payload);
	await createGuildRosterRuntime(getWorkerDependencies()).render(
		{
			guildId: createGuildID(guild_id),
			eventId: event_id,
			hour,
		},
		run_at,
	);
};

export default renderGuildRosterMessage;

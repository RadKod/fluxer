// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildRosterRuntime} from '@app/api/guild/roster/GuildRosterRuntime';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import {SnowflakeStringType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	kind: z.enum(['add', 'remove', 'clear']),
	guild_id: SnowflakeStringType,
	channel_id: SnowflakeStringType,
	message_id: SnowflakeStringType,
	user_id: SnowflakeStringType.optional(),
	at: z.number().int(),
});

const syncGuildRosterReaction: WorkerTaskHandler = async (payload) => {
	const change = PayloadSchema.parse(payload);
	await createGuildRosterRuntime(getWorkerDependencies()).syncReaction(change);
};

export default syncGuildRosterReaction;

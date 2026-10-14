// SPDX-License-Identifier: AGPL-3.0-or-later

import {MICUPBOT_LIVE_LAG_WARN_MS} from '@app/api/guild/micupbot/MicupBotConstants';
import {createMicupBotReactionRoleRunner} from '@app/api/guild/micupbot/MicupBotReactionRoles';
import {Logger} from '@app/api/Logger';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import {SnowflakeStringType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	kind: z.enum(['add', 'remove']),
	guild_id: SnowflakeStringType,
	channel_id: SnowflakeStringType,
	message_id: SnowflakeStringType,
	user_id: SnowflakeStringType,
	emoji_name: z.string().min(1).max(64),
	emoji_id: SnowflakeStringType.nullable(),
	at: z.number().int(),
});
const applyMicupBotReactionRole: WorkerTaskHandler = async (payload) => {
	const parsed = PayloadSchema.parse(payload);
	const lag_ms = Date.now() - parsed.at;
	if (lag_ms > MICUPBOT_LIVE_LAG_WARN_MS)
		Logger.warn({lag_ms, task: 'applyMicupBotReactionRole'}, 'MicupBOT live task lag');
	else Logger.debug({lag_ms, task: 'applyMicupBotReactionRole'}, 'MicupBOT live task lag');
	await createMicupBotReactionRoleRunner(getWorkerDependencies()).run(parsed);
};
export default applyMicupBotReactionRole;

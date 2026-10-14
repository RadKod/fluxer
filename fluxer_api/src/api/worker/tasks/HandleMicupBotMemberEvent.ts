// SPDX-License-Identifier: AGPL-3.0-or-later

import {MICUPBOT_LIVE_LAG_WARN_MS} from '@app/api/guild/micupbot/MicupBotConstants';
import {createMicupBotMemberEventRunner} from '@app/api/guild/micupbot/MicupBotMemberEvents';
import {Logger} from '@app/api/Logger';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import {SnowflakeStringType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	kind: z.enum(['join', 'leave', 'bot_join', 'bot_leave']),
	guild_id: SnowflakeStringType,
	user_id: SnowflakeStringType,
	temporary: z.boolean().optional(),
	at: z.number().int(),
});
const handleMicupBotMemberEvent: WorkerTaskHandler = async (payload) => {
	const parsed = PayloadSchema.parse(payload);
	const lag_ms = Date.now() - parsed.at;
	if (lag_ms > MICUPBOT_LIVE_LAG_WARN_MS)
		Logger.warn({lag_ms, task: 'handleMicupBotMemberEvent'}, 'MicupBOT live task lag');
	else Logger.debug({lag_ms, task: 'handleMicupBotMemberEvent'}, 'MicupBOT live task lag');
	await createMicupBotMemberEventRunner(getWorkerDependencies()).run(parsed);
};
export default handleMicupBotMemberEvent;

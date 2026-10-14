// SPDX-License-Identifier: AGPL-3.0-or-later

import {createMicupBotCommandRunner} from '@app/api/guild/micupbot/MicupBotCommands';
import {MICUPBOT_LIVE_LAG_WARN_MS} from '@app/api/guild/micupbot/MicupBotConstants';
import {Logger} from '@app/api/Logger';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import {SnowflakeStringType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	guild_id: SnowflakeStringType,
	channel_id: SnowflakeStringType,
	message_id: SnowflakeStringType,
	author_id: SnowflakeStringType,
	content: z.string().max(2000),
	at: z.number().int(),
});
const runMicupBotCommand: WorkerTaskHandler = async (payload) => {
	const parsed = PayloadSchema.parse(payload);
	const lag_ms = Date.now() - parsed.at;
	if (lag_ms > MICUPBOT_LIVE_LAG_WARN_MS) Logger.warn({lag_ms, task: 'runMicupBotCommand'}, 'MicupBOT live task lag');
	else Logger.debug({lag_ms, task: 'runMicupBotCommand'}, 'MicupBOT live task lag');
	await createMicupBotCommandRunner(getWorkerDependencies()).run(parsed);
};
export default runMicupBotCommand;

// SPDX-License-Identifier: AGPL-3.0-or-later

import {MICUPBOT_LIVE_LAG_WARN_MS} from '@app/api/guild/micupbot/MicupBotConstants';
import {createMicupBotLevels} from '@app/api/guild/micupbot/MicupBotLevels';
import {Logger} from '@app/api/Logger';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import {SnowflakeStringType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	guild_id: SnowflakeStringType,
	user_id: SnowflakeStringType,
	channel_id: SnowflakeStringType.nullable(),
	level: z.number().int().min(1),
	at: z.number().int(),
});
const handleMicupBotLevelUp: WorkerTaskHandler = async (payload) => {
	const parsed = PayloadSchema.parse(payload);
	const lag_ms = Date.now() - parsed.at;
	if (lag_ms > MICUPBOT_LIVE_LAG_WARN_MS)
		Logger.warn({lag_ms, task: 'handleMicupBotLevelUp'}, 'MicupBOT live task lag');
	else Logger.info({lag_ms, task: 'handleMicupBotLevelUp'}, 'MicupBOT live task lag');
	await createMicupBotLevels(getWorkerDependencies()).handleLevelUp(parsed);
};
export default handleMicupBotLevelUp;

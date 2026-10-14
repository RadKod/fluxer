// SPDX-License-Identifier: AGPL-3.0-or-later

import {createMicupBotAutomodRunner} from '@app/api/guild/micupbot/MicupBotAutomod';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import {
	MICUPBOT_AUTOMOD_ACTIONS,
	MICUPBOT_AUTOMOD_RULES,
} from '@fluxer/schema/src/domains/micupbot/MicupBotRequestSchemas';
import {SnowflakeStringType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	guild_id: SnowflakeStringType,
	channel_id: SnowflakeStringType,
	message_id: SnowflakeStringType,
	author_id: SnowflakeStringType,
	rule: z.enum(MICUPBOT_AUTOMOD_RULES),
	action: z.enum(MICUPBOT_AUTOMOD_ACTIONS),
	mute_seconds: z.number().int().min(60).max(2_419_200),
	at: z.number().int(),
});
const applyMicupBotAutomodAction: WorkerTaskHandler = async (payload) => {
	const parsed = PayloadSchema.parse(payload);
	await createMicupBotAutomodRunner(getWorkerDependencies()).run(parsed);
};
export default applyMicupBotAutomodAction;

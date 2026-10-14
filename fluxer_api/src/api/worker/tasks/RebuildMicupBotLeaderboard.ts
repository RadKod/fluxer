// SPDX-License-Identifier: AGPL-3.0-or-later

import {createMicupBotLevels} from '@app/api/guild/micupbot/MicupBotLevels';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import {SnowflakeStringType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({guild_id: SnowflakeStringType});
const rebuildMicupBotLeaderboard: WorkerTaskHandler = async (payload) => {
	const parsed = PayloadSchema.parse(payload);
	await createMicupBotLevels(getWorkerDependencies()).rebuildLeaderboard(parsed);
};
export default rebuildMicupBotLeaderboard;

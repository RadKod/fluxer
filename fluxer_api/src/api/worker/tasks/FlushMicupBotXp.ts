// SPDX-License-Identifier: AGPL-3.0-or-later

import {MICUPBOT_XP_FLUSH_SLICES} from '@app/api/guild/micupbot/MicupBotConstants';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({});
const flushMicupBotXp: WorkerTaskHandler = async (payload, helpers) => {
	PayloadSchema.parse(payload);
	const minute = Math.floor(Date.now() / 60_000);
	for (let slice = 0; slice < MICUPBOT_XP_FLUSH_SLICES; slice++)
		await helpers.addJob(
			'flushMicupBotXpSlice',
			{slice, minute},
			{jobKey: `mbxp:${minute}:${slice}`, skipLedger: true},
		);
};
export default flushMicupBotXp;

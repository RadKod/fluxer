// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID} from '@app/api/BrandedTypes';
import {getGuildBoostService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	guildId: z.string().regex(/^\d+$/),
});

// One writer per guild: the recompute runs under the guild update lock, reads the boost count from its KV counter and
// writes the level and features once for every boost change that set the dirty flag before it.
const recomputeGuildBoost: WorkerTaskHandler = async (payload) => {
	const {guildId} = PayloadSchema.parse(payload);
	await getGuildBoostService().recomputeDirty(createGuildID(BigInt(guildId)));
};

export default recomputeGuildBoost;

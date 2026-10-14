// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createUserID} from '@app/api/BrandedTypes';
import {getGuildBoostService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	guildId: z.string().regex(/^\d+$/),
	userId: z.string().regex(/^\d+$/),
	leftAt: z.iso.datetime(),
});

// retries taking a removed member's boosts off when the inline attempt failed. Idempotent; a boost
// put on the guild after leftAt (the member came back) stays. A throw leaves it to the lane's retries.
const removeMemberBoosts: WorkerTaskHandler = async (payload) => {
	const {guildId, userId, leftAt} = PayloadSchema.parse(payload);
	await getGuildBoostService().removeMemberBoosts(
		createGuildID(BigInt(guildId)),
		createUserID(BigInt(userId)),
		new Date(leftAt),
	);
};

export default removeMemberBoosts;

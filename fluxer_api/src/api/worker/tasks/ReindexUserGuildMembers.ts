// SPDX-License-Identifier: AGPL-3.0-or-later
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {getGuildMemberSearchService} from '@app/api/SearchFactory';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import {registerHistogram} from '@fluxer/hono/src/middleware/Metrics';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({user_id: z.string().regex(/^\d+$/), enqueued_at_ms: z.number().int().nonnegative()});
const queueAge = registerHistogram(
	'fluxer_api_username_reindex_queue_age_seconds',
	'Username guild reindex queue age',
	[1, 5, 10, 30, 60, 300],
);

export async function enqueueUsernameReindex(
	worker: IWorkerService,
	userId: UserID,
	generation: bigint,
	now: () => number = Date.now,
): Promise<void> {
	// Micup: include the identity generation so deduplication cannot suppress a later rename after a completed job.
	await worker.addJob(
		'reindexUserGuildMembers',
		{user_id: userId.toString(), enqueued_at_ms: now()},
		{jobKey: `username-reindex:${userId}:${generation}`, requireLedger: true, maxAttempts: 25},
	);
}

const reindexUserGuildMembers: WorkerTaskHandler = async (payload) => {
	const {user_id, enqueued_at_ms} = PayloadSchema.parse(payload);
	queueAge.observe(Math.max(0, Date.now() - enqueued_at_ms) / 1000);
	const {userRepository, guildRepository} = getWorkerDependencies();
	const userId = createUserID(BigInt(user_id));
	const user = await userRepository.findUnique(userId);
	if (!user) return;
	const guildIds = await userRepository.getUserGuildIds(userId);
	if (guildIds.length === 0) return;
	const search = getGuildMemberSearchService();
	if (!search) throw new Error('Username member search is unavailable');
	const guilds = await guildRepository.listGuilds(guildIds);
	for (const guild of guilds) {
		if (guild.membersIndexedAt === null) continue;
		const member = await guildRepository.getMember(guild.id, userId);
		// Micup: await the native search call; the profile helper suppresses failures and cannot support durable retry.
		if (member) await search.updateMember(member, user);
	}
};
export default reindexUserGuildMembers;

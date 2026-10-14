// SPDX-License-Identifier: AGPL-3.0-or-later

import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

export const MICUPBOT_LEADERBOARD_SIZE = 1000;
const LEADERBOARD_TTL_SECONDS = 30 * 24 * 60 * 60;

export function micupBotLeaderboardKey(guildId: string | bigint): string {
	return `micupbot:lb:${guildId}`;
}

export async function leaderboardAdd(
	kv: IKVProvider,
	guildId: string | bigint,
	userId: string | bigint,
	xp: number,
	random: () => number = Math.random,
): Promise<void> {
	const key = micupBotLeaderboardKey(guildId);
	await kv.zadd(key, xp, String(userId));
	await kv.expire(key, LEADERBOARD_TTL_SECONDS);
	// TEMPORARY: one set per guild, trimmed on 1% of awards. Above 5,000 operations/s on one key,
	// split it into 16 sets and merge reads; reads already stop at the top 1,000.
	if (random() < 0.01) {
		await kv.zremrangebyrank(key, 0, -(MICUPBOT_LEADERBOARD_SIZE + 1));
	}
}

export async function leaderboardTop(
	kv: IKVProvider,
	guildId: string | bigint,
	offset: number,
	limit: number,
): Promise<Array<{userId: string; xp: number}>> {
	if (limit <= 0 || offset >= MICUPBOT_LEADERBOARD_SIZE) return [];
	const entries = await kv.zrevrangeWithScores(
		micupBotLeaderboardKey(guildId),
		offset,
		Math.min(offset + limit, MICUPBOT_LEADERBOARD_SIZE) - 1,
	);
	return entries.map(({member, score}) => ({userId: member, xp: score}));
}

export async function leaderboardRank(
	kv: IKVProvider,
	guildId: string | bigint,
	userId: string | bigint,
): Promise<number | null> {
	const rank = await kv.zrevrank(micupBotLeaderboardKey(guildId), String(userId));
	return rank === null || rank >= MICUPBOT_LEADERBOARD_SIZE ? null : rank + 1;
}

export async function leaderboardCount(kv: IKVProvider, guildId: string | bigint): Promise<number> {
	return kv.zcard(micupBotLeaderboardKey(guildId));
}

export async function leaderboardExists(kv: IKVProvider, guildId: string | bigint): Promise<boolean> {
	return (await kv.exists(micupBotLeaderboardKey(guildId))) > 0;
}

export async function leaderboardReplace(
	kv: IKVProvider,
	guildId: string | bigint,
	entries: Array<{userId: string | bigint; xp: number}>,
): Promise<void> {
	const key = micupBotLeaderboardKey(guildId);
	await kv.del(key);
	if (entries.length === 0) return;
	await kv.zadd(key, ...entries.flatMap(({userId, xp}) => [xp, String(userId)]));
	await kv.zremrangebyrank(key, 0, -(MICUPBOT_LEADERBOARD_SIZE + 1));
	await kv.expire(key, LEADERBOARD_TTL_SECONDS);
}

export async function leaderboardRemove(
	kv: IKVProvider,
	guildId: string | bigint,
	userId: string | bigint,
): Promise<void> {
	await kv.zrem(micupBotLeaderboardKey(guildId), String(userId));
}

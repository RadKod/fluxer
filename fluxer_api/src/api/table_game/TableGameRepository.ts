// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import type {TablePosition} from '@app/api/table_game/engine/TableGameEngine';
import {
	TABLE_GAME_LIST_CACHE_S,
	TABLE_GAME_PRESENCE_LOCK_S,
	TABLE_GAME_TIMER_LEASE_S,
	TABLE_GAME_USER_LOCK_TTL_S,
	TABLE_GAME_WATCH_TICKET_TTL_S,
} from '@app/api/table_game/TableGameLimits';
import {TABLE_GAME_TIMER_SHARDS} from '@fluxer/constants/src/TableGameConstants';
import type {
	TableGameKind,
	TableGameResult,
	TableGameSpeed,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

// The `s` field of {tg:<channel_id>:<slot>}. it holds every rack and the deck, so it never leaves the API; clients
// only get TableGameService views built through engine.view().
export interface TableEnvelope {
	v: 1;
	version: number;
	guild_id: string;
	channel_id: string;
	slot: string;
	game: TableGameKind;
	speed: TableGameSpeed;
	status: 'lobby' | 'playing' | 'ended';
	players: Array<{position: TablePosition; user_id: string}>;
	disconnected: Partial<Record<TablePosition, number>>; // position → since (ms)
	next_presence_check_at: number | null;
	created_at: number;
	ended_at: number | null;
	result: TableGameResult | null; // set once the table ends, from the engine or a lobby cancel
	engine: unknown;
}

interface ScriptableKVProvider extends IKVProvider {
	evalScript(command: string, script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>;
}

// Single-key scripts (cluster ready); TableGameMockScripts twins them for the mock KV.
const TABLE_GAME_CAS = `
local cur = redis.call('HGET', KEYS[1], 'v')
if ARGV[1] == '-1' then
  if cur then return 0 end
elseif cur ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'v', ARGV[2], 's', ARGV[3])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return 1
`;

const TABLE_GAME_SPECTATE = `
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then redis.call('EXPIRE', KEYS[1], ARGV[3]) return 1 end
if redis.call('SCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('SADD', KEYS[1], ARGV[1]) redis.call('EXPIRE', KEYS[1], ARGV[3]) return 1
`;

const TABLE_GAME_UNLOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) return 1 end
return 0
`;

const tableKey = (channelId: string, slot: string) => `{tg:${channelId}:${slot}}`;
const userLockKey = (userId: string) => `{tg_user:${userId}}`;
const spectatorLockKey = (userId: string) => `{tg_spec:${userId}}`;
const timerKey = (shard: number) => `{tg_timers:${shard}}`;
const listKey = (channelId: string) => `{tg_list:${channelId}}`;

export const tableGameMember = (channelId: string, slot: string) => `${channelId}:${slot}`;

export function parseTableGameMember(member: string): {channelId: string; slot: string} | null {
	const match = /^([0-9]+):(T[0-9]{2})$/.exec(member);
	return match ? {channelId: match[1]!, slot: match[2]!} : null;
}

export function tableGameTimerShard(member: string): number {
	return Number.parseInt(createHash('sha1').update(member).digest('hex').slice(0, 2), 16) % TABLE_GAME_TIMER_SHARDS;
}

export class TableGameRepository {
	constructor(readonly kvClient: IKVProvider) {}

	async load(channelId: string, slot: string): Promise<TableEnvelope | null> {
		const json = await this.kvClient.hget(tableKey(channelId, slot), 's');
		return json === null ? null : (JSON.parse(json) as TableEnvelope);
	}

	// expectedVersion null creates the table; otherwise it replaces exactly that version.
	async cas(envelope: TableEnvelope, expectedVersion: number | null, ttlSeconds: number): Promise<boolean> {
		const result = await this.runScript(
			'tableGameCas',
			TABLE_GAME_CAS,
			tableKey(envelope.channel_id, envelope.slot),
			expectedVersion === null ? '-1' : String(expectedVersion),
			String(envelope.version),
			JSON.stringify(envelope),
			ttlSeconds,
		);
		return Number(result) === 1;
	}

	async spectate(channelId: string, slot: string, userId: string, limit: number, ttlSeconds: number) {
		const key = `${tableKey(channelId, slot)}:sp`;
		return Number(await this.runScript('tableGameSpectate', TABLE_GAME_SPECTATE, key, userId, limit, ttlSeconds)) === 1;
	}

	async listSpectators(channelId: string, slot: string): Promise<Array<string>> {
		return await this.kvClient.smembers(`${tableKey(channelId, slot)}:sp`);
	}

	async isSpectator(channelId: string, slot: string, userId: string): Promise<boolean> {
		return (await this.kvClient.sismember(`${tableKey(channelId, slot)}:sp`, userId)) === 1;
	}

	async removeSpectator(channelId: string, slot: string, userId: string): Promise<void> {
		await this.kvClient.srem(`${tableKey(channelId, slot)}:sp`, userId);
	}

	// The set and its members' watch locks follow the table lifetime when the table changes status (CR2).
	async renewSpectators(channelId: string, slot: string, userIds: ReadonlyArray<string>, ttlSeconds: number) {
		await Promise.all([
			this.kvClient.expire(`${tableKey(channelId, slot)}:sp`, ttlSeconds),
			...userIds.map((userId) => this.kvClient.expire(spectatorLockKey(userId), ttlSeconds)),
		]);
	}

	async clearSpectators(channelId: string, slot: string): Promise<void> {
		await this.kvClient.del(`${tableKey(channelId, slot)}:sp`);
	}

	async lockUser(userId: string, value: string): Promise<boolean> {
		return await this.kvClient.setnx(userLockKey(userId), value, TABLE_GAME_USER_LOCK_TTL_S);
	}

	async readUserLock(userId: string): Promise<string | null> {
		return await this.kvClient.get(userLockKey(userId));
	}

	async userLockTtl(userId: string): Promise<number> {
		return await this.kvClient.ttl(userLockKey(userId));
	}

	async unlockUser(userId: string, expected: string): Promise<boolean> {
		return await this.unlock(userLockKey(userId), expected);
	}

	async setSpectatorLock(userId: string, value: string, ttlSeconds: number): Promise<void> {
		await this.kvClient.setex(spectatorLockKey(userId), ttlSeconds, value);
	}

	async readSpectatorLock(userId: string): Promise<string | null> {
		return await this.kvClient.get(spectatorLockKey(userId));
	}

	async unlockSpectator(userId: string, expected: string): Promise<boolean> {
		return await this.unlock(spectatorLockKey(userId), expected);
	}

	async issueWatchTicket(channelId: string, slot: string, userId: string): Promise<void> {
		await this.kvClient.setex(`${tableKey(channelId, slot)}:w:${userId}`, TABLE_GAME_WATCH_TICKET_TTL_S, '1');
	}

	async hasWatchTicket(channelId: string, slot: string, userId: string): Promise<boolean> {
		return (await this.kvClient.get(`${tableKey(channelId, slot)}:w:${userId}`)) !== null;
	}

	// V5: a channel's list reply ({body, etag} JSON) for a second, and the claim of the one reader who builds it.
	async readListCache(channelId: string): Promise<string | null> {
		return await this.kvClient.get(listKey(channelId));
	}

	async claimListBuild(channelId: string): Promise<boolean> {
		return await this.kvClient.setnx(`${listKey(channelId)}:lock`, '1', TABLE_GAME_LIST_CACHE_S);
	}

	async writeListCache(channelId: string, json: string): Promise<void> {
		await this.kvClient.setex(listKey(channelId), TABLE_GAME_LIST_CACHE_S, json);
	}

	async acquirePresenceCheck(channelId: string, slot: string): Promise<boolean> {
		return await this.kvClient.setnx(`${tableKey(channelId, slot)}:pc`, '1', TABLE_GAME_PRESENCE_LOCK_S);
	}

	// at null takes the table off the timer.
	async scheduleTimer(channelId: string, slot: string, at: number | null): Promise<void> {
		const member = tableGameMember(channelId, slot);
		const key = timerKey(tableGameTimerShard(member));
		if (at === null) await this.kvClient.zrem(key, member);
		else await this.kvClient.zadd(key, at, member);
	}

	async dueTimers(shard: number, maxScore: number | '+inf', limit: number): Promise<Array<string>> {
		return await this.kvClient.zrangebyscore(timerKey(shard), 0, maxScore, 'LIMIT', 0, limit);
	}

	async acquireTimerLease(shard: number, token: string): Promise<boolean> {
		return await this.kvClient.setnx(`${timerKey(shard)}:lease`, token, TABLE_GAME_TIMER_LEASE_S);
	}

	async releaseTimerLease(shard: number, token: string): Promise<void> {
		await this.unlock(`${timerKey(shard)}:lease`, token);
	}

	private async unlock(key: string, expected: string): Promise<boolean> {
		return Number(await this.runScript('tableGameUnlock', TABLE_GAME_UNLOCK, key, expected)) === 1;
	}

	private async runScript(command: string, script: string, key: string, ...args: Array<string | number>) {
		return await (this.kvClient as ScriptableKVProvider).evalScript(command, script, 1, key, ...args);
	}
}

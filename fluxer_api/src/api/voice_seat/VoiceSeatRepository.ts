// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, UserID} from '@app/api/BrandedTypes';
import {
	VOICE_SEAT_CHANNEL_CHANGES_PER_WINDOW,
	VOICE_SEAT_CHANNEL_WINDOW_S,
	VOICE_SEAT_HASH_TTL_S,
	VOICE_SEAT_MARK_CHUNK,
	VOICE_SEAT_RECONCILE_LOCK_S,
} from '@app/api/voice_seat/VoiceSeatLimits';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

export type VoiceSeatTakeMode = 'join' | 'auto' | 'explicit';
export type VoiceSeatTakeStatus = 'ok' | 'same' | 'taken' | 'full' | 'user_elsewhere' | 'gone' | 'limited';

export interface VoiceSeatTakeResult {
	seat: string | null;
	status: VoiceSeatTakeStatus;
	freed: string | null;
}

interface ScriptableKVProvider extends IKVProvider {
	evalScript(command: string, script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>;
}

// One hash per voice channel. Fields: s:<seat> → identity, p:<identity> → seat,
// u:<user_id> → seated identity, j:<identity> → '<user_id>|<region_id>|<server_id>' (O(1) voice membership mark),
// l:<user_id> → latest joined identity (seat heir), g:<identity> → '1' leave tombstone with a 120 s field TTL (HEXPIRE,
// Valkey 9) that stops a late join hook, r:count / r:ends → the REST change budget window (take script). Identity =
// LiveKit participant identity user_<uid>_<conn>. Hash-tagged and single-key scripts only, so the keys move to a
// Valkey cluster unchanged.
export function voiceSeatsKey(channelId: ChannelID): string {
	return `{voice_seats:${channelId}}`;
}

// auto/join: a held lounge seat that is not among the candidates (the theme changed) counts as not held; it is
// dropped and a new seat given, or, with no free seat, the identity itself comes back as freed so its attribute goes.
// Table seats (seat_T<NN>_<K>) stay: the table service owns them. Watch seats (seat_T<NN>_Y<K>) close the auto/join
// candidate list only to be kept by their holder: the assignment loop gives them out on an explicit pick alone. Valkey's embedded Lua is 5.1: no goto, hence the guarded loop body.
// Channel change budget: a REST take passes cap > 0. It is refused ('limited', nothing written) while
// the window already holds `cap` changes, and only a change spends it: an 'ok', or a 'full' that dropped a seat which
// left the theme. Fields r:count and r:ends (window end, server TIME in ms) live in the same hash, so the check and the
// spend are one atomic single-key script; the window starts at its first change.
const VOICE_SEAT_TAKE_SCRIPT = `
local k, id, uid, ttl, mode, jv = KEYS[1], ARGV[1], ARGV[2], tonumber(ARGV[3]), ARGV[4], ARGV[5]
local cap, window, now, used = tonumber(ARGV[6]), tonumber(ARGV[7]), 0, 0
if cap > 0 then
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
  if now < tonumber(redis.call('HGET', k, 'r:ends') or 0) then
    used = tonumber(redis.call('HGET', k, 'r:count') or 0)
  end
  if used >= cap then return {'', 'limited', ''} end
end
local function spend()
  if cap == 0 then return end
  if used == 0 then redis.call('HSET', k, 'r:ends', now + window) end
  redis.call('HSET', k, 'r:count', used + 1)
end
if mode == 'join' then
  if redis.call('HEXISTS', k, 'g:' .. id) == 1 then return {'', 'gone', ''} end
  redis.call('HSET', k, 'j:' .. id, jv, 'l:' .. uid, id)
end
local held = redis.call('HGET', k, 'p:' .. id)
local dropped = ''
if held and mode ~= 'explicit' and not string.match(held, '^seat_T%d%d_%d$') then
  local listed = false
  for i = 8, #ARGV do if ARGV[i] == held then listed = true break end end
  if not listed then
    redis.call('HDEL', k, 's:' .. held, 'p:' .. id)
    if redis.call('HGET', k, 'u:' .. uid) == id then redis.call('HDEL', k, 'u:' .. uid) end
    held = false
    dropped = id
  end
end
local other = redis.call('HGET', k, 'u:' .. uid)
if other == id then other = false end
if mode ~= 'explicit' then
  if held then redis.call('EXPIRE', k, ttl) return {held, 'same', ''} end
  if other then redis.call('EXPIRE', k, ttl) return {'', 'user_elsewhere', ''} end
end
for i = 8, #ARGV do
  local seat = ARGV[i]
  if mode == 'explicit' or not string.match(seat, '^seat_T%d%d_Y%d$') then
    local owner = redis.call('HGET', k, 's:' .. seat)
    if owner == id then redis.call('EXPIRE', k, ttl) return {seat, 'same', ''} end
    if not owner then
      local freed = ''
      if held then redis.call('HDEL', k, 's:' .. held) end
      if other then
        local os = redis.call('HGET', k, 'p:' .. other)
        if os then redis.call('HDEL', k, 's:' .. os) end
        redis.call('HDEL', k, 'p:' .. other)
        freed = other
      end
      redis.call('HSET', k, 's:' .. seat, id, 'p:' .. id, seat, 'u:' .. uid, id)
      spend()
      redis.call('EXPIRE', k, ttl)
      return {seat, 'ok', freed}
    end
    if mode == 'explicit' then redis.call('EXPIRE', k, ttl) return {'', 'taken', ''} end
  end
end
if dropped ~= '' then spend() end
redis.call('EXPIRE', k, ttl)
return {'', 'full', dropped}
`;

// The g: tombstone goes only into an existing seat hash: join hooks write only in a themed channel, so a channel with
// no hash (no theme) has no late join to stop and its leaves write nothing.
// TEMPORARY: in a themed channel every leave without j: (leave before join, and with games on also a gateway
// remove that beat the webhook) writes one 120 s g: field (HSET + HEXPIRE). Trigger: participant_left webhooks > 5 k/s
// or {voice_seats:*} KV memory > 2 GB. Path: carry LiveKit participant.joinedAt into the leave hook and skip the
// tombstone when the participant joined more than VOICE_MEMBERSHIP_HOOK_TIMEOUT_MS + 60 s ago (its join hook has run
// or been dropped by then).
const VOICE_SEAT_RELEASE_SCRIPT = `
local k, id, uid, gone = KEYS[1], ARGV[1], ARGV[2], tonumber(ARGV[3])
if redis.call('HDEL', k, 'j:' .. id) == 0 and gone > 0 and redis.call('EXISTS', k) == 1 then
  redis.call('HSET', k, 'g:' .. id, '1')
  redis.call('HEXPIRE', k, gone, 'FIELDS', 1, 'g:' .. id)
end
if redis.call('HGET', k, 'l:' .. uid) == id then redis.call('HDEL', k, 'l:' .. uid) end
local s = redis.call('HGET', k, 'p:' .. id)
if not s then return {'', ''} end
redis.call('HDEL', k, 's:' .. s, 'p:' .. id)
if redis.call('HGET', k, 'u:' .. uid) == id then redis.call('HDEL', k, 'u:' .. uid) end
local heir = redis.call('HGET', k, 'l:' .. uid)
if heir and redis.call('HEXISTS', k, 'j:' .. heir) == 1 and not redis.call('HGET', k, 'p:' .. heir) then
  redis.call('HSET', k, 's:' .. s, heir, 'p:' .. heir, s, 'u:' .. uid, heir)
  return {s, heir}
end
return {s, ''}
`;

// Repair of missing j: marks from a gateway voice-state read: per field HSETNX (an existing mark wins), never for a
// tombstoned identity; no l:, no seat. ARGV: ttl, then identity/value pairs (one chunk).
// Known race: a leave that lands between the gateway read and this script finds and drops the j:
// mark, so it writes no g:, and this script writes j: back for the gone connection (a ms window; the ghost-seat checks
// and room_finished clear it). Full fix: a join token nonce in the tombstone, or the gateway's `ignored` field.
const VOICE_SEAT_MARK_SCRIPT = `
local k, ttl = KEYS[1], tonumber(ARGV[1])
local written = 0
for i = 2, #ARGV, 2 do
  if redis.call('HEXISTS', k, 'g:' .. ARGV[i]) == 0 then
    written = written + redis.call('HSETNX', k, 'j:' .. ARGV[i], ARGV[i + 1])
  end
end
redis.call('EXPIRE', k, ttl)
return written
`;

// Holders of the given seats in one round trip (HMGET of s:<seat>); O(seats), not O(hash) like HGETALL would be in
// a channel with many members.
const VOICE_SEAT_HOLDERS_SCRIPT = `
local fields = {}
for i = 1, #ARGV do fields[i] = 's:' .. ARGV[i] end
return redis.call('HMGET', KEYS[1], unpack(fields))
`;

// The identity stays in the channel (it keeps j:) and loses its seat with no heir: leaving a table seat, or a stale
// table seat holder that blocks a new player.
const VOICE_SEAT_VACATE_SCRIPT = `
local k, id, uid, ttl = KEYS[1], ARGV[1], ARGV[2], tonumber(ARGV[3])
local s = redis.call('HGET', k, 'p:' .. id)
if not s then return '' end
redis.call('HDEL', k, 's:' .. s, 'p:' .. id)
if redis.call('HGET', k, 'u:' .. uid) == id then redis.call('HDEL', k, 'u:' .. uid) end
redis.call('EXPIRE', k, ttl)
return s
`;

function stringList(value: unknown, length: number): Array<string> {
	if (!Array.isArray(value) || value.length !== length || value.some((item) => typeof item !== 'string')) {
		throw new Error('Unexpected voice seat script result');
	}
	return value as Array<string>;
}

export class VoiceSeatRepository {
	constructor(readonly kvClient: IKVProvider) {}

	// limited: a REST request, under the channel's change budget (the hooks and the table service never are).
	async take(p: {
		channelId: ChannelID;
		identity: string;
		userId: UserID;
		mode: VoiceSeatTakeMode;
		joinValue?: string;
		limited?: boolean;
		seats: ReadonlyArray<string>;
	}): Promise<VoiceSeatTakeResult> {
		const [seat, status, freed] = stringList(
			await this.scriptable().evalScript(
				'voiceSeatTake',
				VOICE_SEAT_TAKE_SCRIPT,
				1,
				voiceSeatsKey(p.channelId),
				p.identity,
				p.userId.toString(),
				VOICE_SEAT_HASH_TTL_S,
				p.mode,
				p.joinValue ?? '',
				p.limited ? VOICE_SEAT_CHANNEL_CHANGES_PER_WINDOW : 0,
				VOICE_SEAT_CHANNEL_WINDOW_S * 1000,
				...p.seats,
			),
			3,
		);
		return {seat: seat || null, status: status as VoiceSeatTakeStatus, freed: freed || null};
	}

	// goneTtlS > 0 (the leave hook): an identity without j: gets the g: tombstone for that long.
	async release(p: {channelId: ChannelID; identity: string; userId: UserID; goneTtlS?: number}): Promise<{
		seat: string | null;
		heir: string | null;
	}> {
		const [seat, heir] = stringList(
			await this.scriptable().evalScript(
				'voiceSeatRelease',
				VOICE_SEAT_RELEASE_SCRIPT,
				1,
				voiceSeatsKey(p.channelId),
				p.identity,
				p.userId.toString(),
				p.goneTtlS ?? 0,
			),
			2,
		);
		return {seat: seat || null, heir: heir || null};
	}

	async vacate(p: {channelId: ChannelID; identity: string; userId: UserID}): Promise<string | null> {
		const seat = await this.scriptable().evalScript(
			'voiceSeatVacate',
			VOICE_SEAT_VACATE_SCRIPT,
			1,
			voiceSeatsKey(p.channelId),
			p.identity,
			p.userId.toString(),
			VOICE_SEAT_HASH_TTL_S,
		);
		return typeof seat === 'string' && seat.length > 0 ? seat : null;
	}

	async markPresent(
		channelId: ChannelID,
		marks: ReadonlyArray<{identity: string; value: string}>,
		signal?: AbortSignal,
	): Promise<void> {
		for (let i = 0; i < marks.length; i += VOICE_SEAT_MARK_CHUNK) {
			signal?.throwIfAborted();
			const chunk = marks.slice(i, i + VOICE_SEAT_MARK_CHUNK).flatMap((mark) => [mark.identity, mark.value]);
			await this.scriptable().evalScript(
				'voiceSeatMark',
				VOICE_SEAT_MARK_SCRIPT,
				1,
				voiceSeatsKey(channelId),
				VOICE_SEAT_HASH_TTL_S,
				...chunk,
			);
		}
	}

	seatOf(channelId: ChannelID, identity: string): Promise<string | null> {
		return this.kvClient.hget(voiceSeatsKey(channelId), `p:${identity}`);
	}

	async holdersOf(channelId: ChannelID, seats: ReadonlyArray<string>): Promise<Array<string | null>> {
		if (seats.length === 0) return [];
		const holders = await this.scriptable().evalScript(
			'voiceSeatHolders',
			VOICE_SEAT_HOLDERS_SCRIPT,
			1,
			voiceSeatsKey(channelId),
			...seats,
		);
		if (!Array.isArray(holders) || holders.length !== seats.length) {
			throw new Error('Unexpected voice seat script result');
		}
		return holders.map((holder) => (typeof holder === 'string' ? holder : null));
	}

	holderOf(channelId: ChannelID, seat: string): Promise<string | null> {
		return this.kvClient.hget(voiceSeatsKey(channelId), `s:${seat}`);
	}

	userIdentity(channelId: ChannelID, userId: UserID): Promise<string | null> {
		return this.kvClient.hget(voiceSeatsKey(channelId), `u:${userId}`);
	}

	joinMark(channelId: ChannelID, identity: string): Promise<string | null> {
		return this.kvClient.hget(voiceSeatsKey(channelId), `j:${identity}`);
	}

	// One O(1) HDEL: no seat, l: or tombstone change, and no key is created.
	async dropJoinMark(channelId: ChannelID, identity: string): Promise<void> {
		await this.kvClient.hdel(voiceSeatsKey(channelId), `j:${identity}`);
	}

	tryReconcileLock(channelId: ChannelID): Promise<boolean> {
		return this.kvClient.setnx(`${voiceSeatsKey(channelId)}:rc`, '1', VOICE_SEAT_RECONCILE_LOCK_S);
	}

	async deleteChannel(channelId: ChannelID): Promise<void> {
		const key = voiceSeatsKey(channelId);
		await this.kvClient.del(key, `${key}:rc`);
	}

	private scriptable(): ScriptableKVProvider {
		const kv = this.kvClient as Partial<ScriptableKVProvider>;
		if (typeof kv.evalScript !== 'function') {
			throw new Error('KV provider does not support scripts');
		}
		return kv as ScriptableKVProvider;
	}
}

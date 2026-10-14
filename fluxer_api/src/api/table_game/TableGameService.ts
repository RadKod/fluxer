// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {ChannelID, GuildID, UserID} from '@app/api/BrandedTypes';
import {createChannelID, createGuildID, createUserID} from '@app/api/BrandedTypes';
import type {IChannelDataRepository} from '@app/api/channel/repositories/IChannelDataRepository';
import type {ChannelAuthService} from '@app/api/channel/services/channel_data/ChannelAuthService';
import type {GatewayVoiceStateEntry, IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {Logger} from '@app/api/Logger';
import type {Channel} from '@app/api/models/Channel';
import {
	CryptoRng,
	type EngineClock,
	type TableGameEngine,
	TableGameRuleError,
	type TablePosition,
} from '@app/api/table_game/engine/TableGameEngine';
import {TABLE_GAME_ENGINES, type TableGameEngineRegistry} from '@app/api/table_game/TableGameEngines';
import {
	TABLE_GAME_CAS_ATTEMPTS,
	TABLE_GAME_DISPATCH_CONCURRENCY,
	TABLE_GAME_LIST_WAIT_ATTEMPTS,
	TABLE_GAME_LIST_WAIT_MS,
	TABLE_GAME_LOBBY_TIMEOUT_MS,
	TABLE_GAME_LOCK_SETTLE_S,
	TABLE_GAME_TIMER_BATCH,
	TABLE_GAME_TIMER_SHARD_CONCURRENCY,
	TABLE_GAME_TIMER_TICK_BUDGET_MS,
	TABLE_GAME_TTL_S,
	TABLE_GAME_USER_LOCK_TTL_S,
} from '@app/api/table_game/TableGameLimits';
import {
	parseTableGameMember,
	type TableEnvelope,
	type TableGameRepository,
	tableGameMember,
} from '@app/api/table_game/TableGameRepository';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import {entityTagMatches} from '@app/api/utils/EntityTag';
import {resolveEffectiveVoiceRoomTheme} from '@app/api/voice_seat/VoiceRoomTheme';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {
	TABLE_GAME_DISCONNECT_GRACE_MS,
	TABLE_GAME_PRESENCE_CHECK_MS,
	TABLE_GAME_SPECTATOR_LIMIT,
	TABLE_GAME_TIMER_SHARDS,
	TABLE_GAME_TURN_MS,
} from '@fluxer/constants/src/TableGameConstants';
import {tableSeatName, themeTableSlots} from '@fluxer/constants/src/VoiceRoomThemes';
import {InvalidChannelTypeError} from '@fluxer/errors/src/domains/channel/InvalidChannelTypeError';
import {FeatureTemporarilyDisabledError} from '@fluxer/errors/src/domains/core/FeatureTemporarilyDisabledError';
import {UserNotInVoiceError} from '@fluxer/errors/src/domains/user/UserNotInVoiceError';
import {TableGameConflictError} from '@fluxer/errors/src/domains/voice/TableGameConflictError';
import {TableGameRuleViolationError} from '@fluxer/errors/src/domains/voice/TableGameRuleViolationError';
import {UnknownTableGameError} from '@fluxer/errors/src/domains/voice/UnknownTableGameError';
import {resolveVoiceRoomAssignment} from '@fluxer/schema/src/domains/admin/VoiceRoomConfigSchemas';
import type {
	TableGameAction,
	TableGameKind,
	TableGameListResponse,
	TableGameSpectateResponse,
	TableGameSpeed,
	TableGameSummary,
	TableGameUpdateEvent,
	TableGameView,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

// What the table service needs from the voice seat service (A2): O(1) membership through the seat hash's j: mark, and
// moving a player's seat to the table and back to the lounge.
export interface TableGameVoiceSeats {
	membership(p: {
		guildId: GuildID;
		channelId: ChannelID;
		userId: UserID;
		connectionId: string;
	}): Promise<{regionId: string; serverId: string} | null>;
	seatAtTable(p: {
		userId: UserID;
		guildId: GuildID;
		channelId: ChannelID;
		slot: string;
		position: TablePosition;
		voiceStates: ReadonlyArray<GatewayVoiceStateEntry>;
	}): Promise<void>;
	leaveTableSeat(p: {
		userId: UserID;
		guildId: GuildID;
		channelId: ChannelID;
		voiceStates: ReadonlyArray<GatewayVoiceStateEntry> | null;
	}): Promise<void>;
}

export interface TableGameServiceDeps {
	repository: TableGameRepository;
	instanceConfigRepository: InstanceConfigRepository;
	channelAuthService: ChannelAuthService;
	gatewayService: IGatewayService;
	voiceSeatService: TableGameVoiceSeats;
	channelRepository: IChannelDataRepository; // the timer's theme read; no user is at hand there
	engines?: TableGameEngineRegistry;
}

interface TableRef {
	userId: UserID;
	channelId: ChannelID;
	slot: string;
}

interface Resolution {
	themeSlots: ReadonlyArray<string> | null; // null: the theme is unknown (games off on the timer, or a failed read)
	gamesEnabled: boolean;
	presenceCheck: boolean; // only the timer polls the gateway for missing players
}

const positionOf = (env: TableEnvelope, userId: string): TablePosition | null =>
	env.players.find((player) => player.user_id === userId)?.position ?? null;

// Timer score: the earliest moment the table needs the server without anyone acting.
function deadlineOf(env: TableEnvelope, engine: TableGameEngine<unknown>): number | null {
	if (env.status === 'ended') return null;
	if (env.status === 'lobby') return env.created_at + TABLE_GAME_LOBBY_TIMEOUT_MS;
	const candidates = Object.values(env.disconnected).map((since) => since + TABLE_GAME_DISCONNECT_GRACE_MS);
	const turn = engine.deadline(env.engine);
	if (turn !== null) candidates.push(turn);
	if (env.next_presence_check_at !== null) candidates.push(env.next_presence_check_at);
	return candidates.length === 0 ? null : Math.min(...candidates);
}

// A read and its ETag.
export interface TableGameRead<T> {
	body: T;
	etag: string;
}

const spectatorCountOf = (env: TableEnvelope, spectators: ReadonlyArray<string>) =>
	spectators.filter((userId) => positionOf(env, userId) === null).length;

// a table's tag names the table instance (its creation time), since a later table at the slot restarts at
// version 0 once the ended one's key is gone, plus everything else the view varies by. it comes from the envelope
// alone, so a revalidation never builds the view (no dama/tavla move search for a 304).
function tableTag(
	env: TableEnvelope,
	spectators: ReadonlyArray<string>,
	viewer: TablePosition | null,
	spectating: boolean,
): string {
	const tag = `${env.created_at}-${env.version}-${viewer ?? 's'}-${spectating ? 1 : 0}-${spectatorCountOf(env, spectators)}`;
	return `"tg-${tag}"`;
}

// The okey and tavla engines count consecutive timeouts per position in their state; chess and dama have none.
function timeoutsOf(state: unknown, position: TablePosition): number {
	const timeouts = (state as {timeouts?: ReadonlyArray<number>} | null)?.timeouts;
	return timeouts?.[position - 1] ?? 0;
}

export class TableGameService {
	private readonly engines: TableGameEngineRegistry;
	private readonly channels: IChannelDataRepository;

	constructor(readonly deps: TableGameServiceDeps) {
		this.engines = deps.engines ?? TABLE_GAME_ENGINES;
		this.channels = deps.channelRepository;
	}

	async list(p: {
		userId: UserID;
		channelId: ChannelID;
		connectionId?: string;
	}): Promise<TableGameRead<TableGameListResponse>> {
		const channel = await this.authorize(p, true);
		await this.requireMembership(p, channel, p.connectionId);
		return await this.cachedList(String(p.channelId), channel);
	}

	// one build per channel and second, whoever asks (single flight through a KV claim); the caller's checks above
	// are never cached. A reader that misses while another builds looks again a few times, then builds it itself.
	// TEMPORARY: each read still costs the channel permission check (Cassandra channel row + member), a j: HGET
	// and a cache GET, and a seat change sends the whole room to read. Trigger: TABLE_GAME_READ p99 > 100 ms or one
	// channel over 5k list reads/s. Path: the server writes the table summaries to the LiveKit room (as it does the seat
	// attribute), so the room reads no list at all.
	private async cachedList(channelId: string, channel: Channel): Promise<TableGameRead<TableGameListResponse>> {
		const slots = await this.slotsOf(channel);
		for (let attempt = 0; ; attempt++) {
			const cached = await this.repository.readListCache(channelId);
			if (cached !== null) {
				const read = JSON.parse(cached) as TableGameRead<TableGameListResponse> & {themeSlots?: ReadonlyArray<string>};
				if (JSON.stringify(read.themeSlots) === JSON.stringify(slots)) return {body: read.body, etag: read.etag};
			}
			if (attempt === TABLE_GAME_LIST_WAIT_ATTEMPTS || (await this.repository.claimListBuild(channelId))) break;
			await delay(TABLE_GAME_LIST_WAIT_MS);
		}
		const loaded = await Promise.all(slots.map((slot) => this.repository.load(channelId, slot)));
		const tables = loaded.filter((env) => env !== null);
		const body = {
			tables: await Promise.all(tables.map(async (env) => this.summarize(env, await this.spectatorsOf(env)))),
		};
		// CR3: the tables' creation times join the content, so a new table equal to an old one still gets a new tag.
		const instances = tables.map((env) => env.created_at);
		const hash = createHash('sha256')
			.update(JSON.stringify([body, instances]))
			.digest('hex')
			.slice(0, 32);
		const read = {body, etag: `"tgl-${hash}"`};
		await this.repository.writeListCache(channelId, JSON.stringify({...read, themeSlots: slots}));
		return read;
	}

	// Players read their own table; anyone else needs a watch ticket or a voice connection in the channel.
	// body null: the caller's If-None-Match matched the tag (304), and no view was built.
	async get(p: TableRef & {connectionId?: string; ifNoneMatch?: string}): Promise<TableGameRead<TableGameView | null>> {
		const channel = await this.authorize(p, true);
		const env = await this.requireTable(p);
		const userId = String(p.userId);
		const position = positionOf(env, userId);
		if (position === null && !(await this.repository.hasWatchTicket(env.channel_id, env.slot, userId))) {
			await this.requireMembership(p, channel, p.connectionId);
			await this.repository.issueWatchTicket(env.channel_id, env.slot, userId);
		}
		const spectators = await this.spectatorsOf(env);
		const spectating = position === null && spectators.includes(userId);
		const etag = tableTag(env, spectators, position, spectating);
		if (p.ifNoneMatch !== undefined && entityTagMatches(p.ifNoneMatch, etag)) return {etag, body: null};
		return {etag, body: this.viewOf(env, spectators, position, spectating)};
	}

	async create(
		p: TableRef & {game: TableGameKind; speed: TableGameSpeed; connectionId: string},
	): Promise<TableGameView> {
		const channel = await this.authorize(p, true);
		if (!(await this.slotsOf(channel)).includes(p.slot)) throw new UnknownTableGameError();
		const voiceState = await this.requireMembership(p, channel, p.connectionId);
		const channelId = String(p.channelId);
		const userId = String(p.userId);
		const existing = await this.repository.load(channelId, p.slot);
		if (existing && existing.status !== 'ended') throw new TableGameConflictError();
		const lock = tableGameMember(channelId, p.slot);
		await this.lockPlayer(userId, lock);
		await this.repository.clearSpectators(channelId, p.slot); // CR6: watchers of the table before are not this one's
		const env: TableEnvelope = {
			v: 1,
			version: existing ? existing.version + 1 : 0,
			guild_id: String(channel.guildId),
			channel_id: channelId,
			slot: p.slot,
			game: p.game,
			speed: p.speed,
			status: 'lobby',
			players: [{position: 1, user_id: userId}],
			disconnected: {},
			next_presence_check_at: null,
			created_at: Date.now(),
			ended_at: null,
			result: null,
			engine: null,
		};
		// an ended table is replaced in place (CAS on its version); an empty slot is created (-1).
		if (!(await this.repository.cas(env, existing ? existing.version : null, TABLE_GAME_TTL_S.lobby))) {
			await this.repository.unlockUser(userId, lock);
			throw new TableGameConflictError();
		}
		await this.afterWrite(null, env);
		await this.seatAtTable(env, userId, 1, voiceState);
		return this.viewOf(env, await this.spectatorsOf(env), 1, false);
	}

	async join(p: TableRef & {position: number; connectionId: string}): Promise<TableGameView> {
		const channel = await this.authorize(p, true);
		if (!(await this.slotsOf(channel)).includes(p.slot)) throw new UnknownTableGameError();
		const voiceState = await this.requireMembership(p, channel, p.connectionId);
		const userId = String(p.userId);
		const env = await this.requireTable(p);
		const engine = this.engines[env.game];
		const position = p.position as TablePosition;
		if (
			env.status !== 'lobby' ||
			!engine.positions.includes(position) ||
			env.players.some((player) => player.position === position || player.user_id === userId)
		) {
			throw new TableGameConflictError();
		}
		const lock = tableGameMember(env.channel_id, env.slot);
		await this.lockPlayer(userId, lock);
		const players = [...env.players, {position, user_id: userId}].sort((a, b) => a.position - b.position);
		let next: TableEnvelope = {...env, version: env.version + 1, players};
		if (players.length === engine.positions.length) next = this.startGame(next, engine);
		if (!(await this.repository.cas(next, env.version, TABLE_GAME_TTL_S[next.status]))) {
			await this.repository.unlockUser(userId, lock); // a lost CAS gives the lock back
			throw new TableGameConflictError();
		}
		await this.afterWrite(env, next);
		await this.seatAtTable(next, userId, position, voiceState);
		return this.viewOf(next, await this.spectatorsOf(next), position, false);
	}

	// standing up from a running game loses it at once; from a lobby it only frees the position.
	async leave(p: TableRef): Promise<void> {
		await this.authorize(p, false);
		const userId = String(p.userId);
		const now = Date.now();
		const written = await this.update(String(p.channelId), p.slot, (env) => {
			const position = positionOf(env, userId);
			if (position === null) throw new TableGameConflictError();
			if (env.status === 'ended') return env;
			if (env.status === 'lobby') return this.removeFromLobby(env, position, now);
			return this.withEngineState(env, this.engines[env.game].forfeit(env.engine, position, 'leave'), now);
		});
		if (written === null) throw new UnknownTableGameError();
	}

	// A move settles whatever is due first (theme, disconnects, the turn clock) in the same CAS; a tick only settles.
	async act(p: TableRef & {version: number; action: TableGameAction}): Promise<TableGameView> {
		const channel = await this.authorize(p, false);
		const userId = String(p.userId);
		const resolution: Resolution = {themeSlots: await this.slotsOf(channel), gamesEnabled: true, presenceCheck: false};
		let refused: TableGameRuleError | null = null;
		let position: TablePosition | null = null;
		const written = await this.update(String(p.channelId), p.slot, async (env) => {
			refused = null;
			position = positionOf(env, userId);
			if (position === null) throw new TableGameConflictError(); // spectators never act, not even tick
			const now = Date.now();
			const resolved = await this.resolveDue(env, now, resolution);
			if (p.action.type === 'tick') return resolved;
			if (p.version !== env.version || env.status === 'lobby') throw new TableGameConflictError();
			try {
				if (resolved.status !== 'playing') throw new TableGameRuleError('game_over');
				const engine = this.engines[env.game];
				const state = engine.apply(resolved.engine, position, p.action, CryptoRng, this.clockOf(resolved, now));
				return this.withEngineState(resolved, state, now);
			} catch (error) {
				if (!(error instanceof TableGameRuleError)) throw error;
				if (resolved === env) throw new TableGameRuleViolationError(error.reason);
				refused = error; // the clock ran out before this action: keep the settled turn, refuse the action
				return resolved;
			}
		});
		if (written === null) throw new UnknownTableGameError();
		const rule = refused as TableGameRuleError | null;
		if (rule !== null) throw new TableGameRuleViolationError(rule.reason);
		return this.viewOf(written.after, await this.spectatorsOf(written.after), position, false);
	}

	// up to 50 live spectators; past that `subscribed` is false and the caller polls with its watch ticket.
	async spectate(p: TableRef & {connectionId: string}): Promise<TableGameSpectateResponse> {
		const channel = await this.authorize(p, true);
		await this.requireMembership(p, channel, p.connectionId);
		const env = await this.requireTable(p);
		const userId = String(p.userId);
		if (positionOf(env, userId) !== null) throw new TableGameConflictError();
		await this.repository.issueWatchTicket(env.channel_id, env.slot, userId);
		const watch = tableGameMember(env.channel_id, env.slot);
		const previous = await this.repository.readSpectatorLock(userId);
		const previousRef = previous !== null && previous !== watch ? parseTableGameMember(previous) : null;
		if (previousRef) await this.repository.removeSpectator(previousRef.channelId, previousRef.slot, userId);
		const ttl = TABLE_GAME_TTL_S[env.status];
		const subscribed = await this.repository.spectate(
			env.channel_id,
			env.slot,
			userId,
			TABLE_GAME_SPECTATOR_LIMIT,
			ttl,
		);
		if (subscribed) await this.repository.setSpectatorLock(userId, watch, ttl);
		else if (previousRef) await this.repository.unlockSpectator(userId, previous!);
		return {subscribed, view: this.viewOf(env, await this.spectatorsOf(env), null, subscribed)};
	}

	async unspectate(p: TableRef): Promise<void> {
		await this.authorize(p, false);
		const userId = String(p.userId);
		await this.repository.removeSpectator(String(p.channelId), p.slot, userId);
		await this.repository.unlockSpectator(userId, tableGameMember(String(p.channelId), p.slot));
	}

	// The voice hooks never throw (VoiceMembershipHooks swallows); each touches only this user's table.
	async onVoiceJoined(p: {userId: UserID; guildId: GuildID; channelId: ChannelID}): Promise<void> {
		const ref = await this.activeTableRef(String(p.userId), String(p.channelId));
		if (!ref) return;
		await this.update(ref.channelId, ref.slot, (env) => {
			const position = positionOf(env, String(p.userId));
			if (position === null || env.status !== 'playing' || env.disconnected[position] === undefined) return env;
			const disconnected = {...env.disconnected};
			delete disconnected[position];
			return {...env, disconnected};
		});
	}

	// leaving voice is a disconnect with 30 s grace in a game, standing up in a lobby. nothing happens while
	// another connection of the same user is still in the channel (a second device, or a remove that came late).
	async onVoiceLeft(p: {userId: UserID; guildId: GuildID; channelId: ChannelID}): Promise<void> {
		if (!(await this.gamesEnabled())) return;
		const userId = String(p.userId);
		const channelId = String(p.channelId);
		const watching = await this.repository.readSpectatorLock(userId);
		const watchRef = watching === null ? null : parseTableGameMember(watching);
		if (watchRef?.channelId === channelId) {
			await this.repository.removeSpectator(channelId, watchRef.slot, userId);
			await this.repository.unlockSpectator(userId, watching!);
		}
		const ref = await this.activeTableRef(userId, channelId);
		if (!ref) return;
		const table = await this.repository.load(channelId, ref.slot);
		if (!table || table.status === 'ended' || positionOf(table, userId) === null) return;
		if ((await this.presentUsers(table))?.has(userId)) return;
		const now = Date.now();
		await this.update(channelId, ref.slot, (env) => {
			const position = positionOf(env, userId);
			if (position === null || env.status === 'ended') return env;
			if (env.status === 'lobby') return this.removeFromLobby(env, position, now);
			if (env.disconnected[position] !== undefined) return env;
			return {...env, disconnected: {...env.disconnected, [position]: now}};
		});
	}

	async tableSeatFor(p: {userId: UserID; channelId: ChannelID}): Promise<string | null> {
		const ref = await this.activeTableRef(String(p.userId), String(p.channelId));
		if (!ref) return null;
		const env = await this.repository.load(ref.channelId, ref.slot);
		const position = env && env.status !== 'ended' ? positionOf(env, String(p.userId)) : null;
		return position === null ? null : tableSeatName(ref.slot, position);
	}

	// The batch lane cron, every second: 16 shards, a 30 s lease each (released when done), at most 200 due tables per
	// shard and an 800 ms budget per tick. While games are off it walks every table, due or not, to cancel it.
	async processDueTimers(now: number): Promise<{processed: number; durationMs: number}> {
		const started = Date.now();
		const gamesEnabled = await this.gamesEnabled();
		let processed = 0;
		const shards = Array.from({length: TABLE_GAME_TIMER_SHARDS}, (_, shard) => shard);
		await mapWithConcurrency(shards, TABLE_GAME_TIMER_SHARD_CONCURRENCY, async (shard) => {
			const token = randomUUID();
			if (!(await this.repository.acquireTimerLease(shard, token))) return;
			try {
				const due = await this.repository.dueTimers(shard, gamesEnabled ? now : '+inf', TABLE_GAME_TIMER_BATCH);
				for (const member of due) {
					if (Date.now() - started >= TABLE_GAME_TIMER_TICK_BUDGET_MS) break;
					await this.settleMember(member, now, gamesEnabled);
					processed++;
				}
			} finally {
				await this.repository.releaseTimerLease(shard, token);
			}
		});
		return {processed, durationMs: Date.now() - started};
	}

	private async settleMember(member: string, now: number, gamesEnabled: boolean): Promise<void> {
		const ref = parseTableGameMember(member);
		if (!ref) return;
		try {
			const themeSlots = gamesEnabled ? await this.channelTableSlots(ref.channelId) : null;
			const written = await this.update(ref.channelId, ref.slot, (env) =>
				this.resolveDue(env, now, {themeSlots, gamesEnabled, presenceCheck: true}),
			);
			if (written === null) {
				await this.repository.scheduleTimer(ref.channelId, ref.slot, null);
			} else if (written.after === written.before) {
				// Nothing was due after all: an out of order score write left this member early (or it already ended).
				const engine = this.engines[written.after.game];
				await this.repository.scheduleTimer(ref.channelId, ref.slot, deadlineOf(written.after, engine));
			}
		} catch (error) {
			Logger.warn(
				{channelId: ref.channelId, slot: ref.slot, error: error instanceof Error ? error.message : 'unknown'},
				'Table game timer could not settle a table',
			);
		}
	}

	private async slotsOf(channel: Channel): Promise<ReadonlyArray<string>> {
		const config = await this.deps.instanceConfigRepository.getVoiceRoomConfig();
		const theme = resolveEffectiveVoiceRoomTheme(channel.roomTheme, config, channel.type);
		return theme === null ? [] : themeTableSlots(theme);
	}

	// a due table whose slot left the channel theme (or whose channel is gone) is canceled by the timer too. A failed
	// read leaves the theme for the next time and still settles the rest.
	// TEMPORARY: one Cassandra channel read per due table (turns, graces, presence checks, lobby deadlines; ~5k/s
	// at 150k tables). Trigger: these reads > 2k/s or a timer tick over 500 ms. Path: a per-channel theme cache in KV
	// dropped on CHANNEL_UPDATE (shared with the voice join hook), or cancel the slot's tables where the theme
	// changes (ChannelOperationsService) so the timer needs no read.
	private async channelTableSlots(channelId: string): Promise<ReadonlyArray<string> | null> {
		try {
			const channel = await this.channels.findUnique(createChannelID(BigInt(channelId)));
			return channel === null ? [] : await this.slotsOf(channel);
		} catch {
			Logger.warn({channelId}, 'Table game timer could not read the channel theme');
			return null;
		}
	}

	// The one settlement path for timers, ticks and moves: theme, switch, lobby deadline, presence, disconnect grace,
	// turn clock.
	private async resolveDue(env: TableEnvelope, now: number, how: Resolution): Promise<TableEnvelope> {
		if (env.status === 'ended') return env;
		if (how.themeSlots !== null && !how.themeSlots.includes(env.slot)) return this.cancel(env, 'theme_changed', now);
		if (!how.gamesEnabled) return this.cancel(env, 'disabled', now);
		if (env.status === 'lobby') {
			return now >= env.created_at + TABLE_GAME_LOBBY_TIMEOUT_MS ? this.cancel(env, 'abandoned', now) : env;
		}
		const engine = this.engines[env.game];
		let present: Set<string> | null | undefined;
		const presentUsers = async () => {
			if (present === undefined) present = await this.presentUsers(env);
			return present;
		};
		let next = env;
		// The timer's presence check of a playing table, once a minute: it catches leave hooks that never came.
		// TEMPORARY: one getVoiceStatesForChannel per playing table a minute, its cost growing with the channel
		// (150k tables ≈ 2.5k RPC/s). Trigger: this RPC over 5k/s or p99 > 50 ms. Path: only the webhook/RPC leave hooks
		// plus the turn timer, with no poll.
		if (
			how.presenceCheck &&
			env.next_presence_check_at !== null &&
			env.next_presence_check_at <= now &&
			(await this.repository.acquirePresenceCheck(env.channel_id, env.slot))
		) {
			const users = await presentUsers();
			if (users !== null) {
				const disconnected = {...env.disconnected};
				for (const player of env.players) {
					if (users.has(player.user_id)) delete disconnected[player.position];
					else disconnected[player.position] ??= now;
				}
				next = {...next, disconnected, next_presence_check_at: now + TABLE_GAME_PRESENCE_CHECK_MS};
			}
		}
		for (const player of next.players) {
			const since = next.disconnected[player.position];
			if (since === undefined || since + TABLE_GAME_DISCONNECT_GRACE_MS > now) continue;
			const users = await presentUsers(); // the grace ends only for someone really gone
			if (users === null) continue;
			if (!users.has(player.user_id)) {
				return this.withEngineState(next, engine.forfeit(next.engine, player.position, 'disconnect'), now);
			}
			const disconnected = {...next.disconnected};
			delete disconnected[player.position];
			next = {...next, disconnected};
		}
		const deadline = engine.deadline(next.engine);
		if (deadline !== null && deadline <= now) {
			next = this.withEngineState(next, engine.onDeadline(next.engine, CryptoRng, this.clockOf(next, now)), now);
		}
		return next;
	}

	// Load, change, compare-and-set; up to 3 reads. `change` returns its input untouched for "nothing to write".
	private async update(
		channelId: string,
		slot: string,
		change: (env: TableEnvelope) => TableEnvelope | Promise<TableEnvelope>,
	): Promise<{before: TableEnvelope; after: TableEnvelope} | null> {
		for (let attempt = 0; attempt < TABLE_GAME_CAS_ATTEMPTS; attempt++) {
			const before = await this.repository.load(channelId, slot);
			if (before === null) return null;
			const changed = await change(before);
			if (changed === before) return {before, after: before};
			const after = {...changed, version: before.version + 1};
			if (await this.repository.cas(after, before.version, TABLE_GAME_TTL_S[after.status])) {
				await this.afterWrite(before, after);
				return {before, after};
			}
		}
		throw new TableGameConflictError();
	}

	// After every successful write: the timer score, released players, then TABLE_GAME_UPDATE before the HTTP answer.
	private async afterWrite(before: TableEnvelope | null, after: TableEnvelope): Promise<void> {
		const engine = this.engines[after.game];
		await this.repository.scheduleTimer(after.channel_id, after.slot, deadlineOf(after, engine));
		let released: ReadonlyArray<{user_id: string}> = [];
		if (before !== null && before.status !== 'ended') {
			released =
				after.status === 'ended'
					? after.players
					: before.players.filter((player) => positionOf(after, player.user_id) === null);
		}
		await Promise.all(released.map((player) => this.releasePlayer(after, player.user_id)));
		const spectators = await this.spectatorsOf(after);
		await this.dispatch(after, released, spectators);
		await this.settleSpectators(before, after, spectators);
	}

	// the spectator set and its members' locks live as long as the table. A start renews them to the playing
	// lifetime, and so does every 20th write of a playing table (a long tavla game outlives one playing TTL, while
	// 20 writes always fit in it); an end, once its last event is out, drops the set and frees the locks still pointing
	// here.
	private async settleSpectators(
		before: TableEnvelope | null,
		after: TableEnvelope,
		spectators: ReadonlyArray<string>,
	): Promise<void> {
		if (before === null) return;
		if (before.status === after.status) {
			if (after.status === 'playing' && after.version % 20 === 0) {
				await this.repository.renewSpectators(after.channel_id, after.slot, spectators, TABLE_GAME_TTL_S.playing);
			}
			return;
		}
		if (after.status !== 'ended') {
			await this.repository.renewSpectators(after.channel_id, after.slot, spectators, TABLE_GAME_TTL_S[after.status]);
			return;
		}
		await this.repository.clearSpectators(after.channel_id, after.slot);
		const watch = tableGameMember(after.channel_id, after.slot);
		await Promise.all(spectators.map((userId) => this.repository.unlockSpectator(userId, watch)));
	}

	private async releasePlayer(env: TableEnvelope, userId: string): Promise<void> {
		await this.repository.unlockUser(userId, tableGameMember(env.channel_id, env.slot));
		await this.callSeats('leaveTableSeat', env, () =>
			this.deps.voiceSeatService.leaveTableSeat({
				userId: createUserID(BigInt(userId)),
				guildId: createGuildID(BigInt(env.guild_id)),
				channelId: createChannelID(BigInt(env.channel_id)),
				voiceStates: null,
			}),
		);
	}

	// one event per recipient with that recipient's view; players ∪ (spectators − players), plus players who
	// just left. Failures are swallowed per recipient; nothing of the table goes to the log.
	// TEMPORARY: one presence.dispatch RPC per recipient per move (players + up to 50 spectators). Trigger:
	// presence.dispatch over 200k/s or p99 > 100 ms. Path: a multi-recipient dispatch RPC in the gateway (Erlang, an
	// upstream candidate) taking the per-recipient views in one call.
	private async dispatch(
		env: TableEnvelope,
		leavers: ReadonlyArray<{user_id: string}>,
		spectators: ReadonlyArray<string>,
	): Promise<void> {
		const recipients = new Map<string, {position: TablePosition | null; spectating: boolean}>();
		for (const player of env.players) recipients.set(player.user_id, {position: player.position, spectating: false});
		for (const leaver of leavers) {
			if (!recipients.has(leaver.user_id)) recipients.set(leaver.user_id, {position: null, spectating: false});
		}
		for (const userId of spectators) {
			if (!recipients.has(userId)) recipients.set(userId, {position: null, spectating: true});
		}
		const summary = this.summarize(env, spectators);
		const engine = this.engines[env.game];
		const publicView = env.engine === null ? null : engine.view(env.engine, null);
		await mapWithConcurrency([...recipients], TABLE_GAME_DISPATCH_CONCURRENCY, async ([userId, viewer]) => {
			const gameView =
				viewer.position === null || env.engine === null ? publicView : engine.view(env.engine, viewer.position);
			const event: TableGameUpdateEvent = {
				channel_id: env.channel_id,
				guild_id: env.guild_id,
				slot: env.slot,
				view: {summary, game_view: gameView, viewer_position: viewer.position, spectating: viewer.spectating},
			};
			try {
				await this.deps.gatewayService.dispatchPresence({
					userId: createUserID(BigInt(userId)),
					event: 'TABLE_GAME_UPDATE',
					data: event,
				});
			} catch {
				Logger.debug({channelId: env.channel_id, slot: env.slot, recipient: userId}, 'Table game update not delivered');
			}
		});
	}

	private viewOf(
		env: TableEnvelope,
		spectators: ReadonlyArray<string>,
		position: TablePosition | null,
		spectating: boolean,
	): TableGameView {
		return {
			summary: this.summarize(env, spectators),
			game_view: env.engine === null ? null : this.engines[env.game].view(env.engine, position),
			viewer_position: position,
			spectating,
		};
	}

	private summarize(env: TableEnvelope, spectators: ReadonlyArray<string>): TableGameSummary {
		return {
			slot: env.slot,
			game: env.game,
			speed: env.speed,
			status: env.status,
			players: env.players.map((player) => ({
				position: player.position,
				user_id: player.user_id,
				connected: env.disconnected[player.position] === undefined,
				timeouts: timeoutsOf(env.engine, player.position),
			})),
			spectator_count: spectatorCountOf(env, spectators),
			version: env.version,
			result: env.result,
		};
	}

	private startGame(env: TableEnvelope, engine: TableGameEngine<unknown>): TableEnvelope {
		const now = Date.now();
		const positions = env.players.map((player) => player.position);
		return {
			...env,
			status: 'playing',
			engine: engine.start(positions, CryptoRng, this.clockOf(env, now)),
			next_presence_check_at: now + TABLE_GAME_PRESENCE_CHECK_MS,
		};
	}

	private withEngineState(env: TableEnvelope, state: unknown, now: number): TableEnvelope {
		const result = this.engines[env.game].result(state);
		if (result === null) return {...env, engine: state};
		return {...env, engine: state, status: 'ended', ended_at: now, result};
	}

	private cancel(env: TableEnvelope, reason: 'disabled' | 'theme_changed' | 'abandoned', now: number): TableEnvelope {
		if (env.engine === null) return {...env, status: 'ended', ended_at: now, result: {kind: 'canceled', reason}};
		return this.withEngineState(env, this.engines[env.game].cancel(env.engine, reason), now);
	}

	// The last one out ends the lobby; it stays listed so the end path frees its lock and seat.
	private removeFromLobby(env: TableEnvelope, position: TablePosition, now: number): TableEnvelope {
		const players = env.players.filter((player) => player.position !== position);
		return players.length === 0 ? this.cancel(env, 'abandoned', now) : {...env, players};
	}

	private clockOf(env: TableEnvelope, now: number): EngineClock {
		return {now, turnMs: TABLE_GAME_TURN_MS[env.game][env.speed]};
	}

	// a lock is stale when its table is gone, ended or no longer lists the user; a young lock is never stale, since
	// its own create or join may not have written the table yet. Replacing it is unlock(old value) + SET NX.
	private async lockPlayer(userId: string, value: string): Promise<void> {
		if (await this.repository.lockUser(userId, value)) return;
		const held = await this.repository.readUserLock(userId);
		if (held !== null) {
			if (!(await this.isStaleLock(userId, held))) throw new TableGameConflictError();
			await this.repository.unlockUser(userId, held);
		}
		if (!(await this.repository.lockUser(userId, value))) throw new TableGameConflictError();
	}

	private async isStaleLock(userId: string, held: string): Promise<boolean> {
		if ((await this.repository.userLockTtl(userId)) > TABLE_GAME_USER_LOCK_TTL_S - TABLE_GAME_LOCK_SETTLE_S) {
			return false;
		}
		const ref = parseTableGameMember(held);
		if (!ref) return true;
		const env = await this.repository.load(ref.channelId, ref.slot);
		return env === null || env.status === 'ended' || positionOf(env, userId) === null;
	}

	private async activeTableRef(userId: string, channelId: string) {
		const held = await this.repository.readUserLock(userId);
		const ref = held === null ? null : parseTableGameMember(held);
		return ref?.channelId === channelId ? ref : null;
	}

	private async presentUsers(env: TableEnvelope): Promise<Set<string> | null> {
		try {
			const {voiceStates} = await this.deps.gatewayService.getVoiceStatesForChannel({
				guildId: createGuildID(BigInt(env.guild_id)),
				channelId: createChannelID(BigInt(env.channel_id)),
			});
			return new Set(voiceStates.map((state) => state.userId));
		} catch {
			Logger.warn({channelId: env.channel_id, slot: env.slot}, 'Table game presence check failed');
			return null;
		}
	}

	private async seatAtTable(
		env: TableEnvelope,
		userId: string,
		position: TablePosition,
		voiceState: GatewayVoiceStateEntry,
	): Promise<void> {
		await this.callSeats('seatAtTable', env, () =>
			this.deps.voiceSeatService.seatAtTable({
				userId: createUserID(BigInt(userId)),
				guildId: createGuildID(BigInt(env.guild_id)),
				channelId: createChannelID(BigInt(env.channel_id)),
				slot: env.slot,
				position,
				voiceStates: [voiceState],
			}),
		);
	}

	// The seat is how the room shows the table; the table itself is already written, so a seat failure only logs.
	private async callSeats(what: string, env: TableEnvelope, call: () => Promise<void>): Promise<void> {
		try {
			await call();
		} catch (error) {
			Logger.warn(
				{channelId: env.channel_id, slot: env.slot, error: error instanceof Error ? error.message : 'unknown'},
				`Table game ${what} failed`,
			);
		}
	}

	private async spectatorsOf(env: TableEnvelope): Promise<Array<string>> {
		return await this.repository.listSpectators(env.channel_id, env.slot);
	}

	private async requireTable(p: TableRef): Promise<TableEnvelope> {
		const env = await this.repository.load(String(p.channelId), p.slot);
		if (env === null) throw new UnknownTableGameError();
		return env;
	}

	// the caller's own connection, checked through the seat hash (no gateway call while its j: mark is there).
	private async requireMembership(
		p: {userId: UserID; channelId: ChannelID},
		channel: Channel,
		connectionId: string | undefined,
	): Promise<GatewayVoiceStateEntry> {
		if (connectionId === undefined || channel.guildId === null) throw new UserNotInVoiceError();
		const member = await this.deps.voiceSeatService.membership({
			guildId: channel.guildId,
			channelId: p.channelId,
			userId: p.userId,
			connectionId,
		});
		if (member === null) throw new UserNotInVoiceError();
		return {
			connectionId,
			userId: String(p.userId),
			channelId: String(p.channelId),
			regionId: member.regionId,
			serverId: member.serverId,
		};
	}

	private async gamesEnabled(): Promise<boolean> {
		return resolveVoiceRoomAssignment(await this.deps.instanceConfigRepository.getVoiceRoomConfig()).games;
	}

	// Switch first (games need rooms; read from memory), then VIEW_CHANNEL (inside getChannelAuthenticated) and a guild
	// voice channel on every route; CONNECT for create, join, spectate and the reads.
	private async authorize(p: {userId: UserID; channelId: ChannelID}, connect: boolean): Promise<Channel> {
		if (!(await this.gamesEnabled())) throw new FeatureTemporarilyDisabledError();
		const auth = await this.deps.channelAuthService.getChannelAuthenticated({
			viewer: {kind: 'user', userId: p.userId, bot: false, capable: false},
			userId: p.userId,
			channelId: p.channelId,
		});
		if (auth.channel.type !== ChannelTypes.GUILD_VOICE) throw new InvalidChannelTypeError();
		if (connect) await auth.checkPermission(Permissions.CONNECT);
		return auth.channel;
	}

	private get repository(): TableGameRepository {
		return this.deps.repository;
	}
}

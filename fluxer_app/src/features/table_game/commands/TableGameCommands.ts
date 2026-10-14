// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import Authentication from '@app/features/auth/state/Authentication';
import {http} from '@app/features/platform/transport/RestTransport';
import {HttpError} from '@app/features/platform/types/EndpointError';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {failureCode, replyCode} from '@app/features/platform/utils/ResponseInspection';
import {actionSound, holdOwnActionEcho} from '@app/features/table_game/sound/TableGameSounds';
import TableGames from '@app/features/table_game/state/TableGames';
import {
	TABLE_GAME_LIST_DEBOUNCE_MS,
	TABLE_GAME_LIST_MIN_INTERVAL_MS,
	TABLE_GAME_LIST_SPREAD_MAX_MS,
	TABLE_GAME_LIST_SPREAD_MS_PER_PERSON,
	TABLE_GAME_OVERFLOW_POLL_MS,
} from '@app/features/table_game/state/TableGameTiming';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {
	type TableGameAction,
	type TableGameKind,
	type TableGameListResponse,
	TableGameRuleReason,
	type TableGameSpectateResponse,
	type TableGameSpeed,
	type TableGameView,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {compareShallow, type IReactionDisposer, reaction} from 'mobx';

const logger = new Logger('TableGameCommands');

export type TableGameError = 'conflict' | 'rule' | 'not_in_voice' | 'disabled' | 'unknown_table' | 'failed';
export type TableGameOutcome = {ok: true} | {ok: false; error: TableGameError; reason?: TableGameRuleReason};

const OK: TableGameOutcome = {ok: true};

const listTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastListAt = new Map<string, number>();
const pollTimers = new Map<string, ReturnType<typeof setInterval>>();
const etags = new Map<string, string>();
let voiceLeaveDisposer: IReactionDisposer | null = null;

function tableKey(channelId: string, slot: string): string {
	return `${channelId}:${slot}`;
}

// The server checks membership by this connection; a client not connected to the channel has nothing to show.
function myConnectionId(channelId: string): string | null {
	return MediaEngine.channelId === channelId ? MediaEngine.connectionId : null;
}

function failure(error: unknown): TableGameOutcome {
	const code = failureCode(error);
	if (code === APIErrorCodes.TABLE_GAME_RULE_VIOLATION) {
		const body = error instanceof HttpError ? (error.body as {reason?: unknown} | null) : null;
		const reason = TableGameRuleReason.safeParse(body?.reason);
		return reason.success ? {ok: false, error: 'rule', reason: reason.data} : {ok: false, error: 'rule'};
	}
	if (code === APIErrorCodes.TABLE_GAME_CONFLICT) return {ok: false, error: 'conflict'};
	if (code === APIErrorCodes.USER_NOT_IN_VOICE) return {ok: false, error: 'not_in_voice'};
	if (code === APIErrorCodes.FEATURE_TEMPORARILY_DISABLED) return {ok: false, error: 'disabled'};
	if (code === APIErrorCodes.UNKNOWN_TABLE_GAME) return {ok: false, error: 'unknown_table'};
	return {ok: false, error: 'failed'};
}

async function send(
	description: string,
	request: () => Promise<{body: TableGameView}>,
	channelId: string,
): Promise<TableGameOutcome> {
	try {
		const {body} = await request();
		TableGames.handleView(channelId, body, 'rest');
		return OK;
	} catch (error) {
		logger.warn(`Table game ${description} failed`, error);
		return failure(error);
	}
}

async function fetchList(channelId: string): Promise<void> {
	const connectionId = myConnectionId(channelId);
	if (!connectionId) return;
	lastListAt.set(channelId, Date.now());
	try {
		const {body} = await http.get<TableGameListResponse>(Endpoints.CHANNEL_TABLE_GAMES(channelId), {
			query: {connection_id: connectionId},
		});
		TableGames.handleList(channelId, body.tables);
	} catch (error) {
		logger.warn('Failed to load the table list', error);
	}
}

// Every list read goes through here: a pending read absorbs later requests, and reads are 10 s apart at least.
function scheduleList(channelId: string, delayMs: number): Promise<void> {
	if (listTimers.has(channelId) || !myConnectionId(channelId)) return Promise.resolve();
	const last = lastListAt.get(channelId);
	const now = Date.now();
	const wait = Math.max(delayMs, last === undefined ? 0 : last + TABLE_GAME_LIST_MIN_INTERVAL_MS - now);
	if (wait <= 0) return fetchList(channelId);
	listTimers.set(
		channelId,
		setTimeout(() => {
			listTimers.delete(channelId);
			void fetchList(channelId);
		}, wait),
	);
	return Promise.resolve();
}

// Room opened or the table panel opened.
export function loadTableList(channelId: string): Promise<void> {
	return scheduleList(channelId, 0);
}

// A table seat attribute changed in the room. Everyone in the room sees the same change, so the reads are spread
// over a window that grows with the room (5 ms a person, 5 s at most) instead of all landing 2 s later.
export function requestTableListRefresh(channelId: string): void {
	const guildId = MediaEngine.guildId;
	const people = guildId ? Object.keys(MediaEngine.getAllVoiceStatesInChannel(guildId, channelId)).length : 0;
	const spread = Math.min(TABLE_GAME_LIST_SPREAD_MAX_MS, people * TABLE_GAME_LIST_SPREAD_MS_PER_PERSON);
	void scheduleList(channelId, TABLE_GAME_LIST_DEBOUNCE_MS + Math.random() * spread);
}

export type TableFetchResult = 'updated' | 'unchanged' | 'refused' | 'failed';

export async function fetchTable(channelId: string, slot: string): Promise<TableFetchResult> {
	const key = tableKey(channelId, slot);
	const etag = TableGames.getView(channelId, slot) ? etags.get(key) : undefined;
	const connectionId = myConnectionId(channelId);
	try {
		const response = await http.get<unknown>(Endpoints.CHANNEL_TABLE_GAME(channelId, slot), {
			query: connectionId ? {connection_id: connectionId} : undefined,
			headers: etag ? {'If-None-Match': etag} : {},
			mode: 'silent',
		});
		if (response.status === 304) return 'unchanged';
		if (!response.ok) {
			logger.debug('Table read refused', {status: response.status, code: replyCode(response.body)});
			return response.status === 403 || response.status === 404 ? 'refused' : 'failed';
		}
		const view = response.body as TableGameView;
		if (response.headers.etag) etags.set(key, response.headers.etag);
		TableGames.handleView(channelId, view, 'rest');
		return 'updated';
	} catch (error) {
		logger.warn('Failed to read the table', error);
		return 'failed';
	}
}

function stopOverflowPoll(channelId: string, slot: string): void {
	const key = tableKey(channelId, slot);
	clearInterval(pollTimers.get(key));
	pollTimers.delete(key);
}

function startOverflowPoll(channelId: string, slot: string): void {
	stopOverflowPoll(channelId, slot);
	pollTimers.set(
		tableKey(channelId, slot),
		setInterval(() => {
			void fetchTable(channelId, slot).then((result) => {
				if (result !== 'refused') return;
				stopOverflowPoll(channelId, slot);
				TableGames.setWatchMode(channelId, slot, null);
			});
		}, TABLE_GAME_OVERFLOW_POLL_MS),
	);
}

export async function spectate(channelId: string, slot: string): Promise<TableGameOutcome> {
	const connectionId = myConnectionId(channelId);
	if (!connectionId) return {ok: false, error: 'not_in_voice'};
	try {
		const {body} = await http.put<TableGameSpectateResponse>(
			Endpoints.CHANNEL_TABLE_GAME_SPECTATORS_ME(channelId, slot),
			{
				body: {connection_id: connectionId},
			},
		);
		TableGames.handleView(channelId, body.view, 'rest');
		TableGames.setWatchMode(channelId, slot, body.subscribed ? 'live' : 'polling');
		// Past the live spectator limit no events come; the table is read with its ETag instead.
		if (body.subscribed) stopOverflowPoll(channelId, slot);
		else startOverflowPoll(channelId, slot);
		return OK;
	} catch (error) {
		logger.warn('Table game spectate failed', error);
		return failure(error);
	}
}

// Stopping is local first: the watch ends here even when the request fails (the server set expires on its own).
export async function unspectate(channelId: string, slot: string): Promise<TableGameOutcome> {
	stopOverflowPoll(channelId, slot);
	TableGames.setWatchMode(channelId, slot, null);
	try {
		await http.delete(Endpoints.CHANNEL_TABLE_GAME_SPECTATORS_ME(channelId, slot));
	} catch (error) {
		logger.warn('Table game unspectate failed', error);
	}
	return OK;
}

export function createTable(
	channelId: string,
	slot: string,
	game: TableGameKind,
	speed: TableGameSpeed,
): Promise<TableGameOutcome> {
	const connectionId = myConnectionId(channelId);
	if (!connectionId) return Promise.resolve({ok: false, error: 'not_in_voice'});
	watchVoiceLeave();
	return send(
		'create',
		() =>
			http.post<TableGameView>(Endpoints.CHANNEL_TABLE_GAME(channelId, slot), {
				body: {game, speed, connection_id: connectionId},
			}),
		channelId,
	);
}

export function joinTable(channelId: string, slot: string, position: number): Promise<TableGameOutcome> {
	const connectionId = myConnectionId(channelId);
	if (!connectionId) return Promise.resolve({ok: false, error: 'not_in_voice'});
	watchVoiceLeave();
	return send(
		'join',
		() =>
			http.put<TableGameView>(Endpoints.CHANNEL_TABLE_GAME_PLAYERS_ME(channelId, slot), {
				body: {position, connection_id: connectionId},
			}),
		channelId,
	);
}

export async function leaveTable(channelId: string, slot: string): Promise<TableGameOutcome> {
	try {
		await http.delete(Endpoints.CHANNEL_TABLE_GAME_PLAYERS_ME(channelId, slot));
		return OK;
	} catch (error) {
		logger.warn('Table game leave failed', error);
		return failure(error);
	}
}

export async function act(channelId: string, slot: string, action: TableGameAction): Promise<TableGameOutcome> {
	const view = TableGames.getView(channelId, slot);
	const version = view?.summary.version ?? 0;
	// My move sounds once the server takes it, and a refused one not at all; the update it makes is held until the
	// answer (TableGameSounds). A tick has no sound: what it brings is the server's and plays as such.
	const sound = view ? actionSound(view.summary.game, action) : null;
	const settle = sound ? holdOwnActionEcho(channelId, slot, version, sound) : null;
	const outcome = await send(
		'action',
		() => http.post<TableGameView>(Endpoints.CHANNEL_TABLE_GAME_ACTIONS(channelId, slot), {body: {version, action}}),
		channelId,
	);
	settle?.(outcome.ok);
	// A stale version means an update was missed; read the table so the next move is made against the real state.
	if (!outcome.ok && outcome.error === 'conflict') await fetchTable(channelId, slot);
	return outcome;
}

export function tick(channelId: string, slot: string): Promise<TableGameOutcome> {
	return act(channelId, slot, {type: 'tick'});
}

// leaving the voice channel with the leave button is leaving the table, unless this user is still in the
// channel from another device. Reconnects, server disconnects, page unloads and channel moves are not; the server's
// 30 s grace covers those. The engine names a moderator's move and the user's own switch alike ('channelMove'), so
// a switch to another channel also waits out the grace rather than forfeiting a moved player at once.
export function watchVoiceLeave(): void {
	if (voiceLeaveDisposer) return;
	voiceLeaveDisposer = reaction(
		() => [MediaEngine.guildId, MediaEngine.channelId, MediaEngine.connectionId] as const,
		([, nextChannelId], [guildId, channelId, connectionId]) => {
			if (!guildId || !channelId || nextChannelId === channelId) return;
			if (MediaEngine.localDisconnectReason !== 'user') return;
			const me = Authentication.currentUserId;
			if (!me) return;
			const slots = TableGames.getMyActiveSlots(channelId, me);
			if (slots.length === 0) return;
			const states = MediaEngine.getAllVoiceStatesInChannel(guildId, channelId);
			const stillThere = Object.values(states).some(
				(state) => state.user_id === me && state.connection_id !== connectionId,
			);
			if (stillThere) return;
			for (const slot of slots) void leaveTable(channelId, slot);
		},
		{equals: compareShallow},
	);
}

export function resetTableGameCommandsForTests(): void {
	for (const timer of listTimers.values()) clearTimeout(timer);
	for (const timer of pollTimers.values()) clearInterval(timer);
	listTimers.clear();
	lastListAt.clear();
	pollTimers.clear();
	etags.clear();
	voiceLeaveDisposer?.();
	voiceLeaveDisposer = null;
}

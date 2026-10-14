// SPDX-License-Identifier: AGPL-3.0-or-later

import {HttpError} from '@app/features/platform/types/EndpointError';
import type {RestResponse} from '@app/features/platform/types/TransportTypes';
import {testSummary, testView} from '@app/features/table_game/state/TableGameTestViews';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {observable, runInAction} from 'mobx';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: '100'}}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({
	http: {get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn()},
}));
// act() plays my action's sound (TableGameSounds); the Fluxer sound store is not part of these tests.
vi.mock('@app/features/ui/commands/SoundCommands', () => ({playSound: vi.fn()}));
interface FakeVoiceState {
	user_id: string;
	connection_id: string;
}
const voice = observable({
	guildId: '9' as string | null,
	channelId: '500' as string | null,
	connectionId: 'conn-a' as string | null,
	localDisconnectReason: null as string | null,
	states: {} as Record<string, FakeVoiceState>,
});
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({
	default: {
		get guildId() {
			return voice.guildId;
		},
		get channelId() {
			return voice.channelId;
		},
		get connectionId() {
			return voice.connectionId;
		},
		get localDisconnectReason() {
			return voice.localDisconnectReason;
		},
		getAllVoiceStatesInChannel: () => voice.states,
	},
}));

const {http} = await import('@app/features/platform/transport/RestTransport');
const TableGameCommands = await import('@app/features/table_game/commands/TableGameCommands');
const {default: TableGames} = await import('@app/features/table_game/state/TableGames');

const CHANNEL = '500';
const BASE = `/channels/${CHANNEL}/table-games`;

function reply<T>(body: T, status = 200, headers: Record<string, string> = {}): RestResponse<T> {
	return {ok: status < 300, status, statusText: '', headers, body};
}

function refusal(method: 'GET' | 'POST' | 'PUT' | 'DELETE', status: number, body: unknown): HttpError {
	return new HttpError({method, path: BASE, status, body});
}

function joinVoice(channelId = CHANNEL, connectionId = 'conn-a'): void {
	runInAction(() => {
		voice.channelId = channelId;
		voice.connectionId = connectionId;
		voice.localDisconnectReason = null;
		voice.states = {[connectionId]: {user_id: '100', connection_id: connectionId}};
	});
}

function leaveVoice(reason: string, nextChannelId: string | null = null): void {
	runInAction(() => {
		const {[voice.connectionId ?? '']: _, ...rest} = voice.states;
		voice.states = rest;
		voice.localDisconnectReason = reason;
		voice.channelId = nextChannelId;
		voice.connectionId = reason === 'user' ? null : voice.connectionId;
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	for (const method of [http.get, http.post, http.put, http.delete]) vi.mocked(method).mockReset();
	TableGameCommands.resetTableGameCommandsForTests();
	TableGames.reset();
	joinVoice();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('reading tables', () => {
	it('list/detail requests carry my connection_id', async () => {
		vi.mocked(http.get)
			.mockResolvedValueOnce(reply({tables: [testSummary()]}))
			.mockResolvedValueOnce(reply(testView({version: 3}), 200, {etag: '"tg-3-1"'}));
		await TableGameCommands.loadTableList(CHANNEL);
		await TableGameCommands.fetchTable(CHANNEL, 'T01');
		expect(vi.mocked(http.get).mock.calls[0]).toEqual([BASE, {query: {connection_id: 'conn-a'}}]);
		expect(vi.mocked(http.get).mock.calls[1]![0]).toBe(`${BASE}/T01`);
		expect(vi.mocked(http.get).mock.calls[1]![1]).toMatchObject({query: {connection_id: 'conn-a'}, mode: 'silent'});
		expect(TableGames.getSummaries(CHANNEL)).toHaveLength(1);
		expect(TableGames.getView(CHANNEL, 'T01')?.summary.version).toBe(3);
	});

	it('does not read tables of a channel I am not connected to', async () => {
		await TableGameCommands.loadTableList('999');
		expect(http.get).not.toHaveBeenCalled();
	});

	it('list refresh is debounced 2 s and at most once per 10 s', async () => {
		const random = vi.spyOn(Math, 'random').mockReturnValue(0);
		vi.mocked(http.get).mockResolvedValue(reply({tables: []}));
		TableGameCommands.requestTableListRefresh(CHANNEL);
		TableGameCommands.requestTableListRefresh(CHANNEL);
		await vi.advanceTimersByTimeAsync(1999);
		expect(http.get).toHaveBeenCalledTimes(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(http.get).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1000);
		TableGameCommands.requestTableListRefresh(CHANNEL);
		TableGameCommands.requestTableListRefresh(CHANNEL);
		await vi.advanceTimersByTimeAsync(8999);
		expect(http.get).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(http.get).toHaveBeenCalledTimes(2);
		await TableGameCommands.loadTableList(CHANNEL);
		expect(http.get).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(http.get).toHaveBeenCalledTimes(3);
		random.mockRestore();
	});

	it('a big room spreads the refresh after the 2 s wait over up to 5 s, by its size', async () => {
		const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
		vi.mocked(http.get).mockResolvedValue(reply({tables: []}));
		const people = (count: number) =>
			runInAction(() => {
				voice.states = Object.fromEntries(
					Array.from({length: count}, (_, index) => [`c${index}`, {user_id: `${index}`, connection_id: `c${index}`}]),
				);
			});
		// 400 people spread over 0–2 s; half of that is 1 s.
		people(400);
		TableGameCommands.requestTableListRefresh(CHANNEL);
		await vi.advanceTimersByTimeAsync(2999);
		expect(http.get).toHaveBeenCalledTimes(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(http.get).toHaveBeenCalledTimes(1);
		// 10 000 people spread over 0–5 s at most.
		TableGameCommands.resetTableGameCommandsForTests();
		people(10_000);
		random.mockReturnValue(1);
		TableGameCommands.requestTableListRefresh(CHANNEL);
		await vi.advanceTimersByTimeAsync(6999);
		expect(http.get).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(http.get).toHaveBeenCalledTimes(2);
		random.mockRestore();
	});
});

describe('spectating', () => {
	it('overflow spectator polls detail every 5 s with ETag; live spectator does not poll', async () => {
		vi.mocked(http.put).mockResolvedValueOnce(
			reply({subscribed: false, view: testView({version: 3, viewerPosition: null, spectating: false})}),
		);
		vi.mocked(http.get)
			.mockResolvedValueOnce(reply(testView({version: 4, viewerPosition: null}), 200, {etag: '"tg-4-s"'}))
			.mockResolvedValueOnce(reply(null, 304))
			.mockResolvedValueOnce(reply(testView({version: 5, viewerPosition: null}), 200, {etag: '"tg-5-s"'}));
		await expect(TableGameCommands.spectate(CHANNEL, 'T01')).resolves.toEqual({ok: true});
		expect(vi.mocked(http.put).mock.calls[0]).toEqual([
			`${BASE}/T01/spectators/@me`,
			{body: {connection_id: 'conn-a'}},
		]);
		expect(TableGames.getWatchMode(CHANNEL, 'T01')).toBe('polling');
		await vi.advanceTimersByTimeAsync(5000);
		expect(vi.mocked(http.get).mock.calls[0]![1]).toMatchObject({headers: {}});
		await vi.advanceTimersByTimeAsync(5000);
		expect(vi.mocked(http.get).mock.calls[1]![1]).toMatchObject({headers: {'If-None-Match': '"tg-4-s"'}});
		expect(TableGames.getView(CHANNEL, 'T01')?.summary.version).toBe(4);
		await vi.advanceTimersByTimeAsync(5000);
		expect(TableGames.getView(CHANNEL, 'T01')?.summary.version).toBe(5);
		vi.mocked(http.delete).mockResolvedValueOnce(reply(null, 204));
		await TableGameCommands.unspectate(CHANNEL, 'T01');
		expect(http.delete).toHaveBeenCalledWith(`${BASE}/T01/spectators/@me`);
		expect(TableGames.getWatchMode(CHANNEL, 'T01')).toBeNull();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(http.get).toHaveBeenCalledTimes(3);
	});

	it('a subscribed spectator gets events and never polls', async () => {
		vi.mocked(http.put).mockResolvedValueOnce(
			reply({subscribed: true, view: testView({version: 3, viewerPosition: null, spectating: true})}),
		);
		await TableGameCommands.spectate(CHANNEL, 'T01');
		expect(TableGames.getWatchMode(CHANNEL, 'T01')).toBe('live');
		await vi.advanceTimersByTimeAsync(30_000);
		expect(http.get).not.toHaveBeenCalled();
	});

	it('stops polling when the server says I am no longer in voice', async () => {
		vi.mocked(http.put).mockResolvedValueOnce(reply({subscribed: false, view: testView({viewerPosition: null})}));
		vi.mocked(http.get).mockResolvedValueOnce(reply({code: APIErrorCodes.USER_NOT_IN_VOICE, message: 'no'}, 403));
		await TableGameCommands.spectate(CHANNEL, 'T01');
		await vi.advanceTimersByTimeAsync(15_000);
		expect(http.get).toHaveBeenCalledTimes(1);
		expect(TableGames.getWatchMode(CHANNEL, 'T01')).toBeNull();
	});
});

describe('playing', () => {
	it('create and join send my connection_id and store the returned view', async () => {
		vi.mocked(http.post).mockResolvedValueOnce(reply(testView({version: 0, status: 'lobby'}), 201));
		vi.mocked(http.put).mockResolvedValueOnce(reply(testView({version: 1, status: 'lobby'})));
		await expect(TableGameCommands.createTable(CHANNEL, 'T01', 'chess', 'fast')).resolves.toEqual({ok: true});
		await expect(TableGameCommands.joinTable(CHANNEL, 'T01', 3)).resolves.toEqual({ok: true});
		expect(http.post).toHaveBeenCalledWith(`${BASE}/T01`, {
			body: {game: 'chess', speed: 'fast', connection_id: 'conn-a'},
		});
		expect(http.put).toHaveBeenCalledWith(`${BASE}/T01/players/@me`, {body: {position: 3, connection_id: 'conn-a'}});
		expect(TableGames.getView(CHANNEL, 'T01')?.summary.version).toBe(1);
	});

	it("act sends the view's version and stores the returned view", async () => {
		TableGames.handleView(CHANNEL, testView({version: 6}), 'event');
		vi.mocked(http.post).mockResolvedValueOnce(reply(testView({version: 7})));
		await TableGameCommands.act(CHANNEL, 'T01', {type: 'draw', from: 'pile'});
		expect(http.post).toHaveBeenCalledWith(`${BASE}/T01/actions`, {
			body: {version: 6, action: {type: 'draw', from: 'pile'}},
		});
		expect(TableGames.getView(CHANNEL, 'T01')?.summary.version).toBe(7);
	});

	it('reports a rule violation with its reason and refetches after a version conflict', async () => {
		TableGames.handleView(CHANNEL, testView({version: 6}), 'event');
		vi.mocked(http.post)
			.mockRejectedValueOnce(
				refusal('POST', 400, {code: APIErrorCodes.TABLE_GAME_RULE_VIOLATION, message: 'x', reason: 'not_your_turn'}),
			)
			.mockRejectedValueOnce(refusal('POST', 409, {code: APIErrorCodes.TABLE_GAME_CONFLICT, message: 'x'}));
		vi.mocked(http.get).mockResolvedValueOnce(reply(testView({version: 8})));
		await expect(TableGameCommands.act(CHANNEL, 'T01', {type: 'resign'})).resolves.toEqual({
			ok: false,
			error: 'rule',
			reason: 'not_your_turn',
		});
		await expect(TableGameCommands.act(CHANNEL, 'T01', {type: 'resign'})).resolves.toEqual({
			ok: false,
			error: 'conflict',
		});
		expect(http.get).toHaveBeenCalledTimes(1);
		expect(TableGames.getView(CHANNEL, 'T01')?.summary.version).toBe(8);
	});
});

describe('leaving voice while seated at a table (Ş14 client half)', () => {
	beforeEach(() => {
		TableGames.handleView(CHANNEL, testView({version: 3, status: 'playing'}), 'event');
		vi.mocked(http.delete).mockResolvedValue(reply(null, 204));
		TableGameCommands.watchVoiceLeave();
	});

	it('user-initiated voice leave sends leave once; reconnect does not', async () => {
		runInAction(() => {
			voice.localDisconnectReason = 'error';
			voice.channelId = null;
		});
		joinVoice();
		await vi.advanceTimersByTimeAsync(0);
		expect(http.delete).not.toHaveBeenCalled();
		leaveVoice('user');
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.mocked(http.delete).mock.calls).toEqual([[`${BASE}/T01/players/@me`]]);
	});

	it('a server-initiated channel move sends no leave', async () => {
		leaveVoice('channelMove');
		runInAction(() => {
			voice.channelId = '777';
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(http.delete).not.toHaveBeenCalled();
	});

	it('leaving voice with another own connection in the channel sends no DELETE', async () => {
		runInAction(() => {
			voice.states = {...voice.states, 'conn-phone': {user_id: '100', connection_id: 'conn-phone'}};
		});
		leaveVoice('user');
		await vi.advanceTimersByTimeAsync(0);
		expect(http.delete).not.toHaveBeenCalled();
	});

	it('a server-side disconnect or replaced connection sends no DELETE', async () => {
		leaveVoice('server');
		joinVoice();
		runInAction(() => {
			voice.localDisconnectReason = 'replaced';
			voice.channelId = null;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(http.delete).not.toHaveBeenCalled();
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {SoundType} from '@app/features/notification/utils/SoundUtils';
import {
	testOkeyGameView,
	testTavlaGameView,
	testTavlaPoints,
	testView,
} from '@app/features/table_game/state/TableGameTestViews';
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
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({
	default: {guildId: '9', channelId: '500', connectionId: 'conn-a', getAllVoiceStatesInChannel: () => ({})},
}));
vi.mock('@app/features/ui/commands/SoundCommands', () => ({playSound: vi.fn()}));

const {http} = await import('@app/features/platform/transport/RestTransport');
const {playSound} = await import('@app/features/ui/commands/SoundCommands');
const TableGameCommands = await import('@app/features/table_game/commands/TableGameCommands');
const {default: TableGames} = await import('@app/features/table_game/state/TableGames');
const {setTableSoundFocus} = await import('@app/features/table_game/sound/TableGameSounds');

type View = ReturnType<typeof testView>;

const myTurn = testView({version: 4, gameView: testOkeyGameView({turn: 1, phase: 'discard'})});
const discarded = testView({
	version: 5,
	gameView: testOkeyGameView({turn: 2, phase: 'draw', discards: [['t1'], [], [], []]}),
});

const reply = (body: View) => ({ok: true, status: 200, statusText: '', headers: {}, body});

describe('TableGameCommands.act plays my action once the server takes it (CR7, D3)', () => {
	beforeEach(() => {
		TableGames.reset();
		vi.mocked(playSound).mockClear();
		vi.mocked(http.post).mockReset();
	});

	afterEach(() => {
		setTableSoundFocus('500', 'T01', false);
	});

	it('my move sounds on the accepted answer, and its echo adds nothing', async () => {
		TableGames.handleView('500', myTurn, 'event');
		setTableSoundFocus('500', 'T01', true);
		let soundBeforeReply = true;
		vi.mocked(http.post).mockImplementation(async () => {
			soundBeforeReply = vi.mocked(playSound).mock.calls.length > 0;
			return reply(discarded);
		});
		await TableGameCommands.act('500', 'T01', {type: 'discard', tile: 't1'});
		expect(soundBeforeReply).toBe(false);
		expect(vi.mocked(playSound).mock.calls).toEqual([[SoundType.TableGameTileDiscard]]);
	});

	it('the echo arriving as an event before the answer still plays once', async () => {
		TableGames.handleView('500', myTurn, 'event');
		setTableSoundFocus('500', 'T01', true);
		vi.mocked(http.post).mockImplementation(async () => {
			TableGames.handleView('500', discarded, 'event');
			return reply(discarded);
		});
		await TableGameCommands.act('500', 'T01', {type: 'discard', tile: 't1'});
		expect(vi.mocked(playSound).mock.calls).toEqual([[SoundType.TableGameTileDiscard]]);
	});

	it('a rejected move plays nothing', async () => {
		TableGames.handleView('500', myTurn, 'event');
		setTableSoundFocus('500', 'T01', true);
		vi.mocked(http.post).mockRejectedValue(new Error('rule'));
		await TableGameCommands.act('500', 'T01', {type: 'discard', tile: 't1'});
		expect(playSound).not.toHaveBeenCalled();
	});

	it('a server change that beat my refused move still plays', async () => {
		const drawPhase = testView({version: 4, gameView: testOkeyGameView({turn: 1, phase: 'draw', pile_count: 40})});
		// My turn ran out: the server drew and threw for me before my draw arrived.
		const timedOut = testView({
			version: 5,
			gameView: testOkeyGameView({turn: 2, phase: 'draw', pile_count: 39, discards: [['t3'], [], [], []]}),
		});
		TableGames.handleView('500', drawPhase, 'event');
		setTableSoundFocus('500', 'T01', true);
		vi.mocked(http.post).mockImplementation(async () => {
			TableGames.handleView('500', timedOut, 'event');
			throw new Error('conflict');
		});
		vi.mocked(http.get).mockResolvedValue({ok: true, status: 304, statusText: '', headers: {}, body: null});
		await TableGameCommands.act('500', 'T01', {type: 'draw', from: 'pile'});
		expect(vi.mocked(playSound).mock.calls).toEqual([[SoundType.TableGameTileDiscard]]);
	});

	it('new dice after the opponent passes plays', async () => {
		const mine = testView({
			game: 'tavla',
			version: 7,
			gameView: testTavlaGameView({turn: 1, dice: [6, 5], legal_moves: ['24/13']}),
		});
		const points = testTavlaPoints();
		points[23] = 1;
		points[12] = 6;
		const back = testView({
			game: 'tavla',
			version: 8,
			gameView: testTavlaGameView({turn: 1, dice: [6, 5], points, last_moves: [{from: 24, to: 13, hit: false}]}),
		});
		TableGames.handleView('500', mine, 'event');
		setTableSoundFocus('500', 'T01', true);
		vi.mocked(http.post).mockResolvedValue(reply(back));
		await TableGameCommands.act('500', 'T01', {type: 'tavla_move', moves: [{from: 24, to: 13}]});
		expect(vi.mocked(playSound).mock.calls).toEqual([
			[SoundType.TableGameTavlaChecker],
			[SoundType.TableGameTavlaDice],
		]);
	});

	it('a tick plays nothing, and nothing plays for a table this client has not seen', async () => {
		vi.mocked(http.post).mockResolvedValue(reply(myTurn));
		await TableGameCommands.act('500', 'T01', {type: 'discard', tile: 't1'});
		TableGames.handleView('500', myTurn, 'event');
		await TableGameCommands.act('500', 'T01', {type: 'tick'});
		expect(playSound).not.toHaveBeenCalled();
	});
});

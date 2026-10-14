// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {testUnknownGameView, UNKNOWN_GAME} from '@app/features/table_game/state/TableGameTestViews';
import type {
	RoomLayout,
	RoomSeat,
	SeatViewTarget,
	TableDragHandler,
	TableScene3DInput,
	VoiceSceneHandle,
} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {TABLE_GAME_POSITIONS} from '@fluxer/constants/src/TableGameConstants';
import type {
	ChessView,
	DamaView,
	Okey101View,
	OkeyView,
	TableGameSummary,
	TableGameView,
	TavlaView,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {observer} from 'mobx-react-lite';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: (d: {message: string}) => d.message}})}));
vi.mock('@app/features/notification/utils/SoundUtils', () => ({
	SoundType: {TableGameTileDrag: 'table-game-tile-drag', TableGameTilePlace: 'table-game-tile-place'},
}));
vi.mock('@app/features/table_game/sound/TableGameSounds', () => ({
	playTableUiSound: vi.fn(),
	setTableSoundFocus: vi.fn(),
}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({createToast: vi.fn()}));
vi.mock('@app/features/table_game/commands/TableGameCommands', () => ({act: vi.fn()}));

const TableGameCommands = await import('@app/features/table_game/commands/TableGameCommands');
const Sounds = await import('@app/features/table_game/sound/TableGameSounds');
const ToastCommands = await import('@app/features/ui/commands/ToastCommands');
const {default: TableGames} = await import('@app/features/table_game/state/TableGames');
const {useTableGameScene} = await import('@app/features/voice_scene/hooks/useTableGameScene');
type Hud = ReturnType<typeof useTableGameScene>;

const seat = (name: string, x: number, z: number, position: 1 | 2 | 3 | 4 | null): RoomSeat => ({
	name,
	group: 'T01',
	position: {x, y: 1, z},
	table: position ? {slot: 'T01', position} : null,
	watch: position ? null : {slot: 'T01', index: 1},
});

// Table at the origin: seat 1 south (+Z), 2 east, 3 north, 4 west; the watch seat behind seat 2's right shoulder.
const SEATS = [
	seat('seat_T01_1', 0, 1, 1),
	seat('seat_T01_2', 1, 0, 2),
	seat('seat_T01_3', 0, -1, 3),
	seat('seat_T01_4', -1, 0, 4),
	seat('seat_T01_Y1', 1.6, -0.4, null),
];
const LAYOUT: RoomLayout = {
	seats: SEATS,
	stands: [],
	tables: [{slot: 'T01', center: {x: 0, y: 0.8, z: 0}, topSize: 1.3}],
	camTarget: {x: 0, y: 0, z: 0},
	camHome: {x: 0, y: 5, z: 8},
	screen: null,
	camPan: {x: 0, z: 0},
};

type GameView = NonNullable<TableGameView['game_view']>;

function tableView(gameView: GameView, options: {me?: number | null; version?: number} = {}): TableGameView {
	const me = options.me === undefined ? 1 : options.me;
	const summary: TableGameSummary = {
		slot: 'T01',
		game: gameView.game,
		speed: 'normal',
		status: 'playing',
		players: TABLE_GAME_POSITIONS[gameView.game].map((position) => ({
			position,
			user_id: position === me ? '1' : String(100 + position),
			connected: true,
			timeouts: 0,
		})),
		spectator_count: 0,
		version: options.version ?? 7,
		result: null,
	};
	return {summary, game_view: gameView, viewer_position: me, spectating: me === null};
}

// t0 t1 t2 yellow 1-3; t13 t14 blue 1-2; t30 black 5. Gaps split the groups.
const RACK = ['t0', 't1', 't2', 't13', 't14', 't30'];
const ORDER = ['t0', 't1', 't2', null, 't13', 't14', null, 't30'];

function okeyView(overrides: Partial<OkeyView> = {}): OkeyView {
	return {
		game: 'okey',
		indicator: 't5',
		pile_count: 48,
		discards: [[], [], [], ['t40']],
		rack_counts: [6, 14, 14, 14],
		turn: 1,
		phase: 'discard',
		deadline_at: null,
		rack: RACK,
		...overrides,
	};
}

function okey101View(overrides: Partial<Okey101View> = {}): Okey101View {
	return {
		...okeyView({phase: 'play'}),
		game: 'okey101',
		melds: [],
		opened: ['none', 'none', 'none', 'none'],
		penalties: [0, 0, 0, 0],
		scores: null,
		...overrides,
	};
}

const chessView = (): ChessView => ({
	game: 'chess',
	fen: '8/4P3/8/8/8/8/8/4K2k w - - 0 1',
	white: 1,
	clocks_ms: {white: 600_000, black: 600_000},
	turn_started_at: null,
	last_move: null,
	legal_moves: ['e7e8q', 'e7e8r', 'e7e8b', 'e7e8n', 'e1d1'],
	in_check: false,
});

const damaView = (): DamaView => ({
	game: 'dama',
	board: '.'.repeat(64),
	white: 1,
	turn: 1,
	clocks_ms: {white: 600_000, black: 600_000},
	turn_started_at: null,
	last_move: null,
	last_captured: [],
	legal_moves: ['c3-c5-e5', 'c3-e3-e5', 'a3-a4'],
});

function tavlaView(): TavlaView {
	const points = Array<number>(24).fill(0);
	points[23] = 2;
	points[0] = -2;
	return {
		game: 'tavla',
		white: 1,
		points,
		bar: {white: 0, black: 0},
		off: {white: 0, black: 0},
		turn: 1,
		dice: [6, 5],
		opening: null,
		deadline_at: null,
		last_moves: [],
		legal_moves: ['24/18 18/13'],
	};
}

function fakeHandle() {
	let handler: TableDragHandler | null = null;
	const table = {
		update: vi.fn((_input: TableScene3DInput) => {}),
		setDragHandler: vi.fn((next: TableDragHandler | null) => {
			handler = next;
		}),
		dispose: vi.fn(),
	};
	const handle = {layout: LAYOUT, mountTableGame: vi.fn(() => table)} as unknown as VoiceSceneHandle & {
		mountTableGame: ReturnType<typeof vi.fn>;
	};
	return {
		handle,
		table,
		handler: () => {
			if (!handler) throw new Error('no drag handler');
			return handler;
		},
		lastInput: () => table.update.mock.calls.at(-1)![0],
	};
}

const target = (name: string, game: GameView['game'] | null): SeatViewTarget => {
	const found = SEATS.find((entry) => entry.name === name)!;
	return {seat: found, slot: 'T01', game, role: found.table ? 'player' : 'watch'};
};

let root: Root;
let hud: Hud = null;

const Probe = observer(function Probe(props: {handle: VoiceSceneHandle; target: SeatViewTarget | null}) {
	hud = useTableGameScene({...props, channelId: '500'});
	return null;
});

function render(handle: VoiceSceneHandle, seatTarget: SeatViewTarget | null): void {
	act(() => root.render(createElement(Probe, {handle, target: seatTarget})));
}

function show(view: TableGameView): void {
	act(() => {
		TableGames.handleView('500', view, 'rest');
	});
}

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
	});
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	act(() => TableGames.reset());
	vi.mocked(TableGameCommands.act).mockReset();
	vi.mocked(TableGameCommands.act).mockResolvedValue({ok: true});
	vi.mocked(Sounds.setTableSoundFocus).mockClear();
	vi.mocked(Sounds.playTableUiSound).mockClear();
	vi.mocked(ToastCommands.createToast).mockClear();
	root = createRoot(document.createElement('div'));
	hud = null;
});

afterEach(() => {
	act(() => root.unmount());
});

describe('useTableGameScene', () => {
	it('mounts nothing without a seat view or a table view', () => {
		const {handle} = fakeHandle();
		render(handle, null);
		render(handle, target('seat_T01_1', null));
		expect(handle.mountTableGame).not.toHaveBeenCalled();
		expect(hud).toBeNull();
	});

	it('view, rack, stage and pending steps reach TableGame3D.update', () => {
		const {handle, handler, lastInput, table} = fakeHandle();
		show(tableView(okey101View()));
		act(() => TableGames.setRackOrder('500', 'T01', ORDER));
		render(handle, target('seat_T01_1', 'okey101'));
		expect(handle.mountTableGame).toHaveBeenCalledWith('T01', 'okey101');
		expect(lastInput()).toMatchObject({perspective: 1, rack: ORDER, stage: null, pendingTavla: [], interactive: true});
		expect(lastInput().view).toBe(TableGames.getView('500', 'T01'));
		// Not opened yet: a set dropped on the meld zone waits for "Open" (101 staging).
		act(() => handler().onDrop({kind: 'rack_tile', tile: 't0', cell: 0}, {kind: 'meld_zone'}));
		expect(lastInput().stage).toEqual({take: null, open: [['t0', 't1', 't2']], add: []});
		expect(hud?.stagedCount).toBe(3);
		expect(TableGameCommands.act).not.toHaveBeenCalled();
		act(() => hud?.cancelStage());
		expect(lastInput().stage).toBeNull();
		expect(table.update.mock.calls.length).toBeGreaterThan(2);
	});

	it('drop → action calls act once; rack outcome calls setRackOrder; conflict refetches and snaps back', async () => {
		const {handle, handler, lastInput} = fakeHandle();
		show(tableView(okeyView()));
		act(() => TableGames.setRackOrder('500', 'T01', ORDER));
		render(handle, target('seat_T01_1', 'okey'));
		// Arranging is local: no request, the place sound.
		act(() => handler().onDrop({kind: 'rack_tile', tile: 't30', cell: 7}, {kind: 'rack_cell', cell: 3}));
		expect(TableGames.getRack('500', 'T01')).toEqual(['t0', 't1', 't2', 't30', 't13', 't14']);
		expect(Sounds.playTableUiSound).toHaveBeenCalledWith('table-game-tile-place');
		expect(TableGameCommands.act).not.toHaveBeenCalled();
		// İnceleme odağı 1: the drop went out against a version that moved on; act re-reads the table (409).
		const fresher = tableView(okeyView({turn: 2, phase: 'draw', rack: RACK}), {version: 8});
		vi.mocked(TableGameCommands.act).mockImplementation(async () => {
			TableGames.handleView('500', fresher, 'rest');
			return {ok: false, error: 'conflict'};
		});
		act(() => handler().onDragStart({kind: 'rack_tile', tile: 't13', cell: 4}));
		expect(lastInput().targets.length).toBeGreaterThan(0);
		act(() => handler().onDrop({kind: 'rack_tile', tile: 't13', cell: 4}, {kind: 'discard_zone'}));
		await flush();
		expect(TableGameCommands.act).toHaveBeenCalledTimes(1);
		expect(TableGameCommands.act).toHaveBeenCalledWith('500', 'T01', {type: 'discard', tile: 't13'});
		// The tile is drawn where the re-read table has it; nothing local is left over.
		expect(lastInput().view.summary.version).toBe(8);
		expect(lastInput()).toMatchObject({selection: null, targets: [], stage: null, pendingTavla: []});
		expect(ToastCommands.createToast).toHaveBeenCalledTimes(1);
	});

	it('a refused 101 open drops the pending sets', async () => {
		const {handle, handler, lastInput} = fakeHandle();
		show(tableView(okey101View()));
		act(() => TableGames.setRackOrder('500', 'T01', ORDER));
		render(handle, target('seat_T01_1', 'okey101'));
		act(() => handler().onDrop({kind: 'rack_tile', tile: 't0', cell: 0}, {kind: 'meld_zone'}));
		vi.mocked(TableGameCommands.act).mockResolvedValue({ok: false, error: 'rule', reason: 'illegal_move'});
		act(() => hud?.openStage());
		await flush();
		expect(TableGameCommands.act).toHaveBeenCalledTimes(1);
		expect(TableGameCommands.act).toHaveBeenCalledWith('500', 'T01', {type: 'meld', open: [['t0', 't1', 't2']]});
		expect(lastInput().stage).toBeNull();
	});

	it('promotion outcome opens the picker', () => {
		const {handle, handler} = fakeHandle();
		show(tableView(chessView()));
		render(handle, target('seat_T01_1', 'chess'));
		act(() => handler().onDrop({kind: 'square', square: 'e7'}, {kind: 'square', square: 'e8'}));
		expect(hud?.promotion).toEqual({from: 'e7', to: 'e8', side: 'white'});
		expect(TableGameCommands.act).not.toHaveBeenCalled();
		act(() => hud?.pickPromotion('n'));
		expect(TableGameCommands.act).toHaveBeenCalledWith('500', 'T01', {
			type: 'move',
			from: 'e7',
			to: 'e8',
			promotion: 'n',
		});
		expect(hud?.promotion).toBeNull();
	});

	it('choose_path shows the path chooser', () => {
		const {handle, handler} = fakeHandle();
		show(tableView(damaView()));
		render(handle, target('seat_T01_1', 'dama'));
		act(() => handler().onDrop({kind: 'square', square: 'c3'}, {kind: 'square', square: 'e5'}));
		expect(hud?.pathChoice).toEqual([
			['c3', 'c5', 'e5'],
			['c3', 'e3', 'e5'],
		]);
		act(() => hud?.choosePath(['c3', 'e3', 'e5']));
		expect(TableGameCommands.act).toHaveBeenCalledTimes(1);
		expect(TableGameCommands.act).toHaveBeenCalledWith('500', 'T01', {type: 'dama_move', path: ['c3', 'e3', 'e5']});
		expect(hud?.pathChoice).toBeNull();
	});

	// a path hovered in the HUD shows on the board through the existing marks (start selected, landings as targets);
	// the preview is not a selection, so a board click meanwhile still starts from nothing.
	it('a previewed dama path reaches the board marks; leaving, choosing or dismissing clears it', () => {
		const {handle, handler, lastInput} = fakeHandle();
		show(tableView(damaView()));
		render(handle, target('seat_T01_1', 'dama'));
		act(() => handler().onDrop({kind: 'square', square: 'c3'}, {kind: 'square', square: 'e5'}));
		expect(lastInput().selection).toBeNull();
		expect(lastInput().targets).toEqual([]);
		act(() => hud?.previewPath(['c3', 'e3', 'e5']));
		expect(lastInput().selection).toEqual({kind: 'square', square: 'c3'});
		expect(lastInput().targets).toEqual([
			{kind: 'square', square: 'e3'},
			{kind: 'square', square: 'e5'},
		]);
		act(() => hud?.previewPath(null));
		expect(lastInput().selection).toBeNull();
		expect(lastInput().targets).toEqual([]);

		act(() => hud?.previewPath(['c3', 'c5', 'e5']));
		act(() => handler().onSelect({kind: 'square', square: 'e5'}));
		expect(TableGameCommands.act).not.toHaveBeenCalled();
		act(() => hud?.dismissChoice());
		expect(lastInput().selection).toBeNull();
		expect(lastInput().targets).toEqual([]);

		act(() => handler().onDrop({kind: 'square', square: 'c3'}, {kind: 'square', square: 'e5'}));
		act(() => hud?.previewPath(['c3', 'c5', 'e5']));
		act(() => hud?.choosePath(['c3', 'c5', 'e5']));
		expect(TableGameCommands.act).toHaveBeenCalledExactlyOnceWith('500', 'T01', {
			type: 'dama_move',
			path: ['c3', 'c5', 'e5'],
		});
		expect(lastInput().selection).toBeNull();
		expect(lastInput().targets).toEqual([]);
	});

	it('tavla completion sends one tavla_move', () => {
		const {handle, handler, lastInput} = fakeHandle();
		show(tableView(tavlaView()));
		render(handle, target('seat_T01_1', 'tavla'));
		act(() => handler().onDrop({kind: 'tavla_point', point: 24}, {kind: 'tavla_point', point: 18}));
		expect(lastInput().pendingTavla).toEqual([{from: 24, to: 18}]);
		expect(hud?.tavlaSteps).toHaveLength(1);
		expect(TableGameCommands.act).not.toHaveBeenCalled();
		act(() => hud?.undoTavla());
		expect(lastInput().pendingTavla).toEqual([]);
		act(() => handler().onDrop({kind: 'tavla_point', point: 24}, {kind: 'tavla_point', point: 18}));
		act(() => handler().onDrop({kind: 'tavla_point', point: 18}, {kind: 'tavla_point', point: 13}));
		expect(TableGameCommands.act).toHaveBeenCalledTimes(1);
		expect(TableGameCommands.act).toHaveBeenCalledWith('500', 'T01', {
			type: 'tavla_move',
			moves: [
				{from: 24, to: 18},
				{from: 18, to: 13},
			],
		});
	});

	it('click-click: a piece then a target plays like a drop', () => {
		const {handle, handler, lastInput} = fakeHandle();
		show(tableView(damaView()));
		render(handle, target('seat_T01_1', 'dama'));
		act(() => handler().onSelect({kind: 'square', square: 'a3'}));
		expect(lastInput().selection).toEqual({kind: 'square', square: 'a3'});
		expect(lastInput().targets).toEqual([{kind: 'square', square: 'a4'}]);
		act(() => handler().onSelect({kind: 'square', square: 'a4'}));
		expect(TableGameCommands.act).toHaveBeenCalledWith('500', 'T01', {type: 'dama_move', path: ['a3', 'a4']});
		expect(lastInput().selection).toBeNull();
	});

	it('a presence-check version bump keeps my 101 staging and half-played tavla steps', () => {
		const {handle, handler, lastInput} = fakeHandle();
		show(tableView(okey101View()));
		act(() => TableGames.setRackOrder('500', 'T01', ORDER));
		render(handle, target('seat_T01_1', 'okey101'));
		act(() => handler().onDrop({kind: 'rack_tile', tile: 't0', cell: 0}, {kind: 'meld_zone'}));
		// The server's minute presence check writes the table again: a newer version, the same game.
		show(tableView(okey101View(), {version: 8}));
		expect(lastInput().view.summary.version).toBe(8);
		expect(lastInput().stage).toEqual({take: null, open: [['t0', 't1', 't2']], add: []});
		expect(hud?.stagedCount).toBe(3);

		act(() => TableGames.reset());
		show(tableView(tavlaView()));
		render(handle, target('seat_T01_1', 'tavla'));
		act(() => handler().onDrop({kind: 'tavla_point', point: 24}, {kind: 'tavla_point', point: 18}));
		show(tableView(tavlaView(), {version: 8}));
		expect(lastInput().pendingTavla).toEqual([{from: 24, to: 18}]);
		expect(hud?.tavlaSteps).toHaveLength(1);
	});

	it('a presence-check version bump keeps a dama path choice and a chess promotion', () => {
		const {handle, handler} = fakeHandle();
		show(tableView(damaView()));
		render(handle, target('seat_T01_1', 'dama'));
		act(() => handler().onDrop({kind: 'square', square: 'c3'}, {kind: 'square', square: 'e5'}));
		show(tableView(damaView(), {version: 8}));
		expect(hud?.pathChoice).toHaveLength(2);

		act(() => TableGames.reset());
		show(tableView(chessView()));
		render(handle, target('seat_T01_1', 'chess'));
		act(() => handler().onDrop({kind: 'square', square: 'e7'}, {kind: 'square', square: 'e8'}));
		show(tableView(chessView(), {version: 8}));
		expect(hud?.promotion).toEqual({from: 'e7', to: 'e8', side: 'white'});
	});

	it('a real move resets them', () => {
		const {handle, handler, lastInput} = fakeHandle();
		show(tableView(okey101View()));
		act(() => TableGames.setRackOrder('500', 'T01', ORDER));
		render(handle, target('seat_T01_1', 'okey101'));
		act(() => handler().onDrop({kind: 'rack_tile', tile: 't0', cell: 0}, {kind: 'meld_zone'}));
		// My turn timed out: the server played for me and the turn moved on.
		show(tableView(okey101View({turn: 2, phase: 'draw', discards: [['t30'], [], [], ['t40']]}), {version: 8}));
		expect(lastInput().stage).toBeNull();
		expect(hud?.stagedCount).toBe(0);

		act(() => TableGames.reset());
		show(tableView(tavlaView()));
		render(handle, target('seat_T01_1', 'tavla'));
		act(() => handler().onDrop({kind: 'tavla_point', point: 24}, {kind: 'tavla_point', point: 18}));
		const moved = tavlaView();
		moved.points[23] = 0;
		moved.points[12] = 2;
		show(tableView({...moved, turn: 3, dice: [2, 1], last_moves: [{from: 24, to: 13, hit: false}]}, {version: 8}));
		expect(lastInput().pendingTavla).toEqual([]);
		expect(hud?.tavlaSteps).toEqual([]);
	});

	it('an unknown game kind mounts no scene, and its watch seat never throws', () => {
		const {handle} = fakeHandle();
		show(testUnknownGameView());
		render(handle, target('seat_T01_Y1', UNKNOWN_GAME));
		expect(hud).not.toBeNull();
		render(handle, target('seat_T01_1', UNKNOWN_GAME));
		expect(hud).not.toBeNull();
		expect(handle.mountTableGame).not.toHaveBeenCalled();
	});

	it("a watcher's table is read-only, seen from the nearest player's edge", () => {
		const {handle, handler, lastInput} = fakeHandle();
		show(tableView(chessView(), {me: null}));
		render(handle, target('seat_T01_Y1', 'chess'));
		// Nearest seat is 2, but chess sits at 1 and 3: the board turns to the nearer of those.
		expect(lastInput()).toMatchObject({interactive: false, perspective: 3});
		expect(handler().canDrag({kind: 'square', square: 'e7'})).toBe(false);
		act(() => handler().onDrop({kind: 'square', square: 'e7'}, {kind: 'square', square: 'e8'}));
		expect(TableGameCommands.act).not.toHaveBeenCalled();
	});

	it('focus for sounds set while the seat view is open', () => {
		const {handle, table} = fakeHandle();
		show(tableView(chessView()));
		render(handle, target('seat_T01_1', 'chess'));
		expect(Sounds.setTableSoundFocus).toHaveBeenLastCalledWith('500', 'T01', true);
		render(handle, null);
		expect(Sounds.setTableSoundFocus).toHaveBeenLastCalledWith('500', 'T01', false);
		expect(table.dispose).toHaveBeenCalledTimes(1);
	});
});

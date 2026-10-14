// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createOkeyTestHarness, type OkeyTestHarness} from '@app/features/table_game/components/okey/OkeyTestHarness';
import {DAMA_START_BOARD, testDamaGameView, testView} from '@app/features/table_game/state/TableGameTestViews';
import type {DamaView, TableGameSummary} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {act, createElement} from 'react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

function interpolate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	return descriptor.message.replace(/{(\w+)}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: interpolate}})}));
vi.mock('@app/features/user/state/Users', () => ({default: {getUser: (id: string) => ({id, username: `user${id}`})}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getNickname: (user: {username: string}) => user.username}));
vi.mock('@app/features/table_game/commands/TableGameCommands', () => ({
	act: vi.fn(() => Promise.resolve({ok: true})),
}));

const TableGameCommands = await import('@app/features/table_game/commands/TableGameCommands');
const {default: TableGames} = await import('@app/features/table_game/state/TableGames');
const {DamaBoard} = await import('@app/features/table_game/components/DamaBoard');

const CHANNEL = {id: '500', guildId: '9'} as never;
const NOW = Date.parse('2026-10-03T10:00:00.000Z');
let harness: OkeyTestHarness;

function show(
	gameView: Partial<Omit<DamaView, 'game'>> & {game?: 'dama' | 'dama_normal'},
	options: {viewerPosition?: number | null; status?: TableGameSummary['status']; version?: number} = {},
): void {
	act(() => {
		TableGames.reset();
		TableGames.handleView(
			'500',
			testView({
				game: gameView.game ?? 'dama',
				version: options.version ?? 7,
				status: options.status ?? 'playing',
				viewerPosition: options.viewerPosition === undefined ? 1 : options.viewerPosition,
				gameView: testDamaGameView(gameView),
			}),
			'event',
		);
	});
}

// My turn as white (position 1) with the clock running.
function myTurn(legalMoves: Array<string>, extra: Partial<Omit<DamaView, 'game'>> = {}): void {
	show({legal_moves: legalMoves, turn: 1, turn_started_at: new Date(NOW).toISOString(), ...extra});
}

async function render(): Promise<void> {
	await harness.render(createElement(DamaBoard, {channel: CHANNEL, slot: 'T01'}));
}

function square(name: string): HTMLButtonElement {
	const element = harness.host.querySelector<HTMLButtonElement>(`[data-square="${name}"]`);
	if (!element) throw new Error(`no square ${name}`);
	return element;
}

function marked(attribute: string): Array<string | null> {
	return [...harness.host.querySelectorAll(`[${attribute}]`)].map((element) => element.getAttribute('data-square'));
}

async function click(element: HTMLElement): Promise<void> {
	await act(async () => element.click());
}

async function key(name: string): Promise<void> {
	await act(async () => {
		document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {key: name, bubbles: true}));
	});
}

function focused(): string | null {
	return document.activeElement?.getAttribute('data-square') ?? null;
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	vi.mocked(TableGameCommands.act).mockClear();
	harness = createOkeyTestHarness();
});

afterEach(() => {
	harness.unmount();
	vi.useRealTimers();
});

describe('DamaBoard', () => {
	it('renders the 64-char board with my side at the bottom', async () => {
		show({board: DAMA_START_BOARD, white: 1}, {viewerPosition: 1});
		await render();
		const squares = [...harness.host.querySelectorAll('[data-square]')].map((s) => s.getAttribute('data-square'));
		expect(squares).toHaveLength(64);
		expect(squares[0]).toBe('a8');
		expect(squares[63]).toBe('h1');
		expect(marked('data-piece')).toHaveLength(32);
		expect(square('a2').getAttribute('data-piece')).toBe('w');
		expect(square('h7').getAttribute('data-piece')).toBe('b');
		expect(square('a1').getAttribute('data-piece')).toBeNull();
		harness.unmount();
		harness = createOkeyTestHarness();

		// Black (white sits at 1, I sit at 3): rank 8 at the bottom; a king reads as a king.
		show({board: `${'.'.repeat(63)}B`, white: 1, game: 'dama_normal'}, {viewerPosition: 3});
		await render();
		const flipped = [...harness.host.querySelectorAll('[data-square]')].map((s) => s.getAttribute('data-square'));
		expect(flipped[0]).toBe('h1');
		expect(flipped[63]).toBe('a8');
		expect(square('h1').getAttribute('data-piece')).toBe('B');
		expect(square('h1').getAttribute('aria-label')).toContain('Black king');
	});

	it('click piece then target sends dama_move with the full path', async () => {
		myTurn(['d4-d6-f6', 'a3-a4']);
		await render();
		await click(square('d4'));
		expect(square('d4').getAttribute('data-selected')).toBe('true');
		expect(marked('data-target')).toEqual(['f6']);
		await click(square('d6'));
		expect(TableGameCommands.act).not.toHaveBeenCalled();
		await click(square('d4'));
		await click(square('f6'));
		expect(TableGameCommands.act).toHaveBeenCalledWith('500', 'T01', {type: 'dama_move', path: ['d4', 'd6', 'f6']});
		expect(marked('data-selected')).toEqual([]);
	});

	it('several paths → path chooser', async () => {
		myTurn(['c3-c5-e5', 'c3-e3-e5', 'c3-c5-a5']);
		await render();
		await click(square('c3'));
		expect(marked('data-target').sort()).toEqual(['a5', 'e5']);
		await click(square('e5'));
		expect(TableGameCommands.act).not.toHaveBeenCalled();
		const choices = [...harness.host.querySelectorAll<HTMLButtonElement>('[data-path]')];
		expect(choices.map((choice) => choice.getAttribute('data-path'))).toEqual(['c3-c5-e5', 'c3-e3-e5']);
		expect(choices[1]!.textContent).toBe('c3 → e3 → e5');
		await click(choices[1]!);
		expect(TableGameCommands.act).toHaveBeenCalledWith('500', 'T01', {type: 'dama_move', path: ['c3', 'e3', 'e5']});
		expect(harness.host.querySelector('[data-path]')).toBeNull();
	});

	it('a presence-check version bump keeps my selection and path choice; a real move drops them', async () => {
		const turn = {
			legal_moves: ['c3-c5-e5', 'c3-e3-e5'],
			turn: 1 as const,
			turn_started_at: new Date(NOW).toISOString(),
		};
		show(turn);
		await render();
		await click(square('c3'));
		// The server's minute presence check writes the table again: a newer version, the same game.
		show(turn, {version: 8});
		expect(marked('data-selected')).toEqual(['c3']);
		await click(square('e5'));
		show(turn, {version: 9});
		expect(harness.host.querySelectorAll('[data-path]')).toHaveLength(2);
		show({...turn, turn: 3, legal_moves: null, turn_started_at: new Date(NOW + 1000).toISOString()}, {version: 10});
		expect(harness.host.querySelector('[data-path]')).toBeNull();
	});

	it('legal targets highlighted only on my turn', async () => {
		myTurn(['c3-c4', 'c3-d3', 'f3-f4']);
		await render();
		expect(marked('data-movable').sort()).toEqual(['c3', 'f3']);
		await click(square('c3'));
		expect(marked('data-target').sort()).toEqual(['c4', 'd3']);
		harness.unmount();
		harness = createOkeyTestHarness();

		// Not my turn: the server sends no legal moves; nothing is movable or selectable.
		show({legal_moves: null, turn: 3, turn_started_at: new Date(NOW).toISOString()});
		await render();
		await click(square('c3'));
		expect(marked('data-movable')).toEqual([]);
		expect(marked('data-selected')).toEqual([]);
		expect(marked('data-target')).toEqual([]);
	});

	it('spectator cannot move', async () => {
		show({legal_moves: null, turn: 1, turn_started_at: new Date(NOW).toISOString()}, {viewerPosition: null});
		await render();
		await click(square('a3'));
		await click(square('a4'));
		expect(marked('data-selected')).toEqual([]);
		expect(TableGameCommands.act).not.toHaveBeenCalled();
	});

	it("clocks count down for the side the view's turn names", async () => {
		show({
			white: 1,
			turn: 3,
			clocks_ms: {white: 600_000, black: 300_000},
			turn_started_at: new Date(NOW - 5000).toISOString(),
		});
		await render();
		const clock = (side: 'white' | 'black') => harness.host.querySelector(`[data-clock="${side}"]`)!;
		expect(clock('white').textContent).toBe('10:00');
		expect(clock('black').textContent).toBe('4:55');
		expect(clock('black').getAttribute('data-running')).toBe('true');
		await act(() => vi.advanceTimersByTimeAsync(2000));
		expect(clock('black').textContent).toBe('4:53');
		expect(clock('white').textContent).toBe('10:00');

		harness.unmount();
		harness = createOkeyTestHarness();
		show({turn: null, turn_started_at: new Date(NOW).toISOString()}, {status: 'ended'});
		await render();
		expect(harness.host.querySelector('[data-running]')).toBeNull();
	});

	it('keyboard: arrows + Enter play a move', async () => {
		myTurn(['a3-a4', 'c3-c4']);
		await render();
		const tabStops = [...harness.host.querySelectorAll<HTMLButtonElement>('[data-square]')].filter(
			(element) => element.tabIndex === 0,
		);
		expect(tabStops.map((element) => element.getAttribute('data-square'))).toEqual(['a1']);
		act(() => square('a1').focus());
		await key('ArrowUp');
		await key('ArrowUp');
		expect(focused()).toBe('a3');
		await key('ArrowLeft');
		expect(focused()).toBe('a3');
		await key('Enter');
		expect(square('a3').getAttribute('data-selected')).toBe('true');
		await key('ArrowUp');
		expect(focused()).toBe('a4');
		await key('Enter');
		expect(TableGameCommands.act).toHaveBeenCalledWith('500', 'T01', {type: 'dama_move', path: ['a3', 'a4']});
	});

	it('drag a piece onto a legal square sends the move; elsewhere nothing', async () => {
		myTurn(['c3-c4', 'c3-d3']);
		await render();
		harness.drag(square('c3'), square('c5'));
		expect(TableGameCommands.act).not.toHaveBeenCalled();
		harness.drag(square('c3'), square('d3'));
		expect(TableGameCommands.act).toHaveBeenCalledWith('500', 'T01', {type: 'dama_move', path: ['c3', 'd3']});
	});

	it('marks the last move and the squares it captured', async () => {
		show({last_move: ['d4', 'd6', 'f6'], last_captured: ['d5', 'e6']});
		await render();
		expect(marked('data-last').sort()).toEqual(['d4', 'd6', 'f6']);
		expect(marked('data-captured').sort()).toEqual(['d5', 'e6']);
	});

	it('fits 390 px: the board is fluid, nothing is wider than a 358 px column', () => {
		// Vitest runs from fluxer_app; happy-dom gives import.meta.url no file scheme.
		const css = readFileSync(join(process.cwd(), 'src/features/table_game/components/DamaBoard.module.css'), 'utf8');
		expect(css).toMatch(/\.root\s*{[^}]*width:\s*min\(100%,\s*22rem\)/);
		expect(css).toMatch(/grid-template-columns:\s*repeat\(8,\s*minmax\(0,\s*1fr\)\)/);
		const fixed = [...css.matchAll(/(?:^|[\s;{])(?:min-)?width:\s*([\d.]+)(rem|px)/g)].map(([, value, unit]) =>
			unit === 'rem' ? Number(value) * 16 : Number(value),
		);
		expect(fixed.every((px) => px <= 358)).toBe(true);
	});
});

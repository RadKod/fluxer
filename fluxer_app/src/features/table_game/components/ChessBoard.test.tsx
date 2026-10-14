// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {testChessGameView, testView} from '@app/features/table_game/state/TableGameTestViews';
import type {ChessView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {act, createElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
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
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick}: {children: ReactNode; onClick: () => void}) =>
		createElement('button', {type: 'button', onClick}, children),
}));

const TableGameCommands = await import('@app/features/table_game/commands/TableGameCommands');
const {default: TableGames} = await import('@app/features/table_game/state/TableGames');
const {ChessBoard} = await import('@app/features/table_game/components/ChessBoard');

const CHANNEL = {id: '500', guildId: '9'} as never;
const NOW = Date.parse('2026-10-03T10:00:00.000Z');
let root: Root | null = null;
let host: HTMLDivElement;

function show(
	gameView: Partial<ChessView>,
	options: {viewerPosition?: number | null; status?: 'playing' | 'ended'; result?: unknown; version?: number} = {},
): void {
	act(() => {
		TableGames.reset();
		TableGames.handleView(
			'500',
			testView({
				game: 'chess',
				version: options.version ?? 7,
				status: options.status ?? 'playing',
				viewerPosition: options.viewerPosition === undefined ? 1 : options.viewerPosition,
				gameView: testChessGameView(gameView),
				summary: {result: (options.result ?? null) as never},
			}),
			'event',
		);
	});
}

async function render(): Promise<void> {
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(createElement(ChessBoard, {channel: CHANNEL, slot: 'T01'})));
}

function square(name: string): HTMLButtonElement {
	const element = host.querySelector<HTMLButtonElement>(`[data-square="${name}"]`);
	if (!element) throw new Error(`no square ${name}`);
	return element;
}

async function click(element: HTMLElement): Promise<void> {
	await act(async () => element.click());
}

function clockText(side: 'white' | 'black'): string {
	return host.querySelector(`[data-clock="${side}"]`)?.textContent ?? '';
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	vi.mocked(TableGameCommands.act).mockClear();
});

afterEach(() => {
	act(() => root?.unmount());
	host.remove();
	vi.useRealTimers();
});

describe('ChessBoard', () => {
	it('renders from FEN for white at the bottom of my side', async () => {
		show({white: 1}, {viewerPosition: 1});
		await render();
		const squares = [...host.querySelectorAll('[data-square]')].map((element) => element.getAttribute('data-square'));
		expect(squares).toHaveLength(64);
		expect(squares[0]).toBe('a8');
		expect(squares[63]).toBe('h1');
		expect(square('e1').getAttribute('data-piece')).toBe('K');
		expect(square('e8').getAttribute('data-piece')).toBe('k');
		act(() => root!.unmount());
		host.remove();
		show({white: 1}, {viewerPosition: 3});
		await render();
		const flipped = [...host.querySelectorAll('[data-square]')].map((element) => element.getAttribute('data-square'));
		expect(flipped[0]).toBe('h1');
		expect(flipped[63]).toBe('a8');
	});

	it('click piece then legal target sends move with version', async () => {
		show({legal_moves: ['e2e4', 'e2e3', 'g1f3'], turn_started_at: new Date(NOW).toISOString()});
		await render();
		await click(square('e2'));
		expect(square('e2').getAttribute('data-selected')).toBe('true');
		expect(square('e4').getAttribute('data-target')).toBe('true');
		expect(square('d4').getAttribute('data-target')).toBeNull();
		await click(square('d4'));
		expect(TableGameCommands.act).not.toHaveBeenCalled();
		await click(square('e2'));
		await click(square('e4'));
		expect(TableGameCommands.act).toHaveBeenCalledWith('500', 'T01', {type: 'move', from: 'e2', to: 'e4'});
	});

	it('promotion picker for pawn to last rank', async () => {
		show({
			fen: '8/4P3/8/8/8/8/k7/4K3 w - - 0 1',
			legal_moves: ['e7e8q', 'e7e8r', 'e7e8b', 'e7e8n', 'e1d1'],
			turn_started_at: new Date(NOW).toISOString(),
		});
		await render();
		await click(square('e7'));
		await click(square('e8'));
		expect(TableGameCommands.act).not.toHaveBeenCalled();
		const knight = host.querySelector<HTMLButtonElement>('[data-promotion="n"]');
		expect(host.querySelectorAll('[data-promotion]')).toHaveLength(4);
		await click(knight!);
		expect(TableGameCommands.act).toHaveBeenCalledWith('500', 'T01', {
			type: 'move',
			from: 'e7',
			to: 'e8',
			promotion: 'n',
		});
	});

	it('a presence-check version bump keeps the promotion picker; a real move drops it', async () => {
		const position = {
			fen: '8/4P3/8/8/8/8/k7/4K3 w - - 0 1',
			legal_moves: ['e7e8q', 'e7e8r', 'e7e8b', 'e7e8n', 'e1d1'],
			turn_started_at: new Date(NOW).toISOString(),
		};
		show(position);
		await render();
		await click(square('e7'));
		await click(square('e8'));
		// The server's minute presence check writes the table again: a newer version, the same game.
		show(position, {version: 8});
		expect(host.querySelectorAll('[data-promotion]')).toHaveLength(4);
		show({...position, fen: '8/4P3/8/8/8/8/k7/3K4 b - - 1 1', legal_moves: null}, {version: 9});
		expect(host.querySelector('[data-promotion]')).toBeNull();
	});

	it('clocks count down locally from turn_started_at', async () => {
		show({
			clocks_ms: {white: 600_000, black: 300_000},
			turn_started_at: new Date(NOW - 5000).toISOString(),
			legal_moves: ['e2e4'],
		});
		await render();
		expect(clockText('white')).toBe('9:55');
		expect(clockText('black')).toBe('5:00');
		await act(() => vi.advanceTimersByTimeAsync(2000));
		expect(clockText('white')).toBe('9:53');
		expect(clockText('black')).toBe('5:00');
	});

	it('spectator cannot move', async () => {
		show({legal_moves: null, turn_started_at: new Date(NOW).toISOString()}, {viewerPosition: null});
		await render();
		await click(square('e2'));
		await click(square('e4'));
		expect(square('e2').getAttribute('data-selected')).toBeNull();
		expect(TableGameCommands.act).not.toHaveBeenCalled();
	});

	// The result banner is the panel's (TableGamePanel.test.tsx).
	it('an ended game stops the clocks and shows no result banner of its own', async () => {
		show({}, {status: 'ended', result: {kind: 'win', winners: [3], reason: 'checkmate'}});
		await render();
		expect(host.querySelector('[data-result]')).toBeNull();
		expect(host.querySelector('[data-clock="white"]')?.getAttribute('data-running')).toBeNull();
	});
});

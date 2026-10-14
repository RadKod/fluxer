// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {testView} from '@app/features/table_game/state/TableGameTestViews';
import type {TavlaView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {act, createElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({
		i18n: {
			_: (d: {message: string}, values: Record<string, unknown> = {}) =>
				d.message.replace(/\{(\w+)\}/g, (token, key: string) => (key in values ? String(values[key]) : token)),
		},
	}),
}));
vi.mock('@app/features/table_game/commands/TableGameCommands', () => ({act: vi.fn(() => Promise.resolve({ok: true}))}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick, disabled}: {children: ReactNode; onClick: () => void; disabled?: boolean}) =>
		createElement('button', {type: 'button', onClick, disabled}, children),
}));

const TableGameCommands = await import('@app/features/table_game/commands/TableGameCommands');
const {default: TableGames} = await import('@app/features/table_game/state/TableGames');
const {TavlaBoard} = await import('@app/features/table_game/components/TavlaBoard');
const TavlaSteps = await import('@app/features/table_game/utils/TavlaSteps');
const NOW = Date.parse('2026-10-03T10:00:00Z');
let root: Root;
let host: HTMLDivElement;

function show(
	overrides: Partial<TavlaView> = {},
	viewerPosition: number | null = 1,
	version = 7,
	status: 'playing' | 'ended' = 'playing',
): void {
	const points = Array<number>(24).fill(0);
	points[23] = 2;
	act(() => {
		TableGames.reset();
		TableGames.handleView(
			'500',
			testView({
				game: 'tavla',
				version,
				viewerPosition,
				status,
				gameView: {
					game: 'tavla',
					white: 1,
					points,
					bar: {white: 0, black: 0},
					off: {white: 0, black: 0},
					turn: 1,
					dice: [6, 5],
					opening: null,
					deadline_at: new Date(NOW + 40_000).toISOString(),
					last_moves: [],
					legal_moves: ['24/19 19/13'],
					...overrides,
				},
			}),
			'event',
		);
	});
}
async function render(): Promise<void> {
	await act(async () => root.render(createElement(TavlaBoard, {channel: {id: '500'} as never, slot: 'T01'})));
}
function point(n: number | 'bar' | 'off'): HTMLButtonElement {
	const p = host.querySelector<HTMLButtonElement>(`[data-point="${n}"]`);
	if (!p) throw new Error(`missing point ${n}`);
	return p;
}
function button(text: string): HTMLButtonElement {
	const b = [...host.querySelectorAll('button')].find((b) => b.textContent === text);
	if (!b) throw new Error(`missing button ${text}`);
	return b;
}
async function click(element: HTMLElement): Promise<void> {
	await act(async () => element.click());
}
async function move(from: number | 'bar', to: number | 'off'): Promise<void> {
	await click(point(from));
	await click(point(to));
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	vi.mocked(TableGameCommands.act).mockReset().mockResolvedValue({ok: true});
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
});

describe('TavlaBoard', () => {
	it('shows dice, previews local steps, Undo pops, incomplete Done sends nothing', async () => {
		show();
		await render();
		expect(host.querySelector('[data-dice]')?.textContent).toContain('6');
		expect(host.querySelector('[data-dice]')?.textContent).toContain('5');
		expect(host.querySelectorAll('[data-point]').length).toBe(26);
		await move(24, 19);
		expect(point(24).dataset.count).toBe('1');
		expect(point(19).dataset.count).toBe('1');
		expect(button('Done').disabled).toBe(true);
		await click(button('Done'));
		expect(TableGameCommands.act).not.toHaveBeenCalled();
		await click(button('Undo'));
		expect(point(24).dataset.count).toBe('2');
		expect(point(19).dataset.count).toBe('0');
	});
	it('auto-sends the complete sequence exactly once and stays locked until a new version', async () => {
		show();
		await render();
		await move(24, 19);
		await move(19, 13);
		await click(button('Done'));
		await move(24, 19);
		expect(TableGameCommands.act).toHaveBeenCalledTimes(1);
		expect(TableGameCommands.act).toHaveBeenCalledWith('500', 'T01', {
			type: 'tavla_move',
			moves: [
				{from: 24, to: 19},
				{from: 19, to: 13},
			],
		});
	});
	it('6-5 played as 24/18 18/13 is accepted when legal_moves lists 24/19 19/13', async () => {
		show();
		await render();
		await move(24, 18);
		await move(18, 13);
		expect(TableGameCommands.act).toHaveBeenCalledWith('500', 'T01', {
			type: 'tavla_move',
			moves: [
				{from: 24, to: 18},
				{from: 18, to: 13},
			],
		});
	});
	it.each([
		[null, 1, 'playing'],
		[3, 1, 'playing'],
		[1, 1, 'ended'],
	] as const)('read-only viewer=%s turn=%s status=%s despite legal payload', async (viewer, turn, status) => {
		show({turn}, viewer, 7, status);
		await render();
		await move(24, 19);
		expect(host.querySelector('[data-target="true"]')).toBeNull();
		expect(TableGameCommands.act).not.toHaveBeenCalled();
		expect(point(24).dataset.count).toBe('2');
	});
	it('only legal targets and physically present sources; alternate point with opponent is excluded', async () => {
		const points = Array<number>(24).fill(0);
		points[23] = 1;
		points[17] = -1;
		show({points});
		await render();
		await click(point(19));
		expect(point(19).dataset.selected).toBeUndefined();
		await click(point(24));
		expect(point(19).dataset.target).toBe('true');
		expect(point(18).dataset.target).toBeUndefined();
		await click(point(17));
		expect(TableGameCommands.act).not.toHaveBeenCalled();
	});
	it('bar entry has priority; local capture updates the opponent bar', async () => {
		const points = Array<number>(24).fill(0);
		points[23] = 1;
		points[21] = -1;
		show({points, dice: [3, 2], bar: {white: 1, black: 0}, legal_moves: ['bar/22 24/22']});
		await render();
		await click(point(24));
		expect(point(24).dataset.selected).toBeUndefined();
		await move('bar', 22);
		expect(point(22).dataset.count).toBe('1');
		expect(host.querySelector('[data-bar="black"]')?.textContent).toContain('1');
		await move(24, 22);
		expect(TableGameCommands.act).toHaveBeenCalledTimes(1);
	});
	it('a presence-check version bump keeps half-played tavla steps', async () => {
		show();
		await render();
		const roll = host.querySelector('[data-dice]')?.getAttribute('data-roll');
		await move(24, 19);
		// The server's minute presence check writes the table again: a newer version, the same game.
		show({}, 1, 8);
		expect(point(24).dataset.count).toBe('1');
		expect(point(19).dataset.count).toBe('1');
		expect(button('Undo').disabled).toBe(false);
		expect(host.querySelector('[data-dice]')?.getAttribute('data-roll')).toBe(roll);
		await move(19, 13);
		expect(TableGameCommands.act).toHaveBeenCalledTimes(1);
	});
	it('a real move clears preview and selection, including equal consecutive dice', async () => {
		show();
		await render();
		const roll = host.querySelector('[data-dice]')?.getAttribute('data-roll');
		await move(24, 19);
		await click(point(19));
		show({last_moves: [{from: 24, to: 18, hit: false}]}, 1, 8);
		expect(point(24).dataset.count).toBe('2');
		expect(point(19).dataset.count).toBe('0');
		expect(host.querySelector('[data-selected="true"]')).toBeNull();
		expect(host.querySelector('[data-dice]')?.getAttribute('data-roll')).not.toBe(roll);
		await move(24, 19);
		await move(19, 13);
		expect(TableGameCommands.act).toHaveBeenCalledTimes(1);
	});
	it('turn change resets local steps even with the same version', async () => {
		show();
		await render();
		await move(24, 19);
		show({turn: 3});
		expect(point(19).dataset.count).toBe('0');
		expect(button('Undo').disabled).toBe(true);
	});
	it('server failure preserves the complete preview for one explicit Done retry', async () => {
		vi.mocked(TableGameCommands.act).mockResolvedValueOnce({ok: false, error: 'failed'});
		show();
		await render();
		await move(24, 19);
		await move(19, 13);
		expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not reach');
		expect(TableGameCommands.act).toHaveBeenCalledTimes(1);
		expect(button('Done').disabled).toBe(false);
		await click(button('Done'));
		await click(button('Done'));
		expect(TableGameCommands.act).toHaveBeenCalledTimes(2);
	});
	it('late failure from an old version does not alter the new turn', async () => {
		let resolve!: (value: {ok: false; error: 'failed'}) => void;
		vi.mocked(TableGameCommands.act).mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		show();
		await render();
		await move(24, 19);
		await move(19, 13);
		show({last_moves: [{from: 24, to: 18, hit: false}]}, 1, 8);
		await act(async () => resolve({ok: false, error: 'failed'}));
		expect(host.querySelector('[role="alert"]')).toBeNull();
		expect(point(24).dataset.count).toBe('2');
	});
	it('turn ring counts down locally and stops at zero', async () => {
		show();
		await render();
		expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('40');
		await act(() => vi.advanceTimersByTimeAsync(2000));
		expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('38');
		await act(() => vi.advanceTimersByTimeAsync(50_000));
		expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('0');
	});
	it('keyboard arrows navigate points and Enter plays; Escape clears selection', async () => {
		show();
		await render();
		point(24).focus();
		await act(async () => point(24).dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})));
		expect(point(24).dataset.selected).toBe('true');
		await act(async () => point(24).dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowLeft', bubbles: true})));
		expect(document.activeElement).toBe(point(23));
		await act(async () => point(19).dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})));
		expect(point(19).dataset.count).toBe('1');
		await act(async () => point(19).dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})));
		expect(host.querySelector('[data-selected="true"]')).toBeNull();
	});
	it('countdown ticks do not rescan legal turn sequences', async () => {
		const scan = vi.spyOn(TavlaSteps, 'nextLegalSteps');
		show();
		await render();
		const calls = scan.mock.calls.length;
		await act(() => vi.advanceTimersByTimeAsync(1000));
		expect(scan).toHaveBeenCalledTimes(calls);
		scan.mockRestore();
	});
	it.each([
		['bar', 'ArrowUp', 15],
		['bar', 'ArrowDown', 10],
		['off', 'ArrowUp', 21],
		['off', 'ArrowDown', 4],
		[13, 'ArrowDown', 'bar'],
		[24, 'ArrowDown', 'off'],
		[12, 'ArrowUp', 'bar'],
		[1, 'ArrowUp', 'off'],
	] as const)('keyboard visual rows: %s %s focuses %s', async (from, key, target) => {
		show();
		await render();
		point(from).focus();
		await act(async () => point(from).dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true})));
		expect(document.activeElement).toBe(point(target));
	});
	it('horizontal arrows stay within the current visual row', async () => {
		show();
		await render();
		for (const [from, key, target] of [
			[13, 'ArrowLeft', 13],
			[24, 'ArrowRight', 24],
			[12, 'ArrowLeft', 12],
			[1, 'ArrowRight', 1],
			['bar', 'ArrowLeft', 'bar'],
			['off', 'ArrowRight', 'off'],
			['bar', 'ArrowRight', 'off'],
			['off', 'ArrowLeft', 'bar'],
		] as const) {
			point(from).focus();
			await act(async () => point(from).dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true})));
			expect(document.activeElement).toBe(point(target));
		}
	});
});

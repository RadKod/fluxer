// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {createOkeyTestHarness, type OkeyTestHarness} from '@app/features/table_game/components/okey/OkeyTestHarness';
import {testOkeyGameView, testView} from '@app/features/table_game/state/TableGameTestViews';
import type {OkeyView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {act, createElement, type ReactNode} from 'react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

function interpolate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	return descriptor.message.replace(/{(\w+)}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: interpolate}})}));
// The real store's synced settings import UserSettings lazily, which needs the app bootstrap; no sound plays here.
vi.mock('@app/features/ui/commands/SoundCommands', () => ({playSound: vi.fn()}));
vi.mock('@app/features/user/state/Users', () => ({default: {getUser: (id: string) => ({id, username: `user${id}`})}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getNickname: (user: {username: string}) => user.username}));
vi.mock('@app/features/table_game/commands/TableGameCommands', () => ({
	act: vi.fn(() => Promise.resolve({ok: true})),
}));
vi.mock('@app/features/table_game/sound/TableGameSounds', async (importOriginal) => ({
	...(await importOriginal<object>()),
	playTableUiSound: vi.fn(),
}));
// The two rack sounds by their contract values.
vi.mock('@app/features/notification/utils/SoundUtils', async (importOriginal) => {
	const original = await importOriginal<{SoundType: object}>();
	return {
		...original,
		SoundType: {
			...original.SoundType,
			TableGameTilePlace: 'table-game-tile-place',
			TableGameTileDrag: 'table-game-tile-drag',
		},
	};
});
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick, disabled, ...rest}: Record<string, unknown> & {children: ReactNode}) =>
		createElement(
			'button',
			{
				type: 'button',
				onClick,
				disabled,
				...Object.fromEntries(Object.entries(rest).filter(([key]) => key.startsWith('data-'))),
			},
			children,
		),
}));

const TableGameCommands = await import('@app/features/table_game/commands/TableGameCommands');
const {playTableUiSound} = await import('@app/features/table_game/sound/TableGameSounds');
const {default: TableGames} = await import('@app/features/table_game/state/TableGames');
const {OkeyBoard} = await import('@app/features/table_game/components/okey/OkeyBoard');
const {RACK_COLUMNS, layoutRack, rackGroups} = await import('@app/features/table_game/components/okey/OkeyRackModel');

const CHANNEL = {id: '500', guildId: '9'} as never;
// Indicator t5 is yellow 6, so the okey is yellow 7: t6 and t58 are wild; t104 and t105 are the fake okeys.
const RACK_14 = ['t0', 't1', 't2', 't13', 't14', 't15', 't26', 't27', 't28', 't39', 't40', 't41', 't6', 't104'];
let harness: OkeyTestHarness;

function show(gameView: Partial<OkeyView>, viewerPosition: number | null = 1): void {
	act(() => {
		TableGames.reset();
		TableGames.handleView('500', testView({version: 3, viewerPosition, gameView: testOkeyGameView(gameView)}), 'event');
	});
}

// Lays the named tiles out with gaps; the rest of the rack follows in server order.
function arrange(order: ReadonlyArray<string | null>): void {
	const view = TableGames.getView('500', 'T01')?.game_view;
	const rack = view?.game === 'okey' || view?.game === 'okey101' ? (view.rack ?? []) : [];
	act(() => TableGames.setRackOrder('500', 'T01', [...order, ...rack.filter((tile) => !order.includes(tile))]));
}

function cell(index: number): HTMLButtonElement {
	const element = harness.host.querySelector<HTMLButtonElement>(`[data-rack-cell="${index}"]`);
	if (!element) throw new Error(`no rack cell ${index}`);
	return element;
}

function tileAt(index: number): string | null {
	return cell(index).getAttribute('data-tile');
}

function button(action: string): HTMLButtonElement {
	const element = harness.host.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
	if (!element) throw new Error(`no ${action} button`);
	return element;
}

async function click(element: HTMLElement): Promise<void> {
	await act(async () => element.click());
}

async function render(): Promise<void> {
	await harness.render(createElement(OkeyBoard, {channel: CHANNEL, slot: 'T01'}));
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	harness = createOkeyTestHarness();
	vi.mocked(TableGameCommands.act).mockClear();
	vi.mocked(playTableUiSound).mockClear();
});

afterEach(() => {
	harness.unmount();
});

describe('OkeyRack', () => {
	it('two-row rack with gaps; drag reorders locally (no request)', async () => {
		show({rack: RACK_14});
		arrange(['t0', 't1', 't2', null, 't13', 't14', 't15']);
		await render();
		const rows = harness.host.querySelectorAll('[data-rack-row]');
		expect(rows).toHaveLength(2);
		for (const row of rows) expect(row.querySelectorAll('[data-rack-cell]')).toHaveLength(RACK_COLUMNS);
		expect(tileAt(2)).toBe('t2');
		expect(tileAt(3)).toBeNull();
		expect(tileAt(4)).toBe('t13');

		harness.drag(cell(0), cell(3));
		expect(tileAt(0)).toBeNull();
		expect(tileAt(3)).toBe('t0');
		harness.drag(cell(1), cell(4));
		expect(tileAt(1)).toBe('t13');
		expect(tileAt(4)).toBe('t1');
		expect(TableGames.getRack('500', 'T01').slice(0, 5)).toEqual([null, 't13', 't2', 't0', 't1']);
		expect(TableGameCommands.act).not.toHaveBeenCalled();
	});

	it('sets are the contiguous groups between gaps', () => {
		const order = [
			't0',
			't1',
			null,
			't2',
			null,
			null,
			...Array.from({length: 8}, (_, i) => `t${20 + i}`),
			't40',
			't41',
		];
		const cells = layoutRack(order);
		expect(cells).toHaveLength(RACK_COLUMNS * 2);
		// t40 sits in the last cell of the top row and t41 in the first of the bottom row: the row edge splits them.
		expect(cells[RACK_COLUMNS - 1]).toBe('t40');
		expect(cells[RACK_COLUMNS]).toBe('t41');
		expect(rackGroups(cells)).toEqual([
			['t0', 't1'],
			['t2'],
			['t20', 't21', 't22', 't23', 't24', 't25', 't26', 't27', 't40'],
			['t41'],
		]);
		expect(rackGroups(cells, 't22')).toEqual([
			['t0', 't1'],
			['t2'],
			['t20', 't21', 't23', 't24', 't25', 't26', 't27', 't40'],
			['t41'],
		]);
	});

	it('selected tile + At sends discard', async () => {
		show({rack: [...RACK_14, 't9'], phase: 'discard', rack_counts: [15, 14, 14, 14]});
		await render();
		expect(button('discard').disabled).toBe(true);
		await click(cell(RACK_14.length));
		expect(cell(RACK_14.length).getAttribute('aria-pressed')).toBe('true');
		expect(button('discard').disabled).toBe(false);
		await click(button('discard'));
		expect(TableGameCommands.act).toHaveBeenCalledWith('500', 'T01', {type: 'discard', tile: 't9'});
	});

	it("Bitir sends finish with the selected tile and the rack's sets", async () => {
		show({rack: [...RACK_14, 't9'], phase: 'discard', rack_counts: [15, 14, 14, 14]});
		arrange([
			't0',
			't1',
			't2',
			null,
			't13',
			't14',
			't15',
			null,
			't26',
			't27',
			't28',
			null,
			null,
			null,
			null,
			't39',
			't40',
			't41',
			't6',
			't104',
			null,
			't9',
		]);
		await render();
		await click(cell(21));
		await click(button('finish'));
		expect(TableGameCommands.act).toHaveBeenCalledWith('500', 'T01', {
			type: 'finish',
			tile: 't9',
			sets: [
				['t0', 't1', 't2'],
				['t13', 't14', 't15'],
				['t26', 't27', 't28'],
				['t39', 't40', 't41', 't6', 't104'],
			],
		});
	});

	it("draw buttons: Desteden / Yandan (only the previous player's top discard)", async () => {
		show({rack: RACK_14, phase: 'draw', discards: [[], ['t30'], ['t31'], ['t3', 't7']]});
		await render();
		expect(button('draw-discard').querySelector('[data-tile]')?.getAttribute('data-tile')).toBe('t7');
		await click(button('draw-discard'));
		expect(TableGameCommands.act).toHaveBeenLastCalledWith('500', 'T01', {type: 'draw', from: 'discard'});
		await click(button('draw-pile'));
		expect(TableGameCommands.act).toHaveBeenLastCalledWith('500', 'T01', {type: 'draw', from: 'pile'});

		harness.unmount();
		harness = createOkeyTestHarness();
		show({rack: RACK_14, phase: 'draw', discards: [[], ['t30'], ['t31'], []]});
		await render();
		expect(button('draw-discard').disabled).toBe(true);
		expect(button('draw-pile').disabled).toBe(false);
	});

	it('phase/turn disables actions', async () => {
		show({rack: RACK_14, phase: 'draw', turn: 2, discards: [[], [], [], ['t3']]});
		await render();
		for (const action of ['draw-pile', 'draw-discard', 'discard', 'finish']) expect(button(action).disabled).toBe(true);
		harness.unmount();
		harness = createOkeyTestHarness();
		show({rack: [...RACK_14, 't9'], phase: 'discard', turn: 1, discards: [[], [], [], ['t3']]});
		await render();
		await click(cell(0));
		expect(button('draw-pile').disabled).toBe(true);
		expect(button('draw-discard').disabled).toBe(true);
		expect(button('discard').disabled).toBe(false);
		expect(button('finish').disabled).toBe(false);
	});

	it('okey and fake okey render distinctly; indicator shown', async () => {
		show({rack: RACK_14, indicator: 't5'});
		await render();
		const indicator = harness.host.querySelector('[data-indicator] [data-tile]');
		expect(indicator?.getAttribute('data-tile')).toBe('t5');
		expect(indicator?.textContent).toContain('6');
		const wild = harness.host.querySelector('[data-rack-cell] [data-tile="t6"]');
		const fake = harness.host.querySelector('[data-rack-cell] [data-tile="t104"]');
		const plain = harness.host.querySelector('[data-rack-cell] [data-tile="t0"]');
		expect(wild?.getAttribute('data-okey')).toBe('wild');
		expect(fake?.getAttribute('data-okey')).toBe('fake');
		expect(plain?.getAttribute('data-okey')).toBeNull();
		// A fake okey plays as the okey: its label names the okey's face (yellow 7).
		expect(fake?.getAttribute('aria-label')).toContain('Yellow 7');
		expect(wild?.getAttribute('aria-label')).toContain('Okey');
	});

	it('keyboard: arrows move focus, Enter selects, Shift+arrow carries the tile', async () => {
		show({rack: RACK_14});
		arrange(['t0', 't1', 't2', null, 't13']);
		await render();
		const key = async (target: HTMLElement, init: KeyboardEventInit) =>
			act(async () => {
				target.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, ...init}));
			});
		cell(0).focus();
		await key(cell(0), {key: 'ArrowRight'});
		expect(document.activeElement).toBe(cell(1));
		expect(cell(1).tabIndex).toBe(0);
		expect(cell(0).tabIndex).toBe(-1);
		await key(cell(1), {key: 'ArrowRight', shiftKey: true});
		expect(tileAt(1)).toBe('t2');
		expect(tileAt(2)).toBe('t1');
		expect(document.activeElement).toBe(cell(2));
		await key(cell(2), {key: 'ArrowDown'});
		expect(document.activeElement).toBe(cell(2 + RACK_COLUMNS));
		expect(TableGameCommands.act).not.toHaveBeenCalled();
	});

	it('arranging sounds: the drag sound when a drag starts, the place sound when a tile lands (drag or keyboard)', async () => {
		show({rack: RACK_14});
		arrange(['t0', 't1', 't2', null, 't13']);
		await render();
		harness.drag(cell(0), cell(3));
		expect(vi.mocked(playTableUiSound).mock.calls).toEqual([['table-game-tile-drag'], ['table-game-tile-place']]);
		vi.mocked(playTableUiSound).mockClear();
		await act(async () => {
			cell(1).dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key: 'ArrowRight', shiftKey: true}));
		});
		expect(vi.mocked(playTableUiSound).mock.calls).toEqual([['table-game-tile-place']]);
		// Moving focus alone is silent.
		vi.mocked(playTableUiSound).mockClear();
		await act(async () => {
			cell(2).dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, key: 'ArrowRight'}));
		});
		expect(playTableUiSound).not.toHaveBeenCalled();
	});

	it('click a tile then an empty cell moves it there', async () => {
		show({rack: RACK_14});
		arrange(['t0', 't1', 't2', null, 't13']);
		await render();
		await click(cell(0));
		await click(cell(3));
		expect(tileAt(0)).toBeNull();
		expect(tileAt(3)).toBe('t0');
		expect(cell(3).getAttribute('aria-pressed')).toBe('false');
		expect(TableGameCommands.act).not.toHaveBeenCalled();
	});
});

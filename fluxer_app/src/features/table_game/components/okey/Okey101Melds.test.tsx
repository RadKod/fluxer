// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createOkeyTestHarness,
	type OkeyTestHarness,
	testOkey101GameView,
} from '@app/features/table_game/components/okey/OkeyTestHarness';
import {testView} from '@app/features/table_game/state/TableGameTestViews';
import type {Okey101View, TableGameSummary} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
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
const {default: TableGames} = await import('@app/features/table_game/state/TableGames');
const {OkeyBoard} = await import('@app/features/table_game/components/okey/OkeyBoard');

const CHANNEL = {id: '500', guildId: '9'} as never;
// 21 tiles; t0-t2 yellow 1-3, t13-t15 blue 1-3, t9 yellow 10.
const RACK = [
	't0',
	't1',
	't2',
	't13',
	't14',
	't15',
	't9',
	't30',
	't31',
	't32',
	't33',
	't34',
	't35',
	't36',
	't37',
	't38',
	't40',
	't41',
	't42',
	't43',
	't44',
];
const MELDS: Okey101View['melds'] = [
	{id: 0, owner: 2, kind: 'run', tiles: ['t20', 't21', 't22']},
	{id: 1, owner: 1, kind: 'group', tiles: ['t3', 't16', 't29']},
];
let harness: OkeyTestHarness;

function show(
	gameView: Partial<Okey101View>,
	options: {status?: TableGameSummary['status']; result?: TableGameSummary['result']} = {},
): void {
	act(() => {
		TableGames.reset();
		TableGames.handleView(
			'500',
			testView({
				game: 'okey101',
				version: 4,
				status: options.status ?? 'playing',
				gameView: testOkey101GameView(gameView),
				summary: {result: options.result ?? null},
			}),
			'event',
		);
	});
}

function arrange(order: ReadonlyArray<string | null>): void {
	const view = TableGames.getView('500', 'T01')?.game_view;
	const rack = view && (view.game === 'okey' || view.game === 'okey101') ? (view.rack ?? []) : [];
	act(() => TableGames.setRackOrder('500', 'T01', [...order, ...rack.filter((tile) => !order.includes(tile))]));
}

function cell(index: number): HTMLButtonElement {
	const element = harness.host.querySelector<HTMLButtonElement>(`[data-rack-cell="${index}"]`);
	if (!element) throw new Error(`no rack cell ${index}`);
	return element;
}

function cellOf(tile: string): HTMLButtonElement {
	const element = harness.host.querySelector<HTMLButtonElement>(`[data-rack-cell][data-tile="${tile}"]`);
	if (!element) throw new Error(`no rack tile ${tile}`);
	return element;
}

function button(action: string, scope: ParentNode = harness.host): HTMLButtonElement {
	const element = scope.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
	if (!element) throw new Error(`no ${action} button`);
	return element;
}

function meld(id: number): HTMLElement {
	const element = harness.host.querySelector<HTMLElement>(`[data-meld="${id}"]`);
	if (!element) throw new Error(`no meld ${id}`);
	return element;
}

async function click(element: HTMLElement): Promise<void> {
	await act(async () => element.click());
}

async function render(): Promise<void> {
	await harness.render(createElement(OkeyBoard, {channel: CHANNEL, slot: 'T01'}));
}

async function rerender(): Promise<void> {
	harness.unmount();
	harness = createOkeyTestHarness();
	await render();
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	harness = createOkeyTestHarness();
	vi.mocked(TableGameCommands.act).mockClear();
});

afterEach(() => {
	harness.unmount();
});

describe('Okey101Melds', () => {
	it('Aç sends meld with the selected groups', async () => {
		show({rack: RACK, phase: 'play', rack_counts: [21, 21, 21, 21]});
		arrange(['t0', 't1', 't2', null, 't13', 't14', 't15', null, 't9']);
		await render();
		expect(button('open').disabled).toBe(true);
		for (const tile of ['t0', 't1', 't2', 't13', 't14', 't15']) await click(cellOf(tile));
		await click(button('open'));
		expect(TableGameCommands.act).toHaveBeenCalledWith('500', 'T01', {
			type: 'meld',
			open: [
				['t0', 't1', 't2'],
				['t13', 't14', 't15'],
			],
		});
	});

	it('a lone selected tile is not a set: no request, the reason is shown', async () => {
		show({rack: RACK, phase: 'play'});
		arrange(['t0', 't1', 't2', null, 't9']);
		await render();
		for (const tile of ['t0', 't1', 't2', 't9']) await click(cellOf(tile));
		await click(button('open'));
		expect(TableGameCommands.act).not.toHaveBeenCalled();
		expect(harness.host.querySelector('[role="alert"]')?.textContent).toBe('Those tiles do not make a valid set.');
	});

	it('İşle: pick tiles then a table meld and side (start/end)', async () => {
		show({rack: [...RACK.slice(0, 19), 't23', 't19'], melds: MELDS, opened: ['sets', 'sets', 'none', 'none']});
		await render();
		expect(button('add-end', meld(0)).disabled).toBe(true);
		await click(cellOf('t23'));
		await click(button('add-end', meld(0)));
		expect(TableGameCommands.act).toHaveBeenLastCalledWith('500', 'T01', {
			type: 'meld',
			add: [{meld_id: 0, tiles: ['t23'], at: 'end'}],
		});
		await click(cellOf('t19'));
		await click(button('add-start', meld(0)));
		expect(TableGameCommands.act).toHaveBeenLastCalledWith('500', 'T01', {
			type: 'meld',
			add: [{meld_id: 0, tiles: ['t19'], at: 'start'}],
		});

		show({rack: [...RACK.slice(0, 19), 't23', 't19'], melds: MELDS, opened: ['none', 'sets', 'none', 'none']});
		await rerender();
		await click(cellOf('t23'));
		expect(button('add-end', meld(0)).disabled).toBe(true);
	});

	it('Yandan al + aç/işle is one take_discard action', async () => {
		show({rack: RACK, phase: 'draw', discards: [[], [], [], ['t44', 't3']]});
		arrange(['t0', 't1', 't2', null]);
		await render();
		expect(button('open').disabled).toBe(true);
		await click(button('take-discard'));
		const taken = cellOf('t3');
		expect(taken.getAttribute('aria-pressed')).toBe('true');
		await click(cell(3));
		expect(cell(3).getAttribute('data-tile')).toBe('t3');
		for (const tile of ['t0', 't1', 't2', 't3']) await click(cellOf(tile));
		await click(button('open'));
		expect(TableGameCommands.act).toHaveBeenCalledTimes(1);
		expect(TableGameCommands.act).toHaveBeenCalledWith('500', 'T01', {
			type: 'take_discard',
			open: [['t0', 't1', 't2', 't3']],
		});

		show({
			rack: RACK,
			phase: 'draw',
			discards: [[], [], [], ['t23']],
			melds: MELDS,
			opened: ['sets', 'none', 'none', 'none'],
		});
		await rerender();
		await click(button('take-discard'));
		await click(button('add-end', meld(0)));
		expect(TableGameCommands.act).toHaveBeenLastCalledWith('500', 'T01', {
			type: 'take_discard',
			add: [{meld_id: 0, tiles: ['t23'], at: 'end'}],
		});

		await click(button('take-cancel'));
		expect(harness.host.querySelector('[data-rack-cell][data-tile="t23"]')).toBeNull();
		expect(button('take-discard').disabled).toBe(false);
	});

	it('a presence-check version bump keeps the side tile I took', async () => {
		show({rack: RACK, phase: 'draw', discards: [[], [], [], ['t44', 't3']]});
		await render();
		await click(button('take-discard'));
		// The server's minute presence check writes the table again: a newer version, the same game.
		act(() => {
			const view = TableGames.getView('500', 'T01')!;
			TableGames.handleView('500', {...view, summary: {...view.summary, version: view.summary.version + 1}}, 'event');
		});
		expect(cellOf('t3').getAttribute('aria-pressed')).toBe('true');
	});

	it('penalty and opened badges per player', async () => {
		show({rack: RACK, opened: ['sets', 'none', 'pairs', 'none'], penalties: [0, 101, 0, 202]});
		await render();
		const seat = (position: number) => harness.host.querySelector(`[data-seat-position="${position}"]`)!;
		expect(seat(1).querySelector('[data-opened]')?.getAttribute('data-opened')).toBe('sets');
		expect(seat(3).querySelector('[data-opened]')?.getAttribute('data-opened')).toBe('pairs');
		expect(seat(2).querySelector('[data-opened]')).toBeNull();
		expect(seat(2).querySelector('[data-penalty]')?.textContent).toContain('101');
		expect(seat(4).querySelector('[data-penalty]')?.textContent).toContain('202');
		expect(seat(1).querySelector('[data-penalty]')).toBeNull();
	});

	it('end-of-hand score table', async () => {
		show(
			{rack: ['t9'], turn: null, scores: [-101, 202, 48, 30], opened: ['sets', 'none', 'sets', 'pairs']},
			{status: 'ended', result: {kind: 'win', winners: [1], reason: 'score', finish: 'normal'}},
		);
		await render();
		const rows = [...harness.host.querySelectorAll('[data-scores] [data-score-position]')];
		expect(rows.map((row) => row.getAttribute('data-score-position'))).toEqual(['1', '4', '3', '2']);
		expect(rows[0]!.textContent).toContain('user100');
		expect(rows[0]!.textContent).toContain('-101');
		expect(rows[0]!.getAttribute('data-winner')).toBe('true');
		expect(rows[3]!.textContent).toContain('202');
		expect(rows[3]!.getAttribute('data-winner')).toBeNull();
	});
});

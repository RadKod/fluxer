// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {createOkeyTestHarness, type OkeyTestHarness} from '@app/features/table_game/components/okey/OkeyTestHarness';
import {testOkeyGameView, testView} from '@app/features/table_game/state/TableGameTestViews';
import type {OkeyView, TableGameSummary} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
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
// The place sound by its contract value.
vi.mock('@app/features/notification/utils/SoundUtils', async (importOriginal) => {
	const original = await importOriginal<{SoundType: object}>();
	return {...original, SoundType: {...original.SoundType, TableGameTilePlace: 'table-game-tile-place'}};
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

const {playTableUiSound} = await import('@app/features/table_game/sound/TableGameSounds');
const {default: TableGames} = await import('@app/features/table_game/state/TableGames');
const {OkeyBoard} = await import('@app/features/table_game/components/okey/OkeyBoard');

const CHANNEL = {id: '500', guildId: '9'} as never;
const NOW = Date.parse('2026-10-03T10:00:00.000Z');
const RACK_14 = ['t0', 't1', 't2', 't13', 't14', 't15', 't26', 't27', 't28', 't39', 't40', 't41', 't6', 't104'];
let harness: OkeyTestHarness;

function show(
	gameView: Partial<OkeyView>,
	options: {
		viewerPosition?: number | null;
		status?: TableGameSummary['status'];
		result?: TableGameSummary['result'];
	} = {},
): void {
	act(() => {
		TableGames.reset();
		TableGames.handleView(
			'500',
			testView({
				version: 5,
				status: options.status ?? 'playing',
				viewerPosition: options.viewerPosition === undefined ? 1 : options.viewerPosition,
				gameView: testOkeyGameView(gameView),
				summary: {result: options.result ?? null},
			}),
			'event',
		);
	});
}

function seat(position: number): HTMLElement {
	const element = harness.host.querySelector<HTMLElement>(`[data-seat-position="${position}"]`);
	if (!element) throw new Error(`no seat ${position}`);
	return element;
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
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	harness = createOkeyTestHarness();
});

afterEach(() => {
	harness.unmount();
	vi.useRealTimers();
});

describe('OkeyBoard', () => {
	it("others' racks show only counts", async () => {
		show({rack: RACK_14, rack_counts: [14, 15, 14, 13]});
		await render();
		expect(harness.host.querySelectorAll('[data-rack-cell][data-tile]')).toHaveLength(14);
		for (const [position, count] of [
			[2, '15'],
			[3, '14'],
			[4, '13'],
		] as const) {
			expect(seat(position).querySelector('[data-rack-count]')?.textContent).toContain(count);
			expect(seat(position).querySelectorAll('[data-tile]')).toHaveLength(0);
		}

		show({rack: null, rack_counts: [14, 15, 14, 13]}, {viewerPosition: null});
		await rerender();
		expect(harness.host.querySelectorAll('[data-rack-cell]')).toHaveLength(0);
		expect(seat(1).querySelector('[data-rack-count]')?.textContent).toContain('14');
	});

	it('deadline ring counts down', async () => {
		show({rack: RACK_14, turn: 2, deadline_at: new Date(NOW + 30_000).toISOString()});
		await render();
		const deadline = () => seat(2).querySelector('[data-deadline]');
		expect(deadline()?.textContent).toBe('30');
		expect(seat(1).querySelector('[data-deadline]')).toBeNull();
		await act(async () => vi.advanceTimersByTime(10_000));
		expect(deadline()?.textContent).toBe('20');
		expect(deadline()?.getAttribute('data-low')).toBeNull();
		await act(async () => vi.advanceTimersByTime(17_000));
		expect(deadline()?.textContent).toBe('3');
		expect(deadline()?.getAttribute('data-low')).toBe('true');
	});

	// The result banner is the panel's (TableGamePanel.test.tsx); an ended hand keeps its board without one.
	it('an ended hand shows its board and no result banner of its own', async () => {
		show({rack: RACK_14, turn: null}, {status: 'ended', result: {kind: 'win', winners: [2], reason: 'finish'}});
		await render();
		expect(harness.host.querySelectorAll('[data-rack-cell][data-tile]')).toHaveLength(14);
		expect(harness.host.querySelector('[data-result]')).toBeNull();
	});

	it('click a tile then an empty cell plays the place sound, like a drag does in the rack', async () => {
		vi.mocked(playTableUiSound).mockClear();
		show({rack: RACK_14});
		act(() => TableGames.setRackOrder('500', 'T01', ['t0', 't1', null, ...RACK_14.slice(2)]));
		await render();
		const cell = (index: number) => harness.host.querySelector<HTMLButtonElement>(`[data-rack-cell="${index}"]`)!;
		await act(async () => cell(0).click());
		expect(playTableUiSound).not.toHaveBeenCalled();
		await act(async () => cell(2).click());
		expect(cell(2).getAttribute('data-tile')).toBe('t0');
		expect(vi.mocked(playTableUiSound).mock.calls).toEqual([['table-game-tile-place']]);
	});
});

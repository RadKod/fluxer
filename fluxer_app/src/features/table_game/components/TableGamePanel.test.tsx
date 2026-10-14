// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {createOkeyTestHarness, type OkeyTestHarness} from '@app/features/table_game/components/okey/OkeyTestHarness';
import {
	testChessGameView,
	testOkeyGameView,
	testPlayer,
	testUnknownGameView,
	testView,
} from '@app/features/table_game/state/TableGameTestViews';
import type {TableGameSummary} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {act, createElement, type ReactNode} from 'react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

function interpolate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	return descriptor.message.replace(/{(\w+)}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: interpolate}})}));
// The real store's synced settings import UserSettings lazily, which needs the app bootstrap; no sound plays here.
vi.mock('@app/features/ui/commands/SoundCommands', () => ({playSound: vi.fn()}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: '100'}}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({default: {channelId: '500'}}));
vi.mock('@app/features/user/state/Users', () => ({default: {getUser: (id: string) => ({id, username: `user${id}`})}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getNickname: (user: {username: string}) => user.username}));
vi.mock('@app/features/table_game/commands/TableGameCommands', () => ({
	loadTableList: vi.fn(() => Promise.resolve()),
	act: vi.fn(() => Promise.resolve({ok: true})),
	createTable: vi.fn(),
	joinTable: vi.fn(),
	leaveTable: vi.fn(),
	spectate: vi.fn(),
	unspectate: vi.fn(),
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick}: {children: ReactNode; onClick: () => void}) =>
		createElement('button', {type: 'button', onClick}, children),
}));
vi.mock('@app/features/ui/segmented_tabs/SegmentedTabs', () => ({SegmentedTabs: () => null}));
// Routing only: each board has its own tests.
vi.mock('@app/features/table_game/components/DamaBoard', () => ({
	DamaBoard: ({slot}: {slot: string}) => createElement('div', {'data-board-stub': 'dama', 'data-slot-stub': slot}),
}));
vi.mock('@app/features/table_game/components/TavlaBoard', () => ({
	TavlaBoard: ({slot}: {slot: string}) => createElement('div', {'data-board-stub': 'tavla', 'data-slot-stub': slot}),
}));
vi.mock('@app/features/table_game/sound/TableGameSounds', async (importOriginal) => ({
	...(await importOriginal<object>()),
	setTableSoundFocus: vi.fn(),
}));

const {setTableSoundFocus} = await import('@app/features/table_game/sound/TableGameSounds');
const {default: TableGames} = await import('@app/features/table_game/state/TableGames');
const {TableGamePanel} = await import('@app/features/table_game/components/TableGamePanel');

const CHANNEL = {id: '500', guildId: '9'} as never;
let harness: OkeyTestHarness;

async function showEnded(game: 'okey' | 'chess', result: TableGameSummary['result']): Promise<void> {
	harness.unmount();
	harness = createOkeyTestHarness();
	act(() => {
		TableGames.reset();
		TableGames.handleView(
			'500',
			testView({
				game,
				version: 9,
				status: 'ended',
				gameView: game === 'chess' ? testChessGameView() : testOkeyGameView({rack: ['t0', 't1'], turn: null}),
				summary: {result},
			}),
			'event',
		);
	});
	await harness.render(createElement(TableGamePanel, {channel: CHANNEL, slots: ['T01'], initialSlot: 'T01'}));
}

function banners(): Array<Element> {
	return [...harness.host.querySelectorAll('[data-result]')];
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	harness = createOkeyTestHarness();
});

afterEach(() => {
	harness.unmount();
});

describe('TableGamePanel', () => {
	it('an ended table renders one result banner', async () => {
		await showEnded('okey', {kind: 'win', winners: [2], reason: 'finish'});
		expect(harness.host.querySelector('[data-rack-cell]')).not.toBeNull();
		expect(banners()).toHaveLength(1);
		expect(banners()[0]!.getAttribute('data-result')).toBe('win');
		expect(banners()[0]!.textContent).toContain('user101 won');

		await showEnded('okey', {kind: 'forfeit', loser: 3, reason: 'leave'});
		expect(banners()).toHaveLength(1);
		expect(banners()[0]!.textContent).toContain('user102 left the table and lost');

		await showEnded('okey', {kind: 'draw', reason: 'pile_empty'});
		expect(banners()).toHaveLength(1);
		expect(banners()[0]!.textContent).toContain('Draw');

		await showEnded('chess', {kind: 'win', winners: [3], reason: 'checkmate'});
		expect(harness.host.querySelector('[data-square]')).not.toBeNull();
		expect(banners()).toHaveLength(1);
		expect(banners()[0]!.textContent).toContain('user102 won');
		expect(banners()[0]!.textContent).toContain('Checkmate');
	});

	it('unknown game kind renders an update notice and never throws: no board, no game name, no seat count', async () => {
		const NOTICE = 'Update the app to play this game.';
		act(() => {
			TableGames.reset();
			TableGames.handleView('500', testUnknownGameView('playing'), 'event');
			TableGames.handleView('500', testUnknownGameView('lobby', {slot: 'T02'}), 'event');
		});
		await harness.render(createElement(TableGamePanel, {channel: CHANNEL, slots: ['T01', 'T02'], initialSlot: 'T01'}));
		expect(harness.host.textContent).toContain(NOTICE);
		expect(harness.host.querySelector('[data-rack-cell]')).toBeNull();
		expect(harness.host.querySelector('[data-square]')).toBeNull();
		await act(async () => harness.host.querySelector<HTMLButtonElement>('[aria-label="All tables"]')!.click());
		for (const slot of ['T01', 'T02']) {
			const row = harness.host.querySelector(`[data-slot="${slot}"]`)!;
			expect(row.textContent).toContain(NOTICE);
			expect(row.textContent).not.toContain('seated');
		}

		act(() => {
			TableGames.handleView(
				'500',
				testUnknownGameView('ended', {version: 9, result: {kind: 'win', winners: [1], reason: 'finish'}}),
				'event',
			);
		});
		await act(async () => harness.host.querySelector<HTMLButtonElement>('[data-slot="T01"]')!.click());
		expect(harness.host.querySelector('[data-rack-cell]')).toBeNull();
		expect(harness.host.textContent).toContain(NOTICE);
		expect(harness.host.textContent).not.toContain('won');
	});

	it('routes dama/dama_normal to DamaBoard and tavla to TavlaBoard', async () => {
		const cases = [
			['dama', 'dama', 'Turkish Draughts'],
			['dama_normal', 'dama', 'Draughts'],
			['tavla', 'tavla', 'Backgammon'],
		] as const;
		for (const [game, board, name] of cases) {
			harness.unmount();
			harness = createOkeyTestHarness();
			act(() => {
				TableGames.reset();
				TableGames.handleView('500', testView({game, version: 3}), 'event');
				TableGames.handleView(
					'500',
					testView({game, status: 'lobby', summary: {slot: 'T02', players: [testPlayer(1)]}}),
					'event',
				);
			});
			await harness.render(
				createElement(TableGamePanel, {channel: CHANNEL, slots: ['T01', 'T02'], initialSlot: 'T01'}),
			);
			const stubs = [...harness.host.querySelectorAll('[data-board-stub]')];
			expect(stubs.map((stub) => stub.getAttribute('data-board-stub'))).toEqual([board]);
			expect(stubs[0]!.getAttribute('data-slot-stub')).toBe('T01');
			expect(harness.host.querySelector('[data-rack-cell]')).toBeNull();
			expect(harness.host.querySelector('[data-square]')).toBeNull();
			expect(harness.host.textContent).toContain(name);
			expect(harness.host.textContent).not.toContain('Update the app to play this game.');
			await act(async () => harness.host.querySelector<HTMLButtonElement>('[aria-label="All tables"]')!.click());
			const lobbyRow = harness.host.querySelector('[data-slot="T02"]')!;
			expect(lobbyRow.textContent).toContain(name);
			expect(lobbyRow.textContent).toContain('1/2 seated');
		}
	});

	it('focuses the shown table for sounds while it is open, and only that table', async () => {
		vi.mocked(setTableSoundFocus).mockClear();
		act(() => {
			TableGames.reset();
			TableGames.handleView('500', testView({version: 3}), 'event');
		});
		await harness.render(createElement(TableGamePanel, {channel: CHANNEL, slots: ['T01', 'T02'], initialSlot: 'T01'}));
		expect(vi.mocked(setTableSoundFocus).mock.calls).toEqual([['500', 'T01', true]]);
		await act(async () => harness.host.querySelector<HTMLButtonElement>('[aria-label="All tables"]')!.click());
		expect(vi.mocked(setTableSoundFocus).mock.calls).toEqual([
			['500', 'T01', true],
			['500', 'T01', false],
		]);
		await act(async () => harness.host.querySelector<HTMLButtonElement>('[data-slot="T02"]')!.click());
		expect(vi.mocked(setTableSoundFocus)).toHaveBeenLastCalledWith('500', 'T02', true);
		harness.unmount();
		expect(vi.mocked(setTableSoundFocus)).toHaveBeenLastCalledWith('500', 'T02', false);
		harness = createOkeyTestHarness();
	});
});

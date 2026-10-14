// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	testPlayer,
	testSummary,
	testUnknownGameView,
	testView,
} from '@app/features/table_game/state/TableGameTestViews';
import {act, createElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

function interpolate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	return descriptor.message.replace(/{(\w+)}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

const voice = vi.hoisted(() => ({channelId: '500' as string | null}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: interpolate}})}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: '100'}}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({
	default: {
		get channelId() {
			return voice.channelId;
		},
	},
}));
vi.mock('@app/features/user/state/Users', () => ({default: {getUser: (id: string) => ({id, username: `user${id}`})}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getNickname: (user: {username: string}) => user.username}));
vi.mock('@app/features/table_game/commands/TableGameCommands', () => ({
	createTable: vi.fn(() => Promise.resolve({ok: true})),
	joinTable: vi.fn(() => Promise.resolve({ok: true})),
	leaveTable: vi.fn(() => Promise.resolve({ok: true})),
	spectate: vi.fn(() => Promise.resolve({ok: true})),
	unspectate: vi.fn(() => Promise.resolve({ok: true})),
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick, disabled}: {children: ReactNode; onClick: () => void; disabled?: boolean}) =>
		createElement('button', {type: 'button', onClick, disabled}, children),
}));
vi.mock('@app/features/ui/segmented_tabs/SegmentedTabs', () => ({
	SegmentedTabs: ({
		tabs,
		selectedTab,
		onTabChange,
	}: {
		tabs: Array<{id: string; label: string}>;
		selectedTab: string;
		onTabChange: (id: string) => void;
	}) =>
		createElement(
			'div',
			{role: 'tablist'},
			tabs.map((tab) =>
				createElement(
					'button',
					{
						key: tab.id,
						type: 'button',
						role: 'tab',
						'aria-selected': tab.id === selectedTab,
						onClick: () => onTabChange(tab.id),
					},
					tab.label,
				),
			),
		),
}));

const TableGameCommands = await import('@app/features/table_game/commands/TableGameCommands');
const {default: TableGames} = await import('@app/features/table_game/state/TableGames');
const {TableLobby} = await import('@app/features/table_game/components/TableLobby');

const CHANNEL = {id: '500', guildId: '9'} as never;
let root: Root | null = null;
let host: HTMLDivElement;

async function render(): Promise<void> {
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(createElement(TableLobby, {channel: CHANNEL, slot: 'T01'})));
}

function button(text: string): HTMLButtonElement | undefined {
	return [...host.querySelectorAll('button')].find((element) => element.textContent === text);
}

async function click(text: string): Promise<void> {
	const target = button(text);
	if (!target) throw new Error(`no button "${text}" in: ${host.textContent}`);
	await act(async () => target.click());
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	TableGames.reset();
	voice.channelId = '500';
	for (const command of Object.values(TableGameCommands)) vi.mocked(command as () => unknown).mockClear();
});

afterEach(() => {
	act(() => root?.unmount());
	host.remove();
});

describe('TableLobby', () => {
	it('empty slot: Kur with game + speed (Hızlı/Normal/Yavaş) and the time per speed', async () => {
		await render();
		expect(host.textContent).toContain('30 s per turn');
		await click('Fast');
		expect(host.textContent).toContain('15 s per turn');
		await click('Chess');
		expect(host.textContent).toContain('3 min per player');
		await click('Slow');
		expect(host.textContent).toContain('30 min per player');
		await click('Set up table');
		expect(TableGameCommands.createTable).toHaveBeenCalledWith('500', 'T01', 'chess', 'slow');
	});

	it('an ended table offers a new one', async () => {
		TableGames.handleList('500', [testSummary({status: 'ended', result: {kind: 'draw', reason: 'stalemate'}})]);
		await render();
		expect(button('Set up table')).toBeDefined();
	});

	it('join free position; chess shows only 2 positions', async () => {
		TableGames.handleList('500', [testSummary({game: 'chess', status: 'lobby', players: [testPlayer(1, '777')]})]);
		await render();
		expect(host.textContent).toContain('user777');
		const seats = host.querySelectorAll('[data-table-position]');
		expect([...seats].map((seat) => seat.getAttribute('data-table-position'))).toEqual(['1', '3']);
		await click('Take seat');
		expect(TableGameCommands.joinTable).toHaveBeenCalledWith('500', 'T01', 3);
	});

	it('cannot take a seat without being in this voice channel', async () => {
		voice.channelId = '777';
		TableGames.handleList('500', [testSummary({status: 'lobby', players: [testPlayer(1, '777')]})]);
		await render();
		expect(button('Take seat')).toBeUndefined();
		expect(host.textContent).toContain('Join the voice channel to play.');
	});

	it("İzle visible to voice members; 'Masa dolu, izleyici sınırı' text when not subscribed", async () => {
		TableGames.handleList('500', [
			testSummary({status: 'playing', players: [2, 3, 4, 1].map((p) => testPlayer(p, `7${p}`))}),
		]);
		await render();
		await click('Watch');
		expect(TableGameCommands.spectate).toHaveBeenCalledWith('500', 'T01');
		await act(async () => {
			TableGames.handleView('500', testView({viewerPosition: null, spectating: false, summary: {players: []}}), 'rest');
			TableGames.setWatchMode('500', 'T01', 'polling');
		});
		expect(host.textContent).toContain('Live spectator spots are full. The table refreshes every few seconds.');
		await click('Stop watching');
		expect(TableGameCommands.unspectate).toHaveBeenCalledWith('500', 'T01');
	});

	it('no Watch button outside the voice channel', async () => {
		voice.channelId = null;
		TableGames.handleList('500', [testSummary({status: 'playing', players: [testPlayer(1, '71')]})]);
		await render();
		expect(button('Watch')).toBeUndefined();
	});

	it("leave in a running game asks to confirm: 'Masadan kalkarsan oyunu kaybedersin'", async () => {
		TableGames.handleView('500', testView({status: 'playing', viewerPosition: 1}), 'event');
		await render();
		await click('Leave table');
		expect(TableGameCommands.leaveTable).not.toHaveBeenCalled();
		expect(host.textContent).toContain('If you leave the table, you lose the game.');
		await click('Stay');
		expect(host.textContent).not.toContain('If you leave the table, you lose the game.');
		await click('Leave table');
		await click('Leave and lose');
		expect(TableGameCommands.leaveTable).toHaveBeenCalledWith('500', 'T01');
	});

	it('leaving a lobby needs no confirmation', async () => {
		TableGames.handleView('500', testView({status: 'lobby', viewerPosition: 1}), 'event');
		await render();
		await click('Leave table');
		expect(TableGameCommands.leaveTable).toHaveBeenCalledWith('500', 'T01');
	});

	it('unknown game kind renders an update notice and never throws', async () => {
		TableGames.handleView('500', testUnknownGameView('lobby'), 'event');
		await render();
		expect(host.textContent).toContain('Update the app to play this game.');
		expect(host.querySelector('[data-table-position]')).toBeNull();
		await act(async () => {
			TableGames.handleView('500', testUnknownGameView('playing', {version: 2}), 'event');
		});
		expect(host.textContent).toContain('Update the app to play this game.');
		expect(button('Watch')).toBeUndefined();
	});

	it('an ended table of an unknown kind shows the update notice for its result and still offers a new table', async () => {
		TableGames.handleList('500', [
			testUnknownGameView('ended', {result: {kind: 'win', winners: [1], reason: 'finish'}}).summary,
		]);
		await render();
		expect(host.textContent).toContain('Update the app to play this game.');
		expect(host.textContent).not.toContain('won');
		expect(button('Set up table')).toBeDefined();
	});

	it('game picker lists Okey, 101, Chess, Türk Daması, Normal Dama, Tavla', async () => {
		await render();
		const choices = [...host.querySelectorAll('[data-game-choice]')];
		expect(choices.map((choice) => choice.textContent)).toEqual([
			'Okey',
			'101 Okey',
			'Chess',
			'Turkish Draughts',
			'Draughts',
			'Backgammon',
		]);
		expect(choices.map((choice) => choice.getAttribute('aria-pressed'))).toEqual([
			'true',
			'false',
			'false',
			'false',
			'false',
			'false',
		]);
		await click('Draughts');
		await click('Set up table');
		expect(TableGameCommands.createTable).toHaveBeenCalledWith('500', 'T01', 'dama_normal', 'normal');
	});

	it('two-player kinds show seats 1 and 3', async () => {
		for (const game of ['dama', 'dama_normal', 'tavla'] as const) {
			TableGames.reset();
			TableGames.handleList('500', [testSummary({game, status: 'lobby', players: [testPlayer(3, '777')]})]);
			await render();
			const seats = [...host.querySelectorAll('[data-table-position]')];
			expect(seats.map((seat) => seat.getAttribute('data-table-position'))).toEqual(['1', '3']);
			await click('Take seat');
			expect(TableGameCommands.joinTable).toHaveBeenLastCalledWith('500', 'T01', 1);
			act(() => root!.unmount());
			host.remove();
		}
	});

	it('speed text: clocks for chess/dama, seconds per turn for okey/tavla', async () => {
		await render();
		await click('Turkish Draughts');
		expect(host.textContent).toContain('10 min per player');
		await click('Draughts');
		await click('Fast');
		expect(host.textContent).toContain('3 min per player');
		await click('Backgammon');
		expect(host.textContent).toContain('20 s per turn');
		await click('Slow');
		expect(host.textContent).toContain('90 s per turn');
		await click('101 Okey');
		expect(host.textContent).toContain('90 s per turn');
	});
});

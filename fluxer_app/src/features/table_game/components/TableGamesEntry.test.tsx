// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {testSummary, testUnknownGameView, testView} from '@app/features/table_game/state/TableGameTestViews';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {act, createElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

function interpolate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	return descriptor.message.replace(/{(\w+)}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

const env = vi.hoisted(() => ({
	games: true,
	defaultTheme: null as string | null,
	channelId: '500' as string | null,
	mobile: false,
}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: interpolate}})}));
// The real store's synced settings import UserSettings lazily, which needs the app bootstrap; no sound plays here.
vi.mock('@app/features/ui/commands/SoundCommands', () => ({playSound: vi.fn()}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: '100'}}));
vi.mock('@app/features/experiment/state/ExperimentAssignments', () => ({default: {response: {}}}));
vi.mock('@fluxer/schema/src/domains/experiment/ExperimentSchemas', () => ({
	readVoiceRoomAssignment: () => ({rooms: true, games: env.games, default_room_theme: env.defaultTheme}),
}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({
	default: {
		get channelId() {
			return env.channelId;
		},
	},
}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {isMobileLayout: () => env.mobile}}));
vi.mock('@app/features/user/state/Users', () => ({default: {getUser: (id: string) => ({id, username: `user${id}`})}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getNickname: (user: {username: string}) => user.username}));
vi.mock('@app/features/table_game/commands/TableGameCommands', () => ({
	loadTableList: vi.fn(() => Promise.resolve()),
	fetchTable: vi.fn(() => Promise.resolve('updated')),
	tick: vi.fn(() => Promise.resolve({ok: true})),
	createTable: vi.fn(),
	joinTable: vi.fn(),
	leaveTable: vi.fn(),
	spectate: vi.fn(),
	unspectate: vi.fn(),
	act: vi.fn(),
}));
vi.mock('@app/features/channel/components/channel_header_components/ChannelHeaderIcon', () => ({
	ChannelHeaderIcon: ({label, onClick}: {label: string; onClick?: () => void}) =>
		createElement('button', {type: 'button', 'data-header-icon': label, onClick}, label),
}));
vi.mock('@app/features/ui/hooks/usePopout', () => ({usePopout: () => ({isOpen: false, openProps: {uniqueId: 'x'}})}));
vi.mock('@app/features/ui/popover/PopoverPopout', () => ({
	// Opened state is the popout system's; here the content renders next to its trigger.
	Popout: ({children, render}: {children: ReactNode; render: (props: {onClose: () => void}) => ReactNode}) =>
		createElement('div', {'data-popout': 'true'}, children, render({onClose: () => {}})),
	openPopout: vi.fn(),
}));
vi.mock('@app/features/ui/bottom_sheet/BottomSheet', () => ({
	BottomSheet: ({isOpen, children, title}: {isOpen: boolean; children: ReactNode; title?: string}) =>
		isOpen ? createElement('section', {'data-bottom-sheet': title}, children) : null,
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick}: {children: ReactNode; onClick: () => void}) =>
		createElement('button', {type: 'button', onClick}, children),
}));
vi.mock('@app/features/ui/segmented_tabs/SegmentedTabs', () => ({SegmentedTabs: () => null}));
vi.mock('@app/features/table_game/components/okey/OkeyBoard', () => ({
	OkeyBoard: ({slot}: {slot: string}) => createElement('div', {'data-okey-board': slot}),
}));
vi.mock('@app/features/table_game/components/ChessBoard', () => ({
	ChessBoard: ({slot}: {slot: string}) => createElement('div', {'data-chess-board': slot}),
}));

const TableGameCommands = await import('@app/features/table_game/commands/TableGameCommands');
const {openPopout} = await import('@app/features/ui/popover/PopoverPopout');
const {default: TableGames} = await import('@app/features/table_game/state/TableGames');
const {TableGamesEntry} = await import('@app/features/table_game/components/TableGamesEntry');

// oyun-odasi has two tables; a channel without a theme has none.
const ROOM_CHANNEL = {id: '500', guildId: '9', type: ChannelTypes.GUILD_VOICE, roomTheme: 'oyun-odasi'} as never;
const PLAIN_CHANNEL = {id: '500', guildId: '9', type: ChannelTypes.GUILD_VOICE, roomTheme: null} as never;
let root: Root | null = null;
let host: HTMLDivElement;

async function render(props: Record<string, unknown>): Promise<void> {
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(createElement(TableGamesEntry, props as never)));
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	Object.assign(env, {games: true, channelId: '500', mobile: false, defaultTheme: null});
	TableGames.reset();
	vi.mocked(TableGameCommands.loadTableList).mockClear();
	vi.mocked(TableGameCommands.fetchTable).mockClear();
	vi.mocked(openPopout).mockClear();
});

afterEach(() => {
	act(() => root?.unmount());
	host.remove();
});

describe('TableGamesEntry', () => {
	it.each([ChannelTypes.DM, ChannelTypes.GROUP_DM])('does not inherit tables in channel type %s', async (type) => {
		env.defaultTheme = 'oyun-odasi';
		await render({channel: {id: '500', guildId: null, type, roomTheme: null}, placement: 'header'});
		expect(host.innerHTML).toBe('');
		expect(TableGameCommands.loadTableList).not.toHaveBeenCalled();
	});
	it('lists tables for the inherited default room', async () => {
		env.defaultTheme = 'oyun-odasi';
		await render({channel: PLAIN_CHANNEL, placement: 'header'});
		expect(host.querySelectorAll('[data-slot]')).toHaveLength(2);
	});

	it('explicit none has no tables despite an instance default', async () => {
		env.defaultTheme = 'oyun-odasi';
		await render({
			channel: {id: '500', guildId: '9', type: ChannelTypes.GUILD_VOICE, roomTheme: 'none'},
			placement: 'header',
		});
		expect(host.innerHTML).toBe('');
	});
	it('header entry lists the room tables and loads the list once when the call view opens', async () => {
		await render({channel: ROOM_CHANNEL, placement: 'header'});
		expect(host.querySelector('[data-header-icon="Table games"]')).not.toBeNull();
		expect([...host.querySelectorAll('[data-slot]')].map((row) => row.getAttribute('data-slot'))).toEqual([
			'T01',
			'T02',
		]);
		expect(TableGameCommands.loadTableList).toHaveBeenCalledWith('500');
	});

	it('reads once a table the list says I sit at, so its board and deadline are known after a reload', async () => {
		TableGames.handleList('500', [
			testSummary({slot: 'T02', status: 'playing'}),
			testSummary({slot: 'T01', players: []}),
		]);
		await render({channel: ROOM_CHANNEL, placement: 'header'});
		expect(vi.mocked(TableGameCommands.fetchTable).mock.calls).toEqual([['500', 'T02']]);
		await act(async () => {
			TableGames.handleView('500', testView({version: 5, summary: {slot: 'T02'}}), 'rest');
		});
		expect(TableGameCommands.fetchTable).toHaveBeenCalledTimes(1);
	});

	it('is hidden while table games are off, without a room theme, or outside this call', async () => {
		env.games = false;
		await render({channel: ROOM_CHANNEL, placement: 'header'});
		expect(host.innerHTML).toBe('');
		act(() => root!.unmount());
		env.games = true;
		await render({channel: PLAIN_CHANNEL, placement: 'header'});
		expect(host.innerHTML).toBe('');
		act(() => root!.unmount());
		env.channelId = '777';
		await render({channel: ROOM_CHANNEL, placement: 'header'});
		expect(host.innerHTML).toBe('');
	});

	it('opens the panel in a bottom sheet on the mobile layout', async () => {
		env.mobile = true;
		await render({channel: ROOM_CHANNEL, placement: 'header'});
		expect(host.querySelector('[data-bottom-sheet]')).toBeNull();
		await act(async () => host.querySelector<HTMLButtonElement>('[data-header-icon]')!.click());
		expect(host.querySelector('[data-bottom-sheet]')).not.toBeNull();
		expect(host.querySelectorAll('[data-slot]')).toHaveLength(2);
	});

	it('choosing a table in the list opens that table', async () => {
		TableGames.handleList('500', [testSummary({slot: 'T02', status: 'lobby', players: []})]);
		await render({channel: ROOM_CHANNEL, placement: 'header'});
		await act(async () => host.querySelector<HTMLButtonElement>('[data-slot="T02"]')!.click());
		expect(host.textContent).toContain('Table 2');
		expect(host.querySelectorAll('[data-table-position]')).toHaveLength(4);
	});

	it('a running okey table shows the okey board, a chess table the chess board', async () => {
		TableGames.handleView('500', testView({version: 3, summary: {slot: 'T01'}}), 'event');
		TableGames.handleView('500', testView({game: 'chess', version: 3, summary: {slot: 'T02'}}), 'event');
		await render({channel: ROOM_CHANNEL, placement: 'header'});
		await act(async () => host.querySelector<HTMLButtonElement>('[data-slot="T01"]')!.click());
		expect(host.querySelector('[data-okey-board="T01"]')).not.toBeNull();
		expect(host.querySelector('[data-chess-board]')).toBeNull();
		act(() => root!.unmount());
		host.remove();
		await render({channel: ROOM_CHANNEL, placement: 'scene', slot: 'T02'});
		expect(host.querySelector('[data-chess-board="T02"]')).not.toBeNull();
	});

	it('a table still in its lobby shows no board', async () => {
		TableGames.handleView('500', testView({version: 0, status: 'lobby', summary: {slot: 'T01'}}), 'event');
		await render({channel: ROOM_CHANNEL, placement: 'scene', slot: 'T01'});
		expect(host.querySelector('[data-okey-board]')).toBeNull();
		expect(host.querySelectorAll('[data-table-position]')).toHaveLength(4);
	});

	it('scene entry shows its table and opens its panel when the room asks for that table', async () => {
		TableGames.handleList('500', [testSummary({slot: 'T01', game: 'chess', status: 'lobby', players: []})]);
		await render({channel: ROOM_CHANNEL, placement: 'scene', slot: 'T01'});
		expect(host.querySelector('[data-table-chip="T01"]')?.textContent).toContain('Chess');
		expect(openPopout).not.toHaveBeenCalled();
		act(() => TableGames.requestPanel('500', 'T02'));
		expect(openPopout).not.toHaveBeenCalled();
		act(() => TableGames.requestPanel('500', 'T01'));
		expect(openPopout).toHaveBeenCalledTimes(1);
		const [target, options] = vi.mocked(openPopout).mock.calls[0]!;
		expect(target).toBe(host.querySelector('[data-table-chip="T01"]'));
		expect(options.position).toBe('top');
		// The room's panel keeps its full size.
		expect(host.querySelector('[data-beside]')).toBeNull();
	});

	it('with a panel anchor (the seat view HUD) a request opens a compact panel above it, clear of the table', async () => {
		const hud = document.createElement('div');
		document.body.append(hud);
		await render({channel: ROOM_CHANNEL, placement: 'scene', slot: 'T01', panelAnchor: hud});
		act(() => TableGames.requestPanel('500', 'T01'));
		expect(openPopout).toHaveBeenCalledTimes(1);
		const [target, options] = vi.mocked(openPopout).mock.calls[0]!;
		expect(target).toBe(hud);
		expect(options.position).toBe('top-end');
		const opened = options.render as () => ReactNode;
		const panelHost = document.createElement('div');
		const panelRoot = createRoot(panelHost);
		await act(async () => panelRoot.render(createElement(() => opened())));
		expect(panelHost.querySelector('[data-beside]')).not.toBeNull();
		act(() => panelRoot.unmount());
		hud.remove();
	});

	it('a table request opens the panel once with the current tables; a later request for it opens it again', async () => {
		await render({channel: ROOM_CHANNEL, placement: 'scene', slot: 'T01'});
		// gece-lounge has one table: its panel has no way back to a table list.
		const lounge = {id: '500', guildId: '9', type: ChannelTypes.GUILD_VOICE, roomTheme: 'gece-lounge'} as never;
		await act(async () =>
			root!.render(createElement(TableGamesEntry, {channel: lounge, placement: 'scene', slot: 'T01'})),
		);
		act(() => TableGames.requestPanel('500', 'T01'));
		expect(openPopout).toHaveBeenCalledTimes(1);
		const opened = vi.mocked(openPopout).mock.calls[0]![1].render as () => ReactNode;
		const panelHost = document.createElement('div');
		const panelRoot = createRoot(panelHost);
		await act(async () => panelRoot.render(createElement(() => opened())));
		expect(panelHost.querySelector('[aria-label="All tables"]')).toBeNull();
		expect(panelHost.textContent).toContain('Table 1');
		act(() => panelRoot.unmount());
		await act(async () =>
			root!.render(createElement(TableGamesEntry, {channel: ROOM_CHANNEL, placement: 'scene', slot: 'T01'})),
		);
		expect(openPopout).toHaveBeenCalledTimes(1);
		act(() => TableGames.requestPanel('500', 'T01'));
		expect(openPopout).toHaveBeenCalledTimes(2);
	});

	it('a table label that mounts after a request does not open that old request', async () => {
		act(() => TableGames.requestPanel('500', 'T01'));
		await render({channel: ROOM_CHANNEL, placement: 'scene', slot: 'T01'});
		expect(openPopout).not.toHaveBeenCalled();
	});

	it('unknown game kind renders an update notice and never throws: a bare table label, no board', async () => {
		TableGames.handleView('500', testUnknownGameView('playing'), 'event');
		await render({channel: ROOM_CHANNEL, placement: 'header'});
		expect(host.querySelector('[data-slot="T01"]')?.textContent).toContain('Update the app to play this game.');
		act(() => root!.unmount());
		host.remove();
		await render({channel: ROOM_CHANNEL, placement: 'scene', slot: 'T01'});
		expect(host.querySelector('[data-table-chip="T01"]')?.textContent).toBe('Table 1');
		expect(host.textContent).toContain('Update the app to play this game.');
		expect(host.querySelector('[data-okey-board]')).toBeNull();
		expect(host.querySelector('[data-chess-board]')).toBeNull();
	});

	it('scene entry for a slot the theme does not have renders nothing', async () => {
		await render({channel: ROOM_CHANNEL, placement: 'scene', slot: 'T09'});
		expect(host.innerHTML).toBe('');
	});
});

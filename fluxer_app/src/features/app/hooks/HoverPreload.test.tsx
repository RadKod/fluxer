// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {useGuildListItemPreload} from '@app/features/app/components/layout/sidebar_nav/UseGuildListItemPreload';
import {useChannelHoverPreload} from '@app/features/app/hooks/useChannelHoverPreload';
import {ResettableStates} from '@app/features/app/state/ResettableStates';
import type {Channel} from '@app/features/channel/models/Channel';
import type {Guild} from '@app/features/guild/models/Guild';
import {AccountScopedWork, AccountScopedWorkTransitionReason} from '@app/features/platform/state/AccountScopedWork';
import {useUserProfileHoverPreload} from '@app/features/user/hooks/useUserProfileHoverPreload';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';

const state = vi.hoisted(() => ({
	connected: true,
	threadActive: true,
	profileAllowed: true,
	preload: vi.fn(() => true),
	cached: vi.fn(),
	members: vi.fn(),
	profile: vi.fn(async () => {}),
	counts: vi.fn(),
}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		info() {}
		warn() {}
	},
}));
vi.mock('@app/features/gateway/transport/GatewaySessionPool', () => ({
	default: {
		foregroundConnection: {
			get isConnected() {
				return state.connected;
			},
		},
	},
}));
vi.mock('@app/features/messaging/state/MessagingMessages', () => ({
	default: {preloadLatestPage: state.preload, getCachedMessages: state.cached},
}));
vi.mock('@app/features/messaging/commands/MessageCommands', () => ({ensureMembersForMessages: state.members}));
vi.mock('@app/features/threads/state/ThreadGuilds', () => ({default: {isActive: () => state.threadActive}}));
vi.mock('@app/features/user/commands/UserProfileCommands', () => ({
	canOpenUserProfileSurface: () => state.profileAllowed && state.connected,
	fetch: state.profile,
}));
vi.mock('@app/features/guild/state/GuildCount', () => ({default: {requestCounts: state.counts}}));
vi.mock('@app/features/channel/state/Channels', () => ({
	default: {
		getChannel: () => undefined,
		getGuildChannels: () => [],
	},
}));
vi.mock('@app/features/messaging/utils/ChannelShared', () => ({filterViewableChannels: () => []}));
vi.mock('@app/features/navigation/state/SelectedChannel', () => ({default: {selectedChannelIds: new Map()}}));

let root: Root;
let host: HTMLElement;
const channelControls = new Map<string, ReturnType<typeof useChannelHoverPreload>>();
const profileControls = new Map<string, ReturnType<typeof useUserProfileHoverPreload>>();

function channel(id: string, options: {thread?: boolean; threadOnly?: boolean; type?: number} = {}): Channel {
	return {
		id,
		guildId: 'guild',
		type: options.type ?? ChannelTypes.GUILD_TEXT,
		isThread: () => options.thread ?? false,
		isThreadOnly: () => options.threadOnly ?? false,
	} as Channel;
}
function ChannelRow({value, enabled = true}: {value: Channel; enabled?: boolean}) {
	channelControls.set(value.id, useChannelHoverPreload({channel: value, enabled}));
	return null;
}
function ProfileRow({id}: {id: string}) {
	profileControls.set(id, useUserProfileHoverPreload({userId: id, guildId: 'guild'}));
	return null;
}
function GuildRow({id, hovered = true, unavailable = false}: {id: string; hovered?: boolean; unavailable?: boolean}) {
	useGuildListItemPreload({
		guild: {id, unavailable} as Guild,
		isHovering: hovered,
		isMobileExperience: false,
		isSortingList: false,
	});
	return null;
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	vi.clearAllMocks();
	state.connected = true;
	state.threadActive = true;
	state.profileAllowed = true;
	state.preload.mockReturnValue(true);
	state.cached.mockReturnValue(undefined);
	host = document.createElement('div');
	document.body.appendChild(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	ResettableStates.prepareForAccountTransition('logout');
	channelControls.clear();
	profileControls.clear();
	host.remove();
	vi.useRealTimers();
});

test('a rapid sweep over 1000 rows retains one timer and only the last channel', () => {
	act(() => root.render(Array.from({length: 1000}, (_, i) => <ChannelRow key={i} value={channel(`${i}`)} />)));
	for (const control of channelControls.values()) control.scheduleChannelPreload();
	expect(vi.getTimerCount()).toBe(1);
	vi.advanceTimersByTime(220);
	expect(state.preload).toHaveBeenCalledExactlyOnceWith('999', 'guild');
	expect(vi.getTimerCount()).toBe(0);
});

test('channel, profile and count jobs share one timer without losing their delays', () => {
	act(() =>
		root.render(
			<>
				<ChannelRow value={channel('channel')} />
				<ProfileRow id="user" />
				<GuildRow id="guild" />
			</>,
		),
	);
	channelControls.get('channel')!.scheduleChannelPreload();
	profileControls.get('user')!.scheduleProfilePreload();
	expect(vi.getTimerCount()).toBe(1);
	vi.advanceTimersByTime(220);
	expect(state.preload).toHaveBeenCalledOnce();
	expect(state.profile).toHaveBeenCalledExactlyOnceWith('user', 'guild');
	expect(state.counts).not.toHaveBeenCalled();
	vi.advanceTimersByTime(30);
	expect(state.counts).toHaveBeenCalledExactlyOnceWith('guild', {force: false});
	expect(vi.getTimerCount()).toBe(0);
});

test('hover then click preloads immediately once and cancels delayed work', () => {
	act(() =>
		root.render(
			<>
				<ChannelRow value={channel('channel')} />
				<ProfileRow id="user" />
			</>,
		),
	);
	const c = channelControls.get('channel')!;
	const p = profileControls.get('user')!;
	c.scheduleChannelPreload();
	p.scheduleProfilePreload();
	c.preloadChannelNow();
	p.preloadProfileNow();
	vi.advanceTimersByTime(1000);
	expect(state.preload).toHaveBeenCalledOnce();
	expect(state.profile).toHaveBeenCalledOnce();
});

test('leaving an older row cannot cancel the newer row preload', () => {
	act(() =>
		root.render(
			<>
				<ChannelRow value={channel('old')} />
				<ChannelRow value={channel('new')} />
			</>,
		),
	);
	channelControls.get('old')!.scheduleChannelPreload();
	channelControls.get('new')!.scheduleChannelPreload();
	channelControls.get('old')!.cancelChannelPreload();
	vi.advanceTimersByTime(220);
	expect(state.preload).toHaveBeenCalledExactlyOnceWith('new', 'guild');
});

test('cached channel messages still ensure their members', () => {
	state.preload.mockReturnValue(false);
	const messages = [{id: 'message'}];
	state.cached.mockReturnValue({length: 1, toArray: () => messages});
	act(() => root.render(<ChannelRow value={channel('cached')} />));
	channelControls.get('cached')!.preloadChannelNow();
	expect(state.members).toHaveBeenCalledExactlyOnceWith(messages);
});

test('a disconnect during the delay prevents all preload requests', () => {
	act(() =>
		root.render(
			<>
				<ChannelRow value={channel('channel')} />
				<ProfileRow id="user" />
				<GuildRow id="guild" />
			</>,
		),
	);
	channelControls.get('channel')!.scheduleChannelPreload();
	profileControls.get('user')!.scheduleProfilePreload();
	state.connected = false;
	vi.advanceTimersByTime(1000);
	expect(state.preload).not.toHaveBeenCalled();
	expect(state.profile).not.toHaveBeenCalled();
	expect(state.counts).not.toHaveBeenCalled();
});

test('disabled threads, categories and thread-only channels do not preload', () => {
	state.threadActive = false;
	act(() =>
		root.render(
			<>
				<ChannelRow value={channel('thread', {thread: true})} />
				<ChannelRow value={channel('forum', {threadOnly: true})} />
				<ChannelRow value={channel('category', {type: ChannelTypes.GUILD_CATEGORY})} />
			</>,
		),
	);
	for (const control of channelControls.values()) control.preloadChannelNow();
	expect(state.preload).not.toHaveBeenCalled();
});

test('account switch clears every queued kind before another account connects', () => {
	act(() =>
		root.render(
			<>
				<ChannelRow value={channel('channel')} />
				<ProfileRow id="user" />
				<GuildRow id="guild" />
			</>,
		),
	);
	channelControls.get('channel')!.scheduleChannelPreload();
	profileControls.get('user')!.scheduleProfilePreload();
	ResettableStates.prepareForAccountTransition('account-switch');
	expect(vi.getTimerCount()).toBe(0);
	vi.advanceTimersByTime(1000);
	expect(state.preload).not.toHaveBeenCalled();
	expect(state.profile).not.toHaveBeenCalled();
	expect(state.counts).not.toHaveBeenCalled();
});

test('account suspension cancels queued work and rejects new hover jobs', async () => {
	act(() =>
		root.render(
			<>
				<ChannelRow value={channel('channel')} />
				<ProfileRow id="user" />
				<GuildRow id="guild" />
			</>,
		),
	);
	channelControls.get('channel')!.scheduleChannelPreload();
	profileControls.get('user')!.scheduleProfilePreload();
	await AccountScopedWork.runSuspended(AccountScopedWorkTransitionReason.ACCOUNT_SWITCH, async () => {
		expect(vi.getTimerCount()).toBe(0);
		channelControls.get('channel')!.scheduleChannelPreload();
		profileControls.get('user')!.scheduleProfilePreload();
		expect(vi.getTimerCount()).toBe(0);
	});
	vi.advanceTimersByTime(1000);
	expect(state.preload).not.toHaveBeenCalled();
	expect(state.profile).not.toHaveBeenCalled();
	expect(state.counts).not.toHaveBeenCalled();
});

test('changing the target cancels its old pending channel preload', () => {
	act(() => root.render(<ChannelRow value={channel('old')} />));
	channelControls.get('old')!.scheduleChannelPreload();
	act(() => root.render(<ChannelRow value={channel('new')} />));
	vi.advanceTimersByTime(220);
	expect(state.preload).not.toHaveBeenCalled();
});

test('unmount cancels pending work', () => {
	act(() =>
		root.render(
			<>
				<ChannelRow value={channel('channel')} />
				<ProfileRow id="user" />
				<GuildRow id="guild" />
			</>,
		),
	);
	channelControls.get('channel')!.scheduleChannelPreload();
	profileControls.get('user')!.scheduleProfilePreload();
	act(() => root.render(null));
	expect(vi.getTimerCount()).toBe(0);
});

test('unavailable guilds do not request counts on hover', () => {
	act(() => root.render(<GuildRow id="guild" unavailable />));
	vi.advanceTimersByTime(1000);
	expect(state.counts).not.toHaveBeenCalled();
});

test('a throwing channel preload does not strand other pending preload kinds', () => {
	act(() =>
		root.render(
			<>
				<ChannelRow value={channel('channel')} />
				<ProfileRow id="user" />
				<GuildRow id="guild" />
			</>,
		),
	);
	state.preload.mockImplementationOnce(() => {
		throw new Error('Preload failed');
	});
	channelControls.get('channel')!.scheduleChannelPreload();
	profileControls.get('user')!.scheduleProfilePreload();
	expect(() => vi.advanceTimersByTime(220)).toThrow('Preload failed');
	expect(vi.getTimerCount()).toBe(1);
	vi.advanceTimersByTime(30);
	expect(state.profile).toHaveBeenCalledExactlyOnceWith('user', 'guild');
	expect(state.counts).toHaveBeenCalledExactlyOnceWith('guild', {force: false});
	expect(vi.getTimerCount()).toBe(0);
});

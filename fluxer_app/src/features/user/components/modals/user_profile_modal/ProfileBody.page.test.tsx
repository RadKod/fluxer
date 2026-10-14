// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Profile} from '@app/features/user/models/Profile';
import type {User} from '@app/features/user/models/User';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const passThrough = ({children}: {children?: ReactNode}) => children;
const contentProps = vi.hoisted(() => ({current: null as null | {onNavigate?: () => void}}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message, locale: 'en-US'}}),
	Trans: passThrough,
}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: 'me'}}));
vi.mock('@app/features/messaging/utils/ChannelTextareaFocusUtils', () => ({
	focusChannelTextareaAfterNavigation: vi.fn(),
}));
vi.mock('@app/features/navigation/commands/NavigationCommands', () => ({selectGuild: vi.fn(), selectChannel: vi.fn()}));
vi.mock('@app/features/navigation/state/SelectedChannel', () => ({default: {selectedChannelIds: new Map()}}));
vi.mock('@app/features/ui/action_menu/GroupDMContextMenu', () => ({GroupDMContextMenu: () => null}));
vi.mock('@app/features/ui/action_menu/GuildContextMenu', () => ({GuildContextMenu: () => null}));
vi.mock('@app/features/ui/action_menu/GuildMemberContextMenu', () => ({GuildMemberContextMenu: () => null}));
vi.mock('@app/features/ui/action_menu/UserContextMenu', () => ({UserContextMenu: () => null}));
vi.mock('@app/features/ui/commands/ContextMenuCommands', () => ({openFromEvent: vi.fn()}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({
	pop: vi.fn(),
	update: vi.fn(),
	modal: (render: unknown) => render,
}));
vi.mock('@app/features/ui/components/Scroller', () => ({Scroller: passThrough}));
vi.mock('@app/features/ui/state/Modal', () => ({default: {getModal: () => ({key: 'profile'})}}));
vi.mock('@app/features/ui/state/ContextMenu', () => ({
	default: {contextMenu: null},
	isContextMenuNodeTarget: () => false,
}));
vi.mock('@app/features/ui/tabs/Tabs', () => ({
	Tabs: ({tabs, onTabChange}: {tabs: Array<{key: string; label: string}>; onTabChange: (key: string) => void}) =>
		createElement(
			'div',
			{role: 'tablist'},
			tabs.map((tab) =>
				createElement(
					'button',
					{key: tab.key, type: 'button', role: 'tab', onClick: () => onTabChange(tab.key)},
					tab.key,
				),
			),
		),
}));
vi.mock('@app/features/user/components/modals/UserProfileModal', () => ({UserProfileModal: () => null}));
vi.mock('@app/features/user/components/modals/user_profile_modal/MutualFriendItem', () => ({
	MutualFriendItem: ({user, onClick}: {user: User; onClick: () => void}) =>
		createElement('button', {type: 'button', 'data-friend': user.id, onClick}),
}));
vi.mock('@app/features/user/components/modals/user_profile_modal/MutualGroupItem', () => ({
	MutualGroupItem: () => null,
}));
vi.mock('@app/features/user/components/modals/user_profile_modal/MutualGuildItem', () => ({
	MutualGuildItem: ({onClick}: {onClick: () => void}) =>
		createElement('button', {type: 'button', 'data-guild': '', onClick}),
}));
vi.mock('@app/features/user/components/modals/user_profile_modal/MutualItemsUtils', () => ({
	getMutualGroupChannels: () => [],
	getMutualCommunityDisplayItems: () => [{guild: {id: '9'}, nick: null}],
}));
vi.mock('@app/features/user/components/modals/user_profile_modal/ProfileContent', () => ({
	ProfileContent: (props: {onNavigate?: () => void}) => {
		contentProps.current = props;
		return createElement('i', {'data-part': 'overview'});
	},
}));
vi.mock('@app/features/user/components/modals/user_profile_modal/UserProfileModalUserInfo', () => ({
	UserInfo: () => createElement('i', {'data-part': 'user-info'}),
}));
vi.mock('@app/features/user/models/User', () => ({
	User: class {
		id: string;
		constructor(wire: {id: string}) {
			this.id = wire.id;
		}
	},
}));

const {ProfileBody} = await import('@app/features/user/components/modals/user_profile_modal/ProfileBody');
const ModalCommands = await import('@app/features/ui/commands/ModalCommands');
const NavigationCommands = await import('@app/features/navigation/commands/NavigationCommands');

const USER = {id: '42', bot: false} as unknown as User;
const PROFILE = {
	guildId: null,
	mutualFriends: [{id: '7'}],
	mutualGuilds: [{id: '9', nick: null}],
} as unknown as Profile;

describe('ProfileBody', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		contentProps.current = null;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = (props: Record<string, unknown> = {}) =>
		act(() =>
			root.render(
				createElement(ProfileBody, {profile: PROFILE, user: USER, userNote: null, isPreview: false, ...props}),
			),
		);
	const openTab = (key: string) =>
		act(() =>
			[...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
				.find((tab) => tab.textContent === key)!
				.click(),
		);

	it('in the modal: its own user info, a mutual friend replaces the modal, a community closes it', () => {
		render();
		expect(container.querySelector('[data-part="user-info"]')).not.toBeNull();
		openTab('mutual_friends');
		act(() => container.querySelector<HTMLButtonElement>('[data-friend="7"]')!.click());
		expect(ModalCommands.update).toHaveBeenCalledTimes(1);
		openTab('mutual_communities_groups');
		act(() => container.querySelector<HTMLButtonElement>('[data-guild]')!.click());
		expect(ModalCommands.pop).toHaveBeenCalledTimes(1);
		expect(NavigationCommands.selectGuild).toHaveBeenCalledWith('9', undefined);
	});

	// Micup: on the page there is no modal to replace or close.
	it('on the page: no second user info, a mutual friend opens through onOpenUser, leaving calls onLeave', () => {
		const onOpenUser = vi.fn();
		const onLeave = vi.fn();
		render({hideUserInfo: true, onOpenUser, onLeave});
		expect(container.querySelector('[data-part="user-info"]')).toBeNull();
		expect(contentProps.current?.onNavigate).toBe(onLeave);
		openTab('mutual_friends');
		act(() => container.querySelector<HTMLButtonElement>('[data-friend="7"]')!.click());
		expect(onOpenUser).toHaveBeenCalledWith('7');
		openTab('mutual_communities_groups');
		act(() => container.querySelector<HTMLButtonElement>('[data-guild]')!.click());
		expect(onLeave).toHaveBeenCalledTimes(1);
		expect(NavigationCommands.selectGuild).toHaveBeenCalledWith('9', undefined);
		expect(ModalCommands.update).not.toHaveBeenCalled();
		expect(ModalCommands.pop).not.toHaveBeenCalled();
	});
});

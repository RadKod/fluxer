// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {ChannelTypes, MessageTypes} from '@fluxer/constants/src/ChannelConstants';
import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	mobile: false,
	activity: null as {manual_name: string; started_at: number} | null,
	lastMessage: null as unknown,
	gameUserIds: [] as Array<string>,
}));
const recipient = vi.hoisted(() => ({
	id: 'u1',
	bot: false,
	system: false,
	nameplate: null,
	isVerified: () => false,
}));
const passThrough = ({children}: {children?: React.ReactNode}) => children ?? null;
const nothing = () => null;

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor, plural: () => 'members'}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message, locale: 'en'}}),
}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({
	default: {showFadedUnreadOnMutedChannels: false, dmMessagePreviewMode: 'all'},
	DMMessagePreviewMode: {ALL: 'all', UNREAD_ONLY: 'unread'},
}));
vi.mock('@app/features/app/components/LongPressable', () => ({
	LongPressable: ({children}: {children?: React.ReactNode}) => createElement('div', null, children),
}));
vi.mock('@app/features/app/components/layout/utils/ChannelUnreadState', () => ({
	getChannelUnreadState: () => ({shouldShowUnreadIndicator: false, hasUnreadMessages: false}),
}));
vi.mock('@app/features/app/components/shared/custom_status_display/CustomStatusDisplay', () => ({
	CustomStatusDisplay: () => createElement('span', {'data-flx': 'test.custom-status'}),
}));
vi.mock('@app/features/app/components/shared/GroupDMAvatar', () => ({GroupDMAvatar: nothing}));
vi.mock('@app/features/app/hooks/useChannelHoverPreload', () => ({
	useChannelHoverPreload: () => ({
		scheduleChannelPreload: () => {},
		cancelChannelPreload: () => {},
		preloadChannelNow: () => {},
	}),
}));
vi.mock('@app/features/app/hooks/useContextMenuHoverState', () => ({useContextMenuHoverState: () => false}));
vi.mock('@app/features/channel/components/ChannelUserTag', () => ({UserTag: nothing}));
vi.mock('@app/features/channel/components/direct_message/DMListHelpers', () => ({
	getDefaultInviteChannelId: () => null,
}));
vi.mock('@app/features/channel/components/direct_message/DMListItemMenuGroups', () => ({
	buildMobileMenuGroups: () => [],
}));
vi.mock('@app/features/channel/components/direct_message/useDMListItemHandlers', () => ({
	useDMListItemHandlers: () => ({navigateTo: () => {}, handleRemoveChannel: () => {}}),
}));
vi.mock('@app/features/channel/components/modals/EditGroupBottomSheet', () => ({EditGroupBottomSheet: nothing}));
vi.mock('@app/features/channel/components/modals/GroupInvitesBottomSheet', () => ({GroupInvitesBottomSheet: nothing}));
vi.mock('@app/features/channel/utils/ChannelUtils', () => ({getDMDisplayName: () => 'Ayse'}));
vi.mock('@app/features/cosmetics/components/NameplateBackground', () => ({NameplateBackground: passThrough}));
vi.mock('@app/features/guild/hooks/useLeaveGroup', () => ({useLeaveGroup: () => () => {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {getGuilds: () => []}}));
vi.mock('@app/features/i18n/utils/CommonMessageDescriptors', () => ({
	MENTION_COUNT_ARIA_DESCRIPTOR: {message: 'mentions'},
}));
vi.mock('@app/features/input/utils/KeyboardUtils', () => ({isKeyboardActivationKey: () => false}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {getMember: () => null}}));
vi.mock('@app/features/messaging/components/markdown', () => ({
	SafeMarkdown: ({content}: {content: string}) => content,
}));
vi.mock('@app/features/messaging/components/markdown/renderers/RendererTypes', () => ({
	MarkdownContext: {RESTRICTED_INLINE_REPLY: 0},
}));
vi.mock('@app/features/messaging/state/MessagingMessages', () => ({
	default: {getCachedMessages: () => ({last: () => state.lastMessage})},
}));
vi.mock('@app/features/messaging/utils/SystemMessageUtils', () => ({SystemMessageUtils: {stringify: () => null}}));
vi.mock('@app/features/read_state/state/ReadStates', () => ({
	default: {hasUnread: () => false, getMentionCount: () => 0, getUnreadCount: () => 0},
}));
vi.mock('@app/features/relationship/state/Relationships', () => ({default: {getRelationship: () => null}}));
vi.mock('@app/features/typing/state/TypingIndicator', () => ({default: {isTyping: () => false}}));
vi.mock('@app/features/ui/action_menu/DMContextMenu', () => ({DMContextMenu: nothing}));
vi.mock('@app/features/ui/action_menu/GroupDMContextMenu', () => ({GroupDMContextMenu: nothing}));
vi.mock('@app/features/ui/commands/ContextMenuCommands', () => ({openFromEvent: vi.fn()}));
vi.mock('@app/features/ui/components/StatusAwareAvatar', () => ({ListStatusAwareAvatar: nothing}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: passThrough}));
vi.mock('@app/features/ui/hooks/useTextOverflow', () => ({useTextOverflow: () => false}));
vi.mock('@app/features/ui/menu_bottom_sheet/MenuBottomSheet', () => ({MenuBottomSheet: nothing}));
vi.mock('@app/features/ui/state/KeyboardMode', () => ({default: {keyboardModeEnabled: false}}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {isMobileLayout: () => state.mobile}}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: passThrough}));
vi.mock('@app/features/ui/utils/ShortRelativeTimeLabels', () => ({formatShortRelativeTime: () => '1m'}));
vi.mock('@app/features/user/components/VerifiedUserBadge', () => ({
	VERIFIED_ACCOUNT_DESCRIPTOR: {message: 'verified'},
	VerifiedUserBadge: nothing,
}));
vi.mock('@app/features/user/state/UserGuildSettings', () => ({default: {isChannelDirectlyMuted: () => false}}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {getCurrentUser: () => ({id: 'me'}), getUser: () => recipient},
}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getNickname: () => 'Ayse'}));
vi.mock('framer-motion', () => ({AnimatePresence: passThrough, motion: {span: nothing}}));
vi.mock('@app/features/game_activity/hooks/useGameActivity', () => ({
	useGameActivity: ({userId, enabled = true}: {userId: string; enabled?: boolean}) => {
		state.gameUserIds.push(userId);
		return enabled ? state.activity : null;
	},
}));
vi.mock('@app/features/game_activity/components/GameActivityRowStatus', () => ({
	GameActivityRowStatus: ({activity}: {activity: {manual_name: string}}) =>
		createElement('span', {'data-flx': 'test.game'}, activity.manual_name),
}));

const {DMListItem} = await import('@app/features/channel/components/direct_message/DMListItem');

const channel = {
	id: 'c1',
	type: ChannelTypes.DM,
	recipientIds: ['u1'],
	isPinned: false,
	lastMessageId: null,
};
const message = {
	id: 'm1',
	type: MessageTypes.DEFAULT,
	author: {id: 'u1'},
	content: 'hello there',
	attachments: [],
	mentionChannels: [],
};

describe.each([
	['desktop', false],
	['mobile', true],
])('DMListItem game activity (%s)', (_name, mobile) => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		state.mobile = mobile;
		state.activity = null;
		state.lastMessage = null;
		state.gameUserIds = [];
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = () =>
		act(() => root.render(createElement(DMListItem, {channel: {...channel} as never, isSelected: false})));
	const text = () => container.textContent ?? '';
	const slot = (name: string) => container.querySelector(`[data-flx="test.${name}"]`);

	it('replaces the message preview with the game and restores it when the game ends', () => {
		state.lastMessage = message;
		state.activity = {manual_name: 'Chess', started_at: 1};
		render();

		expect(slot('game')?.textContent).toBe('Chess');
		expect(text()).not.toContain('hello there');
		expect(slot('custom-status')).toBeNull();
		expect(state.gameUserIds).toContain('u1');

		state.activity = null;
		render();

		expect(slot('game')).toBeNull();
		expect(text()).toContain('hello there');
	});

	it('replaces the custom status with the game and restores it when the game ends', () => {
		state.activity = {manual_name: 'Chess', started_at: 1};
		render();

		expect(slot('game')?.textContent).toBe('Chess');
		expect(slot('custom-status')).toBeNull();

		state.activity = null;
		render();

		expect(slot('game')).toBeNull();
		expect(slot('custom-status')).not.toBeNull();
	});
});

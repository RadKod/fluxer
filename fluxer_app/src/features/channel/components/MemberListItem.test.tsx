// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {PublicUserFlags} from '@fluxer/constants/src/UserConstants';
import {act, createElement, forwardRef, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Micup: the member list draws the premium crown after the name only for users with the
// PREMIUM_BADGE flag.

const passThrough = ({children}: {children?: ReactNode}) => children ?? null;
const i18n = {_: (descriptor: {message: string}) => descriptor.message};

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n}), Trans: passThrough}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {localInstanceDomain: 'micup.test', getSnapshotOrNull: () => null},
}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: 'me'}}));
vi.mock('@app/features/channel/components/ChannelUserTag', () => ({UserTag: () => null}));
vi.mock('@app/features/channel/components/CompactMemberCustomStatus', () => ({CompactMemberCustomStatus: () => null}));
vi.mock('@app/features/channel/components/PreloadableUserPopout', () => ({
	PreloadableUserPopout: forwardRef<HTMLElement, {children?: ReactNode}>(({children}, _ref) => children ?? null),
}));
vi.mock('@app/features/cosmetics/components/NameplateBackground', () => ({NameplateBackground: passThrough}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {getGuild: () => null}}));
vi.mock('@app/features/member/hooks/useMemberListCustomStatus', () => ({useMemberListCustomStatus: () => null}));
vi.mock('@app/features/member/hooks/useMemberListPresence', () => ({useMemberListPresence: () => 'online'}));
const premium = vi.hoisted(() => ({open: vi.fn()}));
vi.mock('@app/features/premium/commands/PremiumModalCommands', () => ({open: premium.open}));
vi.mock('@app/features/premium/utils/PremiumUtils', async (importOriginal) => ({
	...(await importOriginal<typeof import('@app/features/premium/utils/PremiumUtils')>()),
	shouldShowPremiumFeatures: () => true,
}));
vi.mock('@app/features/typing/state/TypingIndicator', () => ({default: {isMemberListTyping: () => false}}));
vi.mock('@app/features/ui/action_menu/GroupDMContextMenu', () => ({GroupDMMemberContextMenu: () => null}));
vi.mock('@app/features/ui/action_menu/GuildMemberContextMenu', () => ({GuildMemberContextMenu: () => null}));
vi.mock('@app/features/ui/commands/ContextMenuCommands', () => ({openFromEvent: vi.fn()}));
vi.mock('@app/features/ui/components/FocusRingWrapper', () => ({FocusRingWrapper: passThrough}));
vi.mock('@app/features/ui/components/StatusAwareAvatar', () => ({ListStatusAwareAvatar: () => null}));
vi.mock('@app/features/ui/hooks/useTextOverflow', () => ({useTextOverflow: () => false}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: passThrough}));
vi.mock('@app/features/user/components/VerifiedUserBadge', () => ({VerifiedUserBadge: () => null}));
vi.mock('@app/features/user/utils/AvatarUtils', () => ({getGuildMemberDisplayAvatarURL: () => null}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({
	getNickname: (user: {displayName: string}) => user.displayName,
}));

const {MemberListItem} = await import('@app/features/channel/components/MemberListItem');
const {User} = await import('@app/features/user/models/User');

const member = (flags: number) =>
	new User({
		id: '42',
		username: 'ayse',
		discriminator: '0001',
		global_name: 'Ayse',
		avatar: null,
		avatar_color: null,
		flags,
	});

describe('MemberListItem premium crown', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = (flags: number) =>
		act(() => root.render(createElement(MemberListItem, {user: member(flags), channelId: '7', status: 'online'})));
	const crown = () => container.querySelector('[data-flx="channel.member-list-item.premium-user-badge"]');

	it('draws the crown right after the name for a member with PREMIUM_BADGE', () => {
		render(PublicUserFlags.PREMIUM_BADGE);

		const name = container.querySelector('[data-flx="channel.member-list-item.name"]')!;
		expect(name.textContent).toBe('Ayse');
		expect(crown()).not.toBeNull();
		expect(name.compareDocumentPosition(crown()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	// the whole row is a button, so the crown must not be a second one inside it.
	it('keeps the crown out of the row button as a nested button, yet a click opens the premium page', () => {
		premium.open.mockClear();
		render(PublicUserFlags.PREMIUM_BADGE);

		expect(container.querySelectorAll('button')).toHaveLength(1);
		expect(container.querySelector('button button')).toBeNull();
		expect(crown()!.hasAttribute('tabindex')).toBe(false);
		act(() => (crown() as HTMLElement).click());
		expect(premium.open).toHaveBeenCalledTimes(1);
	});

	it.each([
		['no flags', 0],
		['VERIFIED alone', PublicUserFlags.VERIFIED],
	])('draws no crown without the bit (%s)', (_name, flags) => {
		render(flags);

		expect(container.querySelector('[data-flx="channel.member-list-item.name"]')?.textContent).toBe('Ayse');
		expect(crown()).toBeNull();
	});
});

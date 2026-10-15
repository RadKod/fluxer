// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/channel/components/MemberListItem.module.css';
import type {GuildMember} from '@app/features/member/models/GuildMember';
import {mountCssModule} from '@app/features/name_style/testing/CssModuleSheet';
import {PublicUserFlags} from '@fluxer/constants/src/UserConstants';
import {act, createElement, forwardRef, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

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
vi.mock('@app/features/emoji/state/Emoji', () => ({default: {getEmojiById: () => undefined}}));
vi.mock('@app/features/channel/components/ChannelUserTag', () => ({UserTag: () => null}));
vi.mock('@app/features/channel/components/CompactMemberCustomStatus', () => ({
	CompactMemberCustomStatus: () => createElement('span', {'data-flx': 'test.custom-status'}),
}));
const game = vi.hoisted(() => ({activity: null as {manual_name: string; started_at: number} | null}));
vi.mock('@app/features/game_activity/hooks/useGameActivity', () => ({useGameActivity: () => game.activity}));
vi.mock('@app/features/game_activity/components/GameActivityRowStatus', () => ({
	GameActivityRowStatus: ({activity}: {activity: {manual_name: string}}) =>
		createElement('span', {'data-flx': 'test.game'}, activity.manual_name),
}));
vi.mock('@app/features/channel/components/PreloadableUserPopout', () => ({
	PreloadableUserPopout: forwardRef<HTMLElement, {children?: ReactNode}>(({children}, _ref) => children ?? null),
}));
vi.mock('@app/features/cosmetics/components/NameplateBackground', () => ({NameplateBackground: passThrough}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {getGuild: () => null}}));
vi.mock('@app/features/name_style/NameStyleFontLoader', () => ({requestNameStyleFont: () => {}}));
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

describe('MemberListItem game activity', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		game.activity = null;
		act(() => root.unmount());
		container.remove();
	});

	const render = () =>
		act(() => root.render(createElement(MemberListItem, {user: member(0), channelId: '7', status: 'online'})));
	const slot = (name: string) => container.querySelector(`[data-flx="test.${name}"]`);

	it('shows the game in place of the custom status and brings the status back when it ends', () => {
		game.activity = {manual_name: 'Chess', started_at: 1};
		render();

		expect(slot('game')?.textContent).toBe('Chess');
		expect(slot('custom-status')).toBeNull();

		game.activity = null;
		render();

		expect(slot('game')).toBeNull();
		expect(slot('custom-status')).not.toBeNull();
	});
});

describe('MemberListItem offline name on the coal and dark themes', () => {
	const ROLE = 0x2ecc71;
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let sheet: HTMLStyleElement;

	beforeAll(() => {
		sheet = mountCssModule('src/features/channel/components/MemberListItem.module.css', styles);
	});
	afterAll(() => {
		sheet.remove();
		document.documentElement.className = '';
	});
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

	type Row = {role?: boolean; plus?: boolean; roleColor?: string; status?: 'online' | 'offline'};
	const render = ({role = false, plus = false, roleColor, status = 'offline'}: Row) => {
		const user = new User({
			id: '42',
			username: 'ayse',
			discriminator: '0001',
			global_name: 'Ayse',
			avatar: null,
			avatar_color: null,
			flags: 0,
			name_style: plus ? {font_id: 1, colors: [0x8b5cf6, 0xec4899]} : null,
		});
		const guildMember = {
			avatar: null,
			isAvatarUnset: () => true,
			getColorRole: () => (role ? {color: ROLE, colorSecondary: null} : undefined),
			getIconRole: () => undefined,
		} as unknown as GuildMember;
		// happy-dom does not match :has() again after a child's style changes, so every row mounts afresh.
		act(() => root.unmount());
		root = createRoot(container);
		act(() =>
			root.render(
				createElement(MemberListItem, {
					user,
					channelId: '7',
					guildId: '9',
					guildMember: roleColor ? undefined : guildMember,
					roleColor,
					status,
				}),
			),
		);
	};
	const name = () => container.querySelector('[data-flx="channel.member-list-item.name"]')!;
	const opacity = () => getComputedStyle(name()).opacity;

	it.each(['theme-dark', 'theme-coal'])(
		'dims a role-coloured, a Plus-coloured and a role-coloured Plus name alike on %s',
		(theme) => {
			document.documentElement.className = theme;
			for (const row of [{role: true}, {plus: true}, {role: true, plus: true}, {roleColor: '#2ecc71'}]) {
				render(row);
				expect(opacity(), JSON.stringify(row)).toBe('0.6');
			}
		},
	);

	it('leaves a default-coloured name to the row colour alone', () => {
		document.documentElement.className = 'theme-dark';
		render({});
		expect(opacity()).not.toBe('0.6');
		document.documentElement.className = 'theme-dark hide-name-styles';
		render({plus: true});
		expect(opacity()).not.toBe('0.6');
		render({role: true, plus: true});
		expect(opacity()).toBe('0.6');
	});

	it('brings the name back for an open profile, an online member and the light theme', () => {
		document.documentElement.className = 'theme-dark';
		render({role: true, plus: true});
		container.querySelector('button')!.setAttribute('aria-expanded', 'true');
		expect(opacity()).not.toBe('0.6');
		render({role: true, plus: true, status: 'online'});
		expect(opacity()).not.toBe('0.6');
		document.documentElement.className = 'theme-light';
		render({role: true, plus: true});
		expect(opacity()).not.toBe('0.6');
	});
});

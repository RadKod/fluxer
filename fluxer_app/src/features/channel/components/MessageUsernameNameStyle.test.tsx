// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import roleStyles from '@app/features/guild/components/RoleAppearance.module.css';
import type {GuildMember} from '@app/features/member/models/GuildMember';
import type {Message} from '@app/features/messaging/models/MessagingMessage';
import nameStyles from '@app/features/name_style/components/NameStyleText.module.css';
import {mountCssModule} from '@app/features/name_style/testing/CssModuleSheet';
import messageStyles from '@app/features/theme/styles/Message.module.css';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

// sanalyer: the message author name draws the chosen font, not only the chosen colour.

const passThrough = ({children}: {children?: ReactNode}) => children ?? null;
const i18n = {_: (descriptor: {message: string}) => descriptor.message};

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n}), Trans: passThrough}));

vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {localInstanceDomain: 'sanalyer.test', getSnapshotOrNull: () => null},
}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: 'me'}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/app/hooks/useContextMenuHoverState', () => ({useContextMenuHoverState: () => false}));
vi.mock('@app/features/channel/components/CrosspostCommunityPopout', () => ({CrosspostCommunityPopout: passThrough}));
vi.mock('@app/features/channel/components/MessageViewContext', () => ({useMaybeMessageViewContext: () => null}));
vi.mock('@app/features/channel/components/PreloadableUserPopout', () => ({PreloadableUserPopout: passThrough}));
vi.mock('@app/features/name_style/NameStyleFontLoader', () => ({requestNameStyleFont: () => {}}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: passThrough}));
vi.mock('@app/features/ui/state/KeyboardMode', () => ({default: {keyboardModeEnabled: false}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({
	getNickname: (user: {displayName: string}) => user.displayName,
}));

const {MessageUsername} = await import('@app/features/channel/components/MessageUsername');
const {User} = await import('@app/features/user/models/User');

describe('MessageUsername styled name font', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const sheets: Array<HTMLStyleElement> = [];

	beforeAll(() => {
		sheets.push(
			mountCssModule('src/features/theme/styles/Message.module.css', messageStyles),
			mountCssModule('src/features/name_style/components/NameStyleText.module.css', nameStyles),
			mountCssModule('src/features/guild/components/RoleAppearance.module.css', roleStyles),
		);
		const fonts = document.createElement('style');
		fonts.textContent = ':root { --font-sans: "Fluxer Sans", sans-serif; }';
		document.head.append(fonts);
		sheets.push(fonts);
		document.documentElement.className = 'theme-dark';
	});
	afterAll(() => {
		for (const sheet of sheets) sheet.remove();
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

	it.each([
		['solid', [0x8b5cf6]],
		['gradient', [0x8b5cf6, 0xec4899]],
	])('draws a %s author name in its font, role colour or not', (_kind, colors) => {
		const user = new User({
			id: '42',
			username: 'ayse',
			discriminator: '0001',
			global_name: 'Ayse',
			avatar: null,
			avatar_color: null,
			flags: 0,
			name_style: {font_id: 6, colors},
		});
		const message = {webhookId: null, channelId: '7', isCrosspostCopy: false} as unknown as Message;
		for (const role of [false, true]) {
			const member = role
				? ({
						getColorRole: () => ({color: 0x2ecc71, colorSecondary: null}),
						getColorString: () => '#2ecc71',
						getIconRole: () => undefined,
					} as unknown as GuildMember)
				: undefined;
			act(() =>
				root.render(
					createElement(MessageUsername, {
						user,
						message,
						member,
						className: messageStyles.messageUsername,
						isPreview: false,
					}),
				),
			);
			const name = container.querySelector<HTMLElement>(
				'[data-flx="channel.message-username.context-menu-underline.key-down"]',
			)!;
			expect(name.textContent).toBe('Ayse');
			expect(name.dataset.nameStyle).toBe('pressstart');
			expect(name.style.getPropertyValue('--name-style-font')).toContain("'sanalyer Name pressstart'");
			expect(getComputedStyle(name).fontFamily).toContain('sanalyer Name pressstart');
			expect(getComputedStyle(name.firstElementChild!).fontFamily).toContain('sanalyer Name pressstart');
			expect(getComputedStyle(name).display).not.toBe('none');
		}
	});
});

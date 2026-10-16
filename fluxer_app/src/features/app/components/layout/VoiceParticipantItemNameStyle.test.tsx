// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/app/components/layout/VoiceParticipantItem.module.css';
import nameStyles from '@app/features/name_style/components/NameStyleText.module.css';
import {mountCssModule} from '@app/features/name_style/testing/CssModuleSheet';
import type {NameStyle} from '@fluxer/schema/src/domains/user/PlusAppearanceSchemas';
import {act, createElement, forwardRef, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

// sanalyer: the voice channel participant row draws a styled name in its font, and the name keeps its width in the
// row (a gradient name used to collapse to zero width there, leaving only the avatar).

const passThrough = ({children}: {children?: ReactNode}) => children ?? null;
const i18n = {_: (descriptor: {message: string}) => descriptor.message, locale: 'en-US'};

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n}), Trans: passThrough}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {localInstanceDomain: 'sanalyer.test', getSnapshotOrNull: () => null},
}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: 'me'}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {getGuild: () => null}}));
vi.mock('@app/features/name_style/NameStyleFontLoader', () => ({requestNameStyleFont: () => {}}));
vi.mock('@app/features/permissions/state/Permission', () => ({default: {can: () => false}}));
vi.mock('react-dnd', () => ({useDrag: () => [{isDragging: false}, () => {}]}));
vi.mock('@app/features/app/components/LongPressable', () => ({
	LongPressable: forwardRef<HTMLDivElement, Record<string, unknown>>(({onLongPress: _, ...props}, ref) =>
		createElement('div', {...props, ref}),
	),
}));
vi.mock('@app/features/app/components/layout/VoiceStateIcons', () => ({VoiceStateIcons: () => null}));
vi.mock('@app/features/app/hooks/useContextMenuHoverState', () => ({useContextMenuHoverState: () => false}));
vi.mock('@app/features/channel/components/PreloadableUserPopout', () => ({PreloadableUserPopout: passThrough}));
vi.mock('@app/features/ui/action_menu/VoiceParticipantContextMenu', () => ({VoiceParticipantContextMenu: () => null}));
vi.mock('@app/features/ui/avatars/AvatarWithPresence', () => ({
	AvatarWithPresence: () => createElement('img', {'data-flx': 'test.avatar'}),
}));
vi.mock('@app/features/ui/commands/ContextMenuCommands', () => ({openFromEvent: vi.fn()}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: passThrough}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {isMobileLayout: () => false}}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: passThrough}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({
	getNickname: (user: {displayName: string}) => user.displayName,
}));
vi.mock('@app/features/voice/components/bottomsheets/VoiceParticipantBottomSheet', () => ({
	VoiceParticipantBottomSheet: () => null,
}));
vi.mock('@app/features/voice/components/StreamWatchHoverPopout', () => ({StreamWatchHoverPopout: passThrough}));
vi.mock('@app/features/voice/components/useStreamWatchState', () => ({
	useStreamWatchState: () => ({startWatching: () => {}}),
}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({
	default: {getParticipantByUserIdAndConnectionId: () => undefined, channelId: 'c'},
	useMediaEngineVersion: () => 0,
}));
vi.mock('@app/features/voice/hooks/useStreamWatchDoubleClick', () => ({
	useStreamWatchDoubleClick: () => ({onClick: () => {}, onDoubleClick: () => {}}),
}));
vi.mock('@app/features/voice/state/LocalVoiceState', () => ({
	default: {getSelfMute: () => false, getSelfDeaf: () => false, getSelfVideo: () => false, getSelfStream: () => false},
}));
vi.mock('@app/features/voice/utils/VoicePermissionUtils', () => ({isParticipantVoicePermissionMuted: () => false}));

const {VoiceParticipantItem} = await import('@app/features/app/components/layout/VoiceParticipantItem');
const {User} = await import('@app/features/user/models/User');

describe('VoiceParticipantItem styled name', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const sheets: Array<HTMLStyleElement> = [];

	beforeAll(() => {
		sheets.push(
			mountCssModule('src/features/app/components/layout/VoiceParticipantItem.module.css', styles),
			mountCssModule('src/features/name_style/components/NameStyleText.module.css', nameStyles),
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

	const render = (nameStyle: NameStyle) => {
		const user = new User({
			id: '42',
			username: 'ayse',
			discriminator: '0001',
			global_name: 'Ayse',
			avatar: null,
			avatar_color: null,
			flags: 0,
			name_style: nameStyle,
		});
		const voiceState = {user_id: '42', channel_id: 'c', connection_id: 'conn'} as never;
		act(() => root.render(createElement(VoiceParticipantItem, {user, voiceState, guildId: 'g'})));
		return container.querySelector<HTMLElement>('[data-flx="app.voice-participant-item.participant-name--2"]')!;
	};

	it.each<[string, NameStyle]>([
		['solid', {font_id: 6, colors: [0x8b5cf6]}],
		['gradient', {font_id: 6, colors: [0x8b5cf6, 0xec4899]}],
	])('draws a %s name in its font with room in the row', (_kind, nameStyle) => {
		const name = render(nameStyle);
		expect(name.textContent).toBe('Ayse');
		expect(name.dataset.nameStyle).toBe('pressstart');
		expect(name.style.getPropertyValue('--name-style-font')).toContain("'sanalyer Name pressstart'");
		const computed = getComputedStyle(name);
		expect(computed.fontFamily).toContain('sanalyer Name pressstart');
		expect(computed.display).not.toBe('none');
		expect(computed.width).not.toMatch(/^0(px)?$/);
		// overflow: hidden drops the automatic minimum size, so a zero basis that does not grow leaves no width.
		const zeroBasis = /^0(%|px)?$/.test(computed.flexBasis);
		expect(zeroBasis && computed.flexGrow === '0', `flex: ${computed.flex}`).toBe(false);
	});
});

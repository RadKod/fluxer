// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({canManage: false}));
const openPanel = vi.hoisted(() => vi.fn());
vi.mock('@app/features/boost/commands/GuildBoostPanelCommands', () => ({openGuildBoostPanel: openPanel}));
const modalCommands = vi.hoisted(() => ({
	push: vi.fn(),
	pushAfterBottomSheetClose: vi.fn(),
	runAfterBottomSheetClose: vi.fn((_close: () => void, action: () => void) => action()),
	modal: (render: () => unknown) => render,
}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {locale: 'en-US', _: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {
		getSnapshotOrNull: () => null,
		localInstanceDomain: 'micup.test',
		webAppEndpoint: 'https://micup.test',
		mediaEndpoint: 'https://media.micup.test',
		staticCdnEndpoint: 'https://static.micup.test',
		isSelfHosted: () => true,
		features: {},
	},
}));
// libfluxcore and the markdown parser are Rust compiled to WASM and exist only after `wasm:codegen` (Linux, KL7).
vi.mock('@app/features/messaging/utils/markdown/parser/MarkdownParserWasm', () => ({
	preloadMarkdownParserWasm: async () => {},
	parseMarkdownAstWithWasm: (input: string) => ({nodes: [{type: 'Text', content: input}]}),
}));
vi.mock('@app/features/platform/utils/LibFluxcore', () => ({
	isLibfluxcoreReady: () => false,
	ensureLibfluxcoreReady: async () => {},
}));
vi.mock('@app/features/permissions/state/Permission', () => ({default: {can: () => state.canManage}}));
vi.mock('@app/features/invite/utils/InviteUtils', () => ({
	getInvitableChannelId: () => null,
	canInviteToChannel: () => false,
}));
vi.mock('@app/features/ui/commands/ModalCommands', () => modalCommands);
vi.mock('@app/features/ui/commands/PopoutCommands', () => ({close: vi.fn()}));
vi.mock('@app/features/guild/components/modals/GuildSettingsModal', () => ({GuildSettingsModal: () => null}));
vi.mock('@app/features/user/components/settings_utils/GuildSettingsConstants', () => ({
	GUILD_SETTINGS_LABEL_DESCRIPTOR: {message: 'Community settings'},
	getGuildSettingsTabs: () => [],
}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {getGuildChannels: () => []}}));
vi.mock('@app/features/read_state/state/ReadStates', () => ({default: {hasUnread: () => false}}));
vi.mock('@app/features/user/state/UserGuildSettings', () => ({default: {getSettingsForScope: () => null}}));
vi.mock('@app/features/user/state/Users', () => ({default: {getCurrentUser: () => null}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: '1'}}));
vi.mock('@app/features/guild/hooks/useLeaveGuild', () => ({useLeaveGuild: () => vi.fn()}));
vi.mock('@app/features/guild/hooks/useDeleteMyMessagesInGuild', () => ({useDeleteMyMessagesInGuild: () => vi.fn()}));
vi.mock('@app/lib/overlay/OverlayContextMenu', () => ({getMutedText: () => null}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: unknown}) => children}));
// The menus only need these modals as element types.
vi.mock('@app/features/channel/components/modals/CategoryCreateModal', () => ({CategoryCreateModal: () => null}));
vi.mock('@app/features/channel/components/modals/ChannelCreateModal', () => ({ChannelCreateModal: () => null}));
vi.mock('@app/features/devtools/components/debug/GuildDebugModal', () => ({GuildDebugModal: () => null}));
vi.mock('@app/features/guild/components/modals/GuildNotificationSettingsModal', () => ({
	GuildNotificationSettingsModal: () => null,
}));
vi.mock('@app/features/guild/components/modals/GuildPrivacySettingsModal', () => ({
	GuildPrivacySettingsModal: () => null,
}));
vi.mock('@app/features/invite/components/modals/InviteModal', () => ({InviteModal: () => null}));
vi.mock('@app/features/user/components/modals/UserSettingsModal', () => ({UserSettingsModal: () => null}));
vi.mock('@app/features/moderation/utils/ReportActionUtils', () => ({openReportGuildModal: vi.fn()}));
vi.mock('@app/features/read_state/commands/ReadStateCommands', () => ({bulkAckChannels: vi.fn()}));
vi.mock('@app/features/user/commands/UserGuildSettingsCommands', () => ({toggleHideMutedChannels: vi.fn()}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => ({transitionTo: vi.fn()}));
vi.mock('@app/features/guild/state/GuildMatureContentAgree', () => ({default: {revokeGuild: vi.fn()}}));

// The menus import stores that read the page bootstrap at import time.
(window as unknown as {__FLUXER_BOOTSTRAP__: unknown}).__FLUXER_BOOTSTRAP__ = {
	instance: {app_public: {branding: {product_name: 'Micup'}}},
	config: {releaseChannel: 'stable', bootstrapApiEndpoint: 'https://micup.test/api'},
	geoip: {
		countryCode: 'TR',
		regionCode: null,
		latitude: null,
		longitude: null,
		ageRestrictedGeos: [],
		ageBlockedGeos: [],
	},
};

// Idle and LocalPresence import each other; loading Idle first keeps its timer from calling a half-loaded store.
await import('@app/features/ui/state/Idle');
const {useGuildMenuData} = await import('@app/features/ui/action_menu/items/GuildMenuData');
const {GuildHeaderPopout} = await import('@app/features/guild/components/popouts/GuildHeaderPopout');

const guild = {
	id: '42',
	features: new Set<string>(),
	nsfw: false,
	contentWarningLevel: 0,
	isOwner: () => false,
} as never;

type MenuItem = {label: string; onClick?: () => void; items?: Array<unknown>};

describe('boost entry in the community menus', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		state.canManage = false;
		openPanel.mockClear();
		for (const fn of [modalCommands.push, modalCommands.pushAfterBottomSheetClose]) fn.mockClear();
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function menuItems(): Array<MenuItem> {
		let items: Array<MenuItem> = [];
		const Probe = () => {
			items = useGuildMenuData(guild, {onClose: () => {}}).groups.flatMap((group) => group.items as Array<MenuItem>);
			return null;
		};
		act(() => root.render(createElement(Probe)));
		return items;
	}

	it('offers a member without community settings to boost from the context menu and mobile sheet', () => {
		const entry = menuItems().find((item) => item.label === 'Boost this community');
		expect(entry).toBeDefined();
		entry!.onClick!();
		expect(openPanel).toHaveBeenCalledWith('42');
		expect(modalCommands.runAfterBottomSheetClose).toHaveBeenCalled();
	});

	it('leaves boosting to community settings for members who can open them', () => {
		state.canManage = true;
		expect(menuItems().some((item) => item.label === 'Boost this community')).toBe(false);
	});

	it('offers the same entry in the community header menu', () => {
		act(() => root.render(createElement(GuildHeaderPopout, {guild})));
		const entry = Array.from(container.querySelectorAll('[role="menuitem"]')).find(
			(item) => item.textContent === 'Boost this community',
		) as HTMLElement | undefined;
		expect(entry).toBeDefined();
		act(() => entry!.click());
		expect(openPanel).toHaveBeenCalledWith('42');
	});
});

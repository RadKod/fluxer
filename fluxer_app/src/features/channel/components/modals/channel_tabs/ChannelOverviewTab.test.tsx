// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({channel: null as Record<string, unknown> | null}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
	Trans: ({children}: {children: unknown}) => children,
}));
vi.mock('@app/features/channel/components/modals/channel_tabs/ChannelOverviewTab.module.css', () => ({default: {}}));
vi.mock('@app/features/app/components/alerts/GenericErrorModalCommands', () => ({showGenericErrorModal: vi.fn()}));
vi.mock('@app/features/app/components/dialogs/ConfirmModal', () => ({ConfirmModal: () => null}));
vi.mock('@app/features/app/components/dialogs/shared/SettingsSection', () => ({SettingsSection: () => null}));
vi.mock('@app/features/app/config/I18nDisplayConstants', () => ({
	EXAMPLE_GENERAL_CHANNEL_NAME: 'general',
	EXAMPLE_URL: 'https://example.com',
}));
vi.mock('@app/features/app/hooks/useFormSubmit', () => ({useFormSubmit: () => ({handleSubmit: vi.fn()})}));
vi.mock('@app/features/channel/commands/ChannelCommands', () => ({fetchRtcRegions: vi.fn(async () => [])}));
vi.mock('@app/features/channel/components/alerts/ChannelErrorModalUtils', () => ({showChannelErrorModal: vi.fn()}));
vi.mock('@app/features/channel/components/alerts/VoiceRegionsLoadFailedModal', () => ({
	VoiceRegionsLoadFailedModal: () => null,
}));
vi.mock('@app/features/channel/components/modals/channel_tabs/channel_overview_tab/ChannelOverviewTopicEditor', () => ({
	ChannelOverviewTopicEditor: () => null,
}));
vi.mock('@app/features/channel/components/modals/channel_tabs/channel_overview_tab/MatureContentSection', () => ({
	MatureContentSection: () => null,
}));
vi.mock('@app/features/channel/components/modals/channel_tabs/channel_overview_tab/RtcRegionSelect', () => ({
	RtcRegionSelect: () => null,
}));
vi.mock('@app/features/channel/components/modals/channel_tabs/channel_overview_tab/SlowmodeControl', () => ({
	SlowmodeControl: () => null,
}));
vi.mock('@app/features/channel/components/modals/channel_tabs/channel_overview_tab/VoiceSettings', () => ({
	VoiceConnectionLimitControl: () => null,
	VoiceSettings: () => null,
}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {getChannel: () => state.channel}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {getGuild: () => null}}));
vi.mock('@app/features/mature_content/utils/MatureContentSettingsUtils', () => ({
	shouldShowChannelMatureContentSettings: () => false,
}));
vi.mock('@app/features/permissions/state/Permission', () => ({default: {can: () => true}}));
vi.mock('@app/features/platform/utils/ResponseInspection', () => ({failureCode: vi.fn(), failureMessage: vi.fn()}));
vi.mock('@app/features/threads/components/ThreadDefaultsSection', () => ({ThreadDefaultsSection: () => null}));
vi.mock('@app/features/threads/state/ThreadGuilds', () => ({default: {isActive: () => false}}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({push: vi.fn(), modal: (render: unknown) => render}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({}));
vi.mock('@app/features/ui/commands/UnsavedChangesCommands', () => ({
	setUnsavedChanges: vi.fn(),
	setTabData: vi.fn(),
	clearUnsavedChanges: vi.fn(),
}));
vi.mock('@app/features/ui/components/form/FormInput', () => ({Input: () => null}));
vi.mock('@app/features/ui/components/form/FormSwitch', () => ({
	Switch: (props: {'data-flx'?: string}) => createElement('div', {'data-flx': props['data-flx']}),
}));
vi.mock('@app/lib/forms/RemoteFormReset', () => ({
	useRemoteFormReset: () => ({resetToRemoteValues: vi.fn(), commitRemoteValues: vi.fn()}),
}));

const {default: ChannelOverviewTab} = await import(
	'@app/features/channel/components/modals/channel_tabs/ChannelOverviewTab'
);

const ANNOUNCEMENT_SWITCH = '[data-flx="channel.channel-tabs.channel-overview-tab.announcement-switch.change"]';

let root: Root | null = null;
let container: HTMLElement | null = null;

async function renderOverview(type: number): Promise<HTMLElement> {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	state.channel = {id: '20', guildId: '10', type, name: 'news', topic: null, url: null, rateLimitPerUser: 0};
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(createElement(ChannelOverviewTab, {channelId: '20'}));
	});
	return container;
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	container?.remove();
	root = null;
	container = null;
});

describe('ChannelOverviewTab announcement switch', () => {
	it('does not offer turning a text channel into an announcement channel', async () => {
		const view = await renderOverview(ChannelTypes.GUILD_TEXT);
		expect(view.querySelector(ANNOUNCEMENT_SWITCH)).toBeNull();
	});

	it('keeps the switch on an announcement channel so it can be turned back into text', async () => {
		const view = await renderOverview(ChannelTypes.GUILD_ANNOUNCEMENT);
		expect(view.querySelector(ANNOUNCEMENT_SWITCH)).not.toBeNull();
	});
});

// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {ContentWarningLevel} from '@fluxer/constants/src/GuildConstants';
import type {Channel as WireChannel} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	limits: {} as Record<string, number>,
	channel: null as unknown,
	guildNsfw: false,
}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({
		i18n: {
			locale: 'en',
			_: (descriptor: {message: string}, values: Record<string, unknown> = {}) =>
				descriptor.message.replace(/\{(\w+)\}/g, (token, key: string) => (key in values ? String(values[key]) : token)),
		},
	}),
	Trans: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({
	LimitResolver: {
		resolve: ({key, fallback}: {key: string; fallback: number}) => state.limits[key] ?? fallback,
	},
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {localInstanceDomain: 'fluxer.test', getSnapshotOrNull: () => null},
}));
vi.mock('@app/features/user/state/Users', () => ({default: {getUser: () => undefined, cacheUsers: () => {}}}));
vi.mock('@app/features/user/state/UserPinnedDM', () => ({default: {pinnedDMs: []}}));
vi.mock('@app/features/theme/fonts/ScriptFontLoader', () => ({noteText: () => {}}));
vi.mock('@app/features/experiment/state/ExperimentAssignments', () => ({
	default: {response: {assignments: {voice_room: {rooms: false, games: false, default_room_theme: null}}}},
}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {getChannel: () => state.channel}}));
vi.mock('@app/features/guild/state/Guilds', () => ({
	default: {getGuild: () => ({features: [], nsfw: state.guildNsfw, contentWarningLevel: 0, contentWarningText: null})},
}));
vi.mock('@app/features/permissions/state/Permission', () => ({default: {can: () => true}}));
vi.mock('@app/features/channel/commands/ChannelCommands', () => ({
	update: vi.fn(async () => undefined),
	fetchRtcRegions: vi.fn(async () => []),
}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({createToast: vi.fn()}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({push: vi.fn(), modal: vi.fn()}));
vi.mock('@app/features/ui/commands/UnsavedChangesCommands', () => ({
	setUnsavedChanges: vi.fn(),
	clearUnsavedChanges: vi.fn(),
	setTabData: vi.fn(),
}));
vi.mock('@app/features/app/hooks/useFormSubmit', () => ({
	useFormSubmit: () => ({handleSubmit: async () => undefined, isSubmitting: false}),
}));
vi.mock('@app/features/app/components/dialogs/shared/SettingsSection', () => ({
	SettingsSection: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/channel/components/alerts/ChannelErrorModalUtils', () => ({showChannelErrorModal: vi.fn()}));
vi.mock('@app/features/channel/components/alerts/VoiceRegionsLoadFailedModal', () => ({
	VoiceRegionsLoadFailedModal: () => null,
}));
vi.mock('@app/features/channel/components/modals/channel_tabs/channel_overview_tab/ChannelOverviewTopicEditor', () => ({
	ChannelOverviewTopicEditor: () => null,
}));
vi.mock('@app/features/channel/components/modals/channel_tabs/channel_overview_tab/RtcRegionSelect', () => ({
	RtcRegionSelect: () => null,
}));
vi.mock('@app/features/channel/components/modals/channel_tabs/channel_overview_tab/SlowmodeControl', () => ({
	SlowmodeControl: () => null,
}));
vi.mock('@app/features/ui/components/Slider', () => ({
	Slider: () => null,
	RESET_SLIDER_TO_DEFAULT_VALUE_DESCRIPTOR: {message: 'Reset'},
}));
vi.mock('@app/features/ui/components/form/FormInput', () => ({
	Input: (props: Record<string, unknown>) => createElement('input', {'aria-label': props.label}),
	Textarea: (props: Record<string, unknown>) => createElement('textarea', {'aria-label': props.label}),
}));
vi.mock('@app/features/ui/components/form/FormSwitch', () => ({
	Switch: ({label}: {label: string}) => createElement('input', {type: 'checkbox', 'aria-label': label}),
}));
vi.mock('@app/features/user/components/modals/tabs/components/CompactComboboxRow', () => ({
	CompactComboboxRow: ({label}: {label: string}) => createElement('select', {'aria-label': label}),
}));

// Idle and LocalPresence import each other; loading Idle first keeps its timer from calling a half-loaded store.
await import('@app/features/ui/state/Idle');
const {Channel} = await import('@app/features/channel/models/Channel');
const {default: ChannelOverviewTab} = await import(
	'@app/features/channel/components/modals/channel_tabs/ChannelOverviewTab'
);

function voiceChannel(overrides: Partial<WireChannel> = {}): WireChannel {
	return {id: '200', guild_id: '100', type: ChannelTypes.GUILD_VOICE, name: 'lounge', ...overrides};
}

describe('channel mature content settings', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		state.limits = {};
		state.guildNsfw = false;
		state.channel = new Channel(voiceChannel());
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	async function renderTab() {
		await act(async () => root.render(createElement(ChannelOverviewTab, {channelId: '200'})));
	}
	const matureSelect = () => container.querySelector('select[aria-label="Mature content"]');
	const warningSwitch = () => container.querySelector('input[aria-label="Show a content warning in this channel"]');

	it('draws neither control while feature_mature_content_settings is off', async () => {
		await renderTab();
		expect(container.querySelector('input[aria-label="Channel name"]')).not.toBeNull();
		expect(matureSelect()).toBeNull();
		expect(warningSwitch()).toBeNull();
	});

	it('draws both controls while feature_mature_content_settings is on', async () => {
		state.limits.feature_mature_content_settings = 1;
		await renderTab();
		expect(matureSelect()).not.toBeNull();
		expect(warningSwitch()).not.toBeNull();
	});

	it('still draws them for a channel marked for mature content, so a moderator can turn it off', async () => {
		state.channel = new Channel(voiceChannel({nsfw_override: true}));
		await renderTab();
		expect(matureSelect()).not.toBeNull();
		expect(warningSwitch()).not.toBeNull();
	});

	it('still draws them in a community marked for mature content, so a channel can opt out', async () => {
		state.guildNsfw = true;
		await renderTab();
		expect(matureSelect()).not.toBeNull();
	});

	it('still draws them for a channel with a content warning', async () => {
		state.channel = new Channel(voiceChannel({content_warning_level: ContentWarningLevel.CONTENT_WARNING}));
		await renderTab();
		expect(matureSelect()).not.toBeNull();
		expect(warningSwitch()).not.toBeNull();
	});
});

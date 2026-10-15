// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {VOICE_ROOM_THEME_IDS} from '@fluxer/constants/src/VoiceRoomThemes';
import type {Channel as WireChannel} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	rooms: false,
	defaultTheme: null as string | null,
	channel: null as unknown,
	tabData: null as {onSave: () => Promise<void>} | null,
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
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {localInstanceDomain: 'fluxer.test', getSnapshotOrNull: () => null},
}));
vi.mock('@app/features/user/state/Users', () => ({default: {getUser: () => undefined, cacheUsers: () => {}}}));
vi.mock('@app/features/user/state/UserPinnedDM', () => ({default: {pinnedDMs: []}}));
vi.mock('@app/features/theme/fonts/ScriptFontLoader', () => ({noteText: () => {}}));
vi.mock('@app/features/experiment/state/ExperimentAssignments', () => ({
	default: {
		get response() {
			return {assignments: {voice_room: {rooms: state.rooms, games: false, default_room_theme: state.defaultTheme}}};
		},
	},
}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {getChannel: () => state.channel}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {getGuild: () => ({features: []})}}));
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
	setTabData: vi.fn((_tab: string, data: {onSave: () => Promise<void>}) => {
		state.tabData = data;
	}),
}));
vi.mock('@app/features/app/hooks/useFormSubmit', () => ({
	useFormSubmit: ({
		form,
		onSubmit,
	}: {
		form: {handleSubmit: (fn: unknown) => () => Promise<void>};
		onSubmit: unknown;
	}) => ({
		handleSubmit: () => form.handleSubmit(onSubmit)(),
		isSubmitting: false,
	}),
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
vi.mock('@app/features/channel/components/modals/channel_tabs/channel_overview_tab/MatureContentSection', () => ({
	MatureContentSection: () => null,
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
	Input: (props: Record<string, unknown>) => createElement('input', {...props, 'aria-label': props.label}),
}));
vi.mock('@app/features/user/components/modals/tabs/components/CompactComboboxRow', () => ({
	CompactComboboxRow: ({
		label,
		value,
		options,
		onChange,
	}: {
		label: string;
		value: string | null;
		options: ReadonlyArray<{value: string | null; label: string}>;
		onChange: (value: string | null) => void;
	}) =>
		createElement(
			'select',
			{
				'aria-label': label,
				value: value ?? '',
				onChange: (event: {target: {value: string}}) => onChange(event.target.value === '' ? null : event.target.value),
			},
			options.map((option) =>
				createElement('option', {key: option.value ?? '', value: option.value ?? ''}, option.label),
			),
		),
}));

// Idle and LocalPresence import each other; loading Idle first keeps its timer from calling a half-loaded store.
await import('@app/features/ui/state/Idle');
const {Channel} = await import('@app/features/channel/models/Channel');
const ChannelCommands = await import('@app/features/channel/commands/ChannelCommands');
const {default: ChannelOverviewTab} = await import(
	'@app/features/channel/components/modals/channel_tabs/ChannelOverviewTab'
);

const THEME_LABELS: Record<string, string> = {
	'gece-lounge': 'Night Lounge',
	kahvehane: 'Coffeehouse',
	'oyun-odasi': 'Game Room',
	'neon-salon': 'Neon Salon',
	'mor-sehir': 'Mor Şehir',
	'mahalle-kahvesi': 'Mahalle Kahvesi',
	'yonetim-ofisi': 'Yönetim Ofisi',
};
const THEME = VOICE_ROOM_THEME_IDS[0];

function voiceChannel(overrides: Partial<WireChannel> = {}): WireChannel {
	return {id: '200', guild_id: '100', type: ChannelTypes.GUILD_VOICE, name: 'lounge', ...overrides};
}

describe('voice channel room theme setting', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		state.rooms = true;
		state.defaultTheme = null;
		state.channel = new Channel(voiceChannel({room_theme: THEME}));
		state.tabData = null;
		vi.mocked(ChannelCommands.update).mockClear();
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
	const themeSelect = () => container.querySelector<HTMLSelectElement>('select[aria-label="Room theme"]');
	function changeValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
		const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
		element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', {bubbles: true}));
	}
	async function save() {
		await act(async () => state.tabData!.onSave());
	}

	it('theme select hidden while voice_room.rooms is off', async () => {
		state.rooms = false;
		await renderTab();
		expect(container.querySelector('input[aria-label="Channel name"]')).not.toBeNull();
		expect(themeSelect()).toBeNull();
	});

	it('shows default, none and themes from the manifest', async () => {
		await renderTab();
		const select = themeSelect();
		expect(select).not.toBeNull();
		expect(Array.from(select!.options).map((option) => option.value)).toEqual(['', 'none', ...VOICE_ROOM_THEME_IDS]);
		expect(Array.from(select!.options).map((option) => option.textContent)).toEqual([
			'Default (Disabled)',
			'None',
			...VOICE_ROOM_THEME_IDS.map((id) => THEME_LABELS[id]),
		]);
		expect(select!.value).toBe(THEME);
	});

	it('saving name only does not send room_theme', async () => {
		await renderTab();
		await act(async () => changeValue(container.querySelector('input[aria-label="Channel name"]')!, 'renamed'));
		await save();
		expect(ChannelCommands.update).toHaveBeenCalledTimes(1);
		const body = vi.mocked(ChannelCommands.update).mock.calls[0]![1] as Record<string, unknown>;
		expect(body.name).toBe('renamed');
		expect(body).not.toHaveProperty('room_theme');
	});

	it('choosing default sends null', async () => {
		await renderTab();
		await act(async () => changeValue(themeSelect()!, ''));
		await save();
		expect(ChannelCommands.update).toHaveBeenCalledWith('200', expect.objectContaining({room_theme: null}));
	});

	it('labels the default with its current room name', async () => {
		state.defaultTheme = 'kahvehane';
		await renderTab();
		expect(themeSelect()!.options[0].textContent).toBe('Default (Coffeehouse)');
	});

	it('choosing none sends the explicit flat override', async () => {
		await renderTab();
		await act(async () => changeValue(themeSelect()!, 'none'));
		await save();
		expect(ChannelCommands.update).toHaveBeenCalledWith('200', expect.objectContaining({room_theme: 'none'}));
	});

	it('choosing a theme sends its id', async () => {
		state.channel = new Channel(voiceChannel());
		await renderTab();
		expect(themeSelect()!.value).toBe('');
		await act(async () => changeValue(themeSelect()!, THEME));
		await save();
		expect(ChannelCommands.update).toHaveBeenCalledWith('200', expect.objectContaining({room_theme: THEME}));
	});

	it('channel record keeps room_theme through partial updates and sees a theme-only change', () => {
		const themed = new Channel(voiceChannel({room_theme: THEME}));
		expect(themed.roomTheme).toBe(THEME);
		expect(themed.toJSON().room_theme).toBe(THEME);
		expect(themed.withUpdates({name: 'renamed'}).roomTheme).toBe(THEME);
		const cleared = themed.withUpdates({room_theme: null});
		expect(cleared.roomTheme).toBeNull();
		expect(cleared.equals(themed)).toBe(false);
	});
});

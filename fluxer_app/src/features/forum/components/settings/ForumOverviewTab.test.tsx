// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {ContentWarningLevel} from '@fluxer/constants/src/GuildConstants';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	limits: {} as Record<string, number>,
	channel: null as unknown,
}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {locale: 'en', _: (descriptor: {message: string}) => descriptor.message}}),
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
vi.mock('@app/features/channel/state/Channels', () => ({default: {getChannel: () => state.channel}}));
vi.mock('@app/features/guild/state/Guilds', () => ({
	default: {
		getGuild: () => ({nsfw: false, contentWarningLevel: ContentWarningLevel.INHERIT, contentWarningText: null}),
	},
}));
vi.mock('@app/features/threads/state/ThreadGuilds', () => ({default: {isActive: () => true}}));
vi.mock('@app/features/permissions/state/Permission', () => ({default: {can: () => true}}));
vi.mock('@app/features/channel/components/modals/channel_tabs/ChannelOverviewTab', () => ({default: () => null}));
vi.mock('@app/features/forum/commands/ForumCommands', () => ({updateForumChannel: vi.fn(async () => undefined)}));
vi.mock('@app/features/forum/components/settings/ForumTagSettings', () => ({ForumTagSettings: () => null}));
vi.mock('@app/features/emoji/components/popouts/EmojiPickerPopout', () => ({EmojiPickerPopout: () => null}));
vi.mock('@app/features/ui/popover/PopoverPopout', () => ({Popout: () => null}));
vi.mock('@app/features/threads/components/ThreadDefaultsSection', () => ({ThreadDefaultsSection: () => null}));
vi.mock('@app/features/channel/components/modals/channel_tabs/channel_overview_tab/SlowmodeControl', () => ({
	SlowmodeControl: () => null,
}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({createToast: vi.fn()}));
vi.mock('@app/features/ui/commands/UnsavedChangesCommands', () => ({
	setUnsavedChanges: vi.fn(),
	clearUnsavedChanges: vi.fn(),
	setTabData: vi.fn(),
}));
vi.mock('@app/features/app/hooks/useFormSubmit', () => ({
	useFormSubmit: () => ({handleSubmit: async () => undefined, isSubmitting: false}),
}));
vi.mock('@app/features/ui/radio_group/RadioGroup', () => ({RadioGroup: () => null}));
vi.mock('@app/features/ui/components/form/FormInput', () => ({
	Input: ({label}: {label: string}) => createElement('input', {'aria-label': label}),
	Textarea: ({label}: {label: string}) => createElement('textarea', {'aria-label': label}),
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
const {ChannelOverviewTabForType} = await import('@app/features/forum/components/settings/ForumOverviewTab');

describe('forum mature content settings', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		state.limits = {};
		state.channel = new Channel({id: '300', guild_id: '100', type: ChannelTypes.GUILD_FORUM, name: 'ideas'});
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	async function renderTab() {
		await act(async () => root.render(createElement(ChannelOverviewTabForType, {channelId: '300'})));
	}
	const matureSelect = () => container.querySelector('select[aria-label="Mature content"]');
	const warningSwitch = () => container.querySelector('input[aria-label="Show a content warning in this channel"]');

	it('draws no mature content or content warning control while feature_mature_content_settings is off', async () => {
		await renderTab();
		expect(container.querySelector('input[aria-label="Channel name"]')).not.toBeNull();
		expect(matureSelect()).toBeNull();
		expect(warningSwitch()).toBeNull();
	});

	it('draws both while feature_mature_content_settings is on', async () => {
		state.limits.feature_mature_content_settings = 1;
		await renderTab();
		expect(matureSelect()).not.toBeNull();
		expect(warningSwitch()).not.toBeNull();
	});
});

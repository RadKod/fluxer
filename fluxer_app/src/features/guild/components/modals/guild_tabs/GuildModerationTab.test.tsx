// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	ContentWarningLevel,
	GuildExplicitContentFilterTypes,
	GuildMFALevel,
	GuildVerificationLevel,
} from '@fluxer/constants/src/GuildConstants';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	limits: {} as Record<string, number>,
	guild: null as unknown,
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
	default: {usesUsernameSignIn: false, localInstanceDomain: 'fluxer.test', getSnapshotOrNull: () => null},
}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {getGuild: () => state.guild}}));
vi.mock('@app/features/user/state/Users', () => ({default: {currentUser: {id: '1', mfaEnabled: false}}}));
vi.mock('@app/features/permissions/state/Permission', () => ({default: {can: () => true}}));
vi.mock('@app/features/guild/commands/GuildCommands', () => ({update: vi.fn(async () => undefined)}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({createToast: vi.fn()}));
vi.mock('@app/features/ui/commands/UnsavedChangesCommands', () => ({
	setUnsavedChanges: vi.fn(),
	clearUnsavedChanges: vi.fn(),
	setTabData: vi.fn(),
}));
vi.mock('@app/features/app/hooks/useFormSubmit', () => ({
	useFormSubmit: () => ({handleSubmit: async () => undefined, isSubmitting: false}),
}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/ui/radio_group/RadioGroup', () => ({
	RadioGroup: ({'aria-label': label}: {'aria-label': string}) =>
		createElement('div', {role: 'radiogroup', 'aria-label': label}),
}));
vi.mock('@app/features/ui/components/form/FormInput', () => ({
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
const {default: GuildModerationTab} = await import(
	'@app/features/guild/components/modals/guild_tabs/GuildModerationTab'
);

function guild(overrides: Record<string, unknown> = {}) {
	return {
		id: '100',
		ownerId: '2',
		features: new Set<string>(),
		verificationLevel: GuildVerificationLevel.NONE,
		mfaLevel: GuildMFALevel.NONE,
		nsfw: false,
		contentWarningLevel: ContentWarningLevel.INHERIT,
		contentWarningText: null,
		explicitContentFilter: GuildExplicitContentFilterTypes.DISABLED,
		...overrides,
	};
}

describe('community mature content settings', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		state.limits = {};
		state.guild = guild();
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	async function renderTab() {
		await act(async () => root.render(createElement(GuildModerationTab, {guildId: '100'})));
	}
	const matureSelect = () => container.querySelector('select[aria-label="Mature content"]');
	const warningSwitch = () => container.querySelector('input[aria-label="Show a content warning"]');
	const explicitFilter = () => container.querySelector('[aria-label="Explicit content filter setting"]');

	it('draws neither control while feature_mature_content_settings is off, and keeps the explicit content filter', async () => {
		await renderTab();
		expect(container.textContent).not.toContain('Mature content & content warnings');
		expect(matureSelect()).toBeNull();
		expect(warningSwitch()).toBeNull();
		expect(explicitFilter()).not.toBeNull();
	});

	it('draws the section while feature_mature_content_settings is on', async () => {
		state.limits.feature_mature_content_settings = 1;
		await renderTab();
		expect(container.textContent).toContain('Mature content & content warnings');
		expect(matureSelect()).not.toBeNull();
		expect(warningSwitch()).not.toBeNull();
	});

	it('still draws it for a community marked for mature content, so it can be turned off', async () => {
		state.guild = guild({nsfw: true});
		await renderTab();
		expect(matureSelect()).not.toBeNull();
		expect(warningSwitch()).not.toBeNull();
	});

	it('still draws it for a community with a content warning', async () => {
		state.guild = guild({contentWarningLevel: ContentWarningLevel.CONTENT_WARNING});
		await renderTab();
		expect(matureSelect()).not.toBeNull();
		expect(warningSwitch()).not.toBeNull();
	});
});

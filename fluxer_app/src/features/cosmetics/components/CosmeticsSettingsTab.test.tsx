// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {User} from '@app/features/user/models/User';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {UserPrivate} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

function interpolate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	return descriptor.message.replace(/{(\w+)}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: interpolate}}),
	Trans: ({children}: {children: React.ReactNode}) => children,
}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/cosmetics/commands/CosmeticCommands', () => ({
	fetchCatalog: vi.fn(),
	fetchUserCosmetics: vi.fn(),
	equip: vi.fn(),
}));
vi.mock('@app/features/user/commands/UserProfileCommands', () => ({clearCurrentUserProfiles: vi.fn()}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {userId: 'me', currentUserId: 'me'}}));
vi.mock('@app/features/platform/state/AuthSession', () => ({
	default: {currentAccountKey: 'micup-test-account', userId: 'me'},
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {localInstanceDomain: 'micup.test', mediaEndpoint: 'https://media.micup.test'},
}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => -1}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {useReducedMotion: false}}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {}}));
vi.mock('@app/features/premium/utils/PremiumUtils', () => ({shouldShowPremiumFeatures: vi.fn()}));
vi.mock('@app/features/platform/utils/ComponentBus', () => ({ComponentBus: {dispatch: vi.fn()}}));
vi.mock('@app/features/ui/commands/UnsavedChangesCommands', () => ({
	setUnsavedChanges: vi.fn(),
	setTabData: vi.fn(),
	clearUnsavedChanges: vi.fn(),
}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({createToast: vi.fn()}));
// Settings chrome, the avatar and the profile card have their own tests; here they only need to show what they get.
const previews: Array<{user: User; previewProfileEffect: unknown}> = [];
vi.mock('@app/features/user/components/profile/ProfilePreview', () => ({
	ProfilePreview: (props: {user: User; previewProfileEffect: unknown}) => {
		previews.push(props);
		return null;
	},
}));
vi.mock('@app/features/ui/components/Avatar', () => ({Avatar: () => null}));
vi.mock('@app/features/app/components/dialogs/shared/SettingsSection', () => ({
	SettingsSection: ({title, children}: {title: React.ReactNode; children: React.ReactNode}) =>
		createElement('section', null, createElement('h2', null, title), children),
}));
vi.mock('@app/features/app/components/dialogs/shared/SettingsTabLayout', () => ({
	SettingsTabContainer: ({children}: {children: React.ReactNode}) => children,
	SettingsTabContent: ({children}: {children: React.ReactNode}) => children,
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick, ...rest}: {children: React.ReactNode; onClick: () => void; 'data-flx': string}) =>
		createElement('button', {type: 'button', onClick, 'data-flx': rest['data-flx']}, children),
}));

const CosmeticCommands = await import('@app/features/cosmetics/commands/CosmeticCommands');
const {shouldShowPremiumFeatures} = await import('@app/features/premium/utils/PremiumUtils');
const {ComponentBus} = await import('@app/features/platform/utils/ComponentBus');
const UnsavedChangesCommands = await import('@app/features/ui/commands/UnsavedChangesCommands');
const {default: Users} = await import('@app/features/user/state/Users');
const {default: CosmeticsSettingsTab} = await import('@app/features/cosmetics/components/CosmeticsSettingsTab');

function item(
	id: string,
	type: CosmeticItemResponse['type'],
	availability: CosmeticItemResponse['availability'],
	name: string,
): CosmeticItemResponse {
	return {id, type, name, description: null, asset: `hash${id}`, availability};
}

const CATALOG = [
	item('11', 'avatar_decoration', 'free', 'Yaprak'),
	item('12', 'avatar_decoration', 'premium', 'Alev'),
	item('41', 'avatar_ultra', 'free', 'Yitik Melek'),
	item('21', 'nameplate', 'free', 'Gece'),
	item('31', 'profile_effect', 'free', 'Kar'),
];

function me(extra: Partial<UserPrivate> = {}): UserPrivate {
	return {
		id: 'me',
		username: 'ayse',
		discriminator: '0001',
		global_name: null,
		avatar: null,
		avatar_color: null,
		flags: 0,
		email: 'ayse@micup.test',
		...extra,
	} as UserPrivate;
}

async function settle(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
	});
}

describe('CosmeticsSettingsTab', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(async () => {
		vi.clearAllMocks();
		previews.length = 0;
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		Users.handleGatewayReady('micup-test-account', me({avatar_decoration_data: {asset: 'hash11', item_id: '11'}}));
		vi.mocked(CosmeticCommands.fetchCatalog).mockResolvedValue(CATALOG);
		vi.mocked(CosmeticCommands.fetchUserCosmetics).mockResolvedValue({
			owned: [],
			equipped: {avatar_decoration_id: '11', avatar_ultra_id: null, profile_effect_id: null, nameplate_id: null},
		});
		vi.mocked(CosmeticCommands.equip).mockResolvedValue({
			avatar_decoration_id: '11',
			avatar_ultra_id: null,
			profile_effect_id: '31',
			nameplate_id: null,
		});
		vi.mocked(shouldShowPremiumFeatures).mockReturnValue(true);
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
		act(() => root.render(createElement(CosmeticsSettingsTab)));
		await settle();
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const tile = (label: string) =>
		[...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
			(button) => button.getAttribute('aria-label') === label,
		);
	const click = (element: HTMLElement | undefined | null) => act(() => element?.click());
	const lastPreview = () => previews.at(-1)!;
	const lastTabData = () => vi.mocked(UnsavedChangesCommands.setTabData).mock.calls.at(-1)![1];

	it('offers "None" and every catalog item per type, with the worn frame pressed', () => {
		expect(tile('Yaprak')?.getAttribute('aria-pressed')).toBe('true');
		expect(tile('Alev')?.getAttribute('aria-pressed')).toBe('false');
		// sanalyer: ultra decorations are not offered, so the catalog's ultra item has no tile and no section.
		expect(tile('Yitik Melek')).toBeUndefined();
		expect(tile('Gece')).toBeDefined();
		expect(tile('Kar')).toBeDefined();
		expect(container.querySelectorAll('button[aria-label="None"]').length).toBe(3);
	});

	it('previews a picked effect and saves only the changed slot through the unsaved changes bar', async () => {
		click(tile('Kar'));
		expect(tile('Kar')?.getAttribute('aria-pressed')).toBe('true');
		expect(lastPreview().previewProfileEffect).toEqual({asset: 'hash31', item_id: '31'});
		expect(UnsavedChangesCommands.setUnsavedChanges).toHaveBeenLastCalledWith('profile_cosmetics', true);

		await act(async () => {
			await lastTabData().onSave?.();
		});
		expect(CosmeticCommands.equip).toHaveBeenCalledWith({profile_effect_id: '31'});
		expect(UnsavedChangesCommands.setUnsavedChanges).toHaveBeenLastCalledWith('profile_cosmetics', false);
	});

	it('previews a frame being taken off and resets back to the worn one', () => {
		click(container.querySelector<HTMLButtonElement>('button[aria-label="None"]'));
		expect(lastPreview().user.avatarDecoration).toBeNull();
		act(() => lastTabData().onReset?.());
		expect(lastPreview().user.avatarDecoration).toEqual({asset: 'hash11', item_id: '11'});
		expect(UnsavedChangesCommands.setUnsavedChanges).toHaveBeenLastCalledWith('profile_cosmetics', false);
	});

	it('locks a premium frame for an account without premium and points to the premium tab', () => {
		expect(tile('Alev')?.querySelector('[data-flx="cosmetics.cosmetics-settings-tab.lock-badge"]')).not.toBeNull();
		click(tile('Alev'));
		expect(tile('Alev')?.getAttribute('aria-pressed')).toBe('false');
		expect(UnsavedChangesCommands.setUnsavedChanges).not.toHaveBeenCalledWith('profile_cosmetics', true);
		expect(container.textContent).toContain('Alev comes with sanalyer Plus.');

		click(
			container.querySelector<HTMLButtonElement>('[data-flx="cosmetics.cosmetics-settings-tab.button.get-premium"]'),
		);
		expect(ComponentBus.dispatch).toHaveBeenCalledWith('USER_SETTINGS_TAB_SELECT', {tab: 'plutonium'});
	});

	it('only explains the lock where the premium tab is not offered', () => {
		vi.mocked(shouldShowPremiumFeatures).mockReturnValue(false);
		click(tile('Alev'));
		expect(container.textContent).toContain('Alev comes with sanalyer Plus.');
		expect(container.querySelector('[data-flx="cosmetics.cosmetics-settings-tab.button.get-premium"]')).toBeNull();
	});
});

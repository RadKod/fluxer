// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({premiumPage: true, shopPage: true}));
const modalCommands = vi.hoisted(() => ({pop: vi.fn(), popAll: vi.fn()}));
const routerUtils = vi.hoisted(() => ({transitionTo: vi.fn()}));
const unsaved = vi.hoisted(() => ({unsavedChanges: {} as Record<string, boolean>, triggerFlashEffect: vi.fn()}));
const bus = vi.hoisted(() => {
	const listeners = new Set<(args?: unknown) => void>();
	return {
		subscribe: (_type: string, listener: (args?: unknown) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit: (args: unknown) => {
			for (const listener of listeners) listener(args);
		},
	};
});

const passThrough = ({children}: {children?: React.ReactNode}) => children ?? null;

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message, locale: 'en'}}),
}));
vi.mock('@app/features/app/components/dialogs/components/DesktopSettingsView', () => ({
	DesktopSettingsView: ({selectedTab}: {selectedTab: string}) =>
		createElement('div', {'data-testid': 'settings', 'data-tab': selectedTab}),
}));
vi.mock('@app/features/app/components/dialogs/components/MobileSettingsView', () => ({MobileSettingsView: () => null}));
vi.mock('@app/features/app/components/dialogs/Modal', () => ({Root: passThrough, ScreenReaderLabel: () => null}));
vi.mock('@app/features/app/components/dialogs/shared/SettingsModalLayout', () => ({
	SettingsModalContainer: passThrough,
}));
vi.mock('@app/features/platform/utils/ComponentBus', () => ({ComponentBus: bus}));
vi.mock('@app/features/ui/commands/ModalCommands', () => modalCommands);
vi.mock('@app/features/ui/commands/UnsavedChangesCommands', () => ({triggerFlashEffect: unsaved.triggerFlashEffect}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {enabled: false, isMobileLayout: () => false}}));
vi.mock('@app/features/ui/state/UnsavedChanges', () => ({default: unsaved}));
vi.mock('@app/features/ui/utils/MobileExperience', () => ({isMobileExperienceEnabled: () => false}));
vi.mock('@app/features/user/components/settings_utils/SettingsConstants', () => ({
	USER_SETTINGS_LABEL_DESCRIPTOR: {message: 'User settings'},
	getSettingsTabs: () => [
		{type: 'my_profile', category: 'user_settings', label: 'My profile'},
		{type: 'profile_cosmetics', category: 'user_settings', label: 'Cosmetics'},
		{type: 'appearance', category: 'app_settings', label: 'Look and feel'},
	],
}));
vi.mock('@app/features/user/components/settings_utils/SettingsNavigationGroups', () => ({
	ACCOUNT_SETTINGS_TAB: 'account_security',
	getAccountSectionForLegacySection: () => null,
	getAccountSectionForNestedTab: () => null,
}));
vi.mock('@app/features/user/hooks/useMobileNavigation', () => ({
	useMobileNavigation: () => ({isRootView: true, currentView: null, navigateTo: vi.fn(), navigateBack: vi.fn()}),
}));
vi.mock('@app/features/user/hooks/useSettingsContentKey', () => ({SettingsContentKeyProvider: passThrough}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {developerMode: false}}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {isSelfHosted: () => true, getSnapshotOrNull: () => null},
}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => routerUtils);
vi.mock('@app/features/premium/commands/PlutoniumPageCommands', () => ({openPlutoniumPage: vi.fn()}));
vi.mock('@app/features/premium/state/PlutoniumPageRollout', () => ({default: {enabled: false}}));
vi.mock('@app/features/premium/utils/PremiumUtils', () => ({isPremiumPageAvailable: () => state.premiumPage}));
vi.mock('@app/features/shop/utils/ShopAvailability', () => ({isShopPageAvailable: () => state.shopPage}));

const {UserSettingsModal} = await import('@app/features/user/components/modals/UserSettingsModal');

// Micup: premium and the shop left the settings for their own pages; the old tab ids still reach the modal (settings
// links, `initialTab`, USER_SETTINGS_TAB_SELECT) and open the page instead of an empty tab.
describe('UserSettingsModal old premium and shop tabs', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		Object.assign(state, {premiumPage: true, shopPage: true});
		modalCommands.popAll.mockClear();
		routerUtils.transitionTo.mockClear();
		unsaved.unsavedChanges = {};
		unsaved.triggerFlashEffect.mockClear();
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = (initialTab?: string) =>
		act(() => root.render(createElement(UserSettingsModal, {initialTab: initialTab as never})));
	const settings = () => container.querySelector('[data-testid="settings"]');

	it('opening the old shop tab closes the dialogs and goes to the shop page', () => {
		render('shop');
		expect(modalCommands.popAll).toHaveBeenCalled();
		expect(routerUtils.transitionTo).toHaveBeenCalledWith('/shop');
		expect(settings()).toBeNull();
	});

	it('opening the old premium tab goes to the premium page', () => {
		render('plutonium');
		expect(modalCommands.popAll).toHaveBeenCalled();
		expect(routerUtils.transitionTo).toHaveBeenCalledWith('/premium');
	});

	it('a tab switch to the old ids from inside the settings opens the pages', () => {
		render('appearance');
		expect(settings()?.getAttribute('data-tab')).toBe('appearance');
		act(() => bus.emit({tab: 'shop'}));
		expect(routerUtils.transitionTo).toHaveBeenLastCalledWith('/shop');
		act(() => bus.emit({tab: 'plutonium'}));
		expect(routerUtils.transitionTo).toHaveBeenLastCalledWith('/premium');
		expect(modalCommands.popAll).toHaveBeenCalledTimes(2);
	});

	// The cosmetics tab's premium link comes this way: its unsaved picks keep the settings open (the close guard).
	it('a tab switch to the old ids keeps the settings open while a tab has unsaved changes', () => {
		render('appearance');
		unsaved.unsavedChanges = {profile_cosmetics: true};
		act(() => bus.emit({tab: 'plutonium'}));
		act(() => bus.emit({tab: 'shop'}));
		expect(modalCommands.popAll).not.toHaveBeenCalled();
		expect(routerUtils.transitionTo).not.toHaveBeenCalled();
		expect(unsaved.triggerFlashEffect).toHaveBeenCalledWith('profile_cosmetics');
		expect(settings()?.getAttribute('data-tab')).toBe('appearance');
	});

	// useWebhookUpdates (guild and channel settings) never clears its entry: a dialog closed from outside leaves `true`
	// behind. It is not a tab of these settings, so the links still open the pages.
	it('an unsaved entry left by a closed dialog does not hold the old ids', () => {
		render('appearance');
		unsaved.unsavedChanges = {webhooks: true};
		act(() => bus.emit({tab: 'plutonium'}));
		expect(routerUtils.transitionTo).toHaveBeenLastCalledWith('/premium');
		act(() => bus.emit({tab: 'shop'}));
		expect(routerUtils.transitionTo).toHaveBeenLastCalledWith('/shop');
		expect(modalCommands.popAll).toHaveBeenCalledTimes(2);
		expect(unsaved.triggerFlashEffect).not.toHaveBeenCalled();
	});

	it('without the pages the old ids fall back to the first tab as before', () => {
		Object.assign(state, {premiumPage: false, shopPage: false});
		render('shop');
		expect(routerUtils.transitionTo).not.toHaveBeenCalled();
		expect(modalCommands.popAll).not.toHaveBeenCalled();
		expect(settings()?.getAttribute('data-tab')).toBe('my_profile');
	});
});

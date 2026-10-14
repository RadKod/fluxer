// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	windows: true,
	pinState: {supported: true, pinned: false, lafRequired: false},
	request: vi.fn(async () => false),
}));
vi.mock('@app/features/platform/utils/MobXPersistence', () => ({makePersistent: async () => {}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		warn() {}
	},
}));
vi.mock('@app/features/ui/utils/NativeUtils', () => ({
	isNativeWindows: () => state.windows,
	isNativeMacOS: () => false,
	isNativeLinux: () => false,
	getNativePlatformSync: () => 'win32',
	isDesktop: () => true,
	getElectronAPI: () => ({getTaskbarPinState: async () => state.pinState, requestTaskbarPin: state.request}),
}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	Trans: ({children}: {children: ReactNode}) => children,
	useLingui: () => ({
		i18n: {
			_: (descriptor: {message: string}, values?: Record<string, string>) =>
				descriptor.message.replace(/\{(\w+)\}/g, (_match, key: string) => values?.[key] ?? ''),
		},
	}),
}));
vi.mock('@app/features/app/config/I18nDisplayConstants', () => ({PRODUCT_NAME: 'Micup'}));
vi.mock('@app/features/app/components/layout/Nagbar', () => ({
	Nagbar: ({children, onDismiss}: {children: ReactNode; onDismiss: () => void}) =>
		createElement('div', null, children, createElement('button', {type: 'button', onClick: onDismiss}, 'Dismiss')),
}));
vi.mock('@app/features/app/components/layout/NagbarContent', () => ({
	NagbarContent: ({message, actions}: {message: ReactNode; actions: ReactNode}) =>
		createElement('div', null, message, actions),
}));
vi.mock('@app/features/app/components/layout/NagbarButton', () => ({
	NagbarButton: ({children, onClick}: {children: ReactNode; onClick: () => void}) =>
		createElement('button', {type: 'button', onClick}, children),
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick}: {children: ReactNode; onClick: () => void}) =>
		createElement('button', {type: 'button', onClick}, children),
}));
vi.mock('@app/features/app/components/dialogs/shared/SettingsSection', () => ({
	SettingsSection: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/app/components/dialogs/shared/SettingsTabLayout', () => ({
	SettingsTabContainer: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/app/components/dialogs/ConfirmModal', () => ({ConfirmModal: () => null}));
vi.mock('@app/features/permissions/system/components/MacPermissionsSettingsRow', () => ({
	MacPermissionsSettingsRow: () => null,
}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({modal: vi.fn(), push: vi.fn()}));
vi.mock('@app/features/ui/components/form/FormSwitch', () => ({Switch: () => null}));
vi.mock('@app/features/platform/utils/Autostart', () => ({
	getCachedAutostartStatus: () => true,
	getAutostartStatus: async () => true,
	setAutostartEnabled: vi.fn(),
}));
vi.mock('@app/features/ui/utils/DesktopWindowBehaviorUtils', () => ({
	getCachedDesktopWindowBehaviorSettings: () => ({}),
	getDesktopWindowBehaviorPendingRestart: async () => false,
	getDesktopWindowBehaviorSettings: async () => ({}),
	relaunchDesktopApp: vi.fn(),
	setDesktopWindowBehaviorSettings: vi.fn(),
}));

const {default: store} = await import('@app/features/platform/state/TaskbarPin');
const {default: DesktopSettingsTab} = await import('@app/features/user/components/modals/tabs/DesktopSettingsTab');
const {TaskbarPinNagbar} = await import('@app/features/app/components/layout/app_layout/nagbars/TaskbarPinNagbar');
let root: Root;
let host: HTMLDivElement;
const button = (text: string) => [...host.querySelectorAll('button')].find((element) => element.textContent === text);
beforeEach(async () => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	state.windows = true;
	state.pinState = {supported: true, pinned: false, lafRequired: false};
	state.request.mockClear();
	store.dismissed = false;
	store.attempted = false;
	await store.refresh();
	host = document.createElement('div');
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
});
it('requests only after the nagbar Pin click and closes after a refusal', async () => {
	await act(async () => root.render(createElement(TaskbarPinNagbar, {isMobile: false})));
	expect(host.textContent).toContain('Pin Micup to your taskbar');
	expect(state.request).not.toHaveBeenCalled();
	await act(async () => button('Pin')!.click());
	expect(state.request).toHaveBeenCalledTimes(1);
	expect(store.dismissed).toBe(true);
	expect(store.canOffer).toBe(false);
});
it('dismissing never requests a pin and leaves Settings available', async () => {
	await act(async () => root.render(createElement(TaskbarPinNagbar, {isMobile: false})));
	await act(async () => button('Dismiss')!.click());
	expect(state.request).not.toHaveBeenCalled();
	expect(store.dismissed).toBe(true);
	await act(async () => root.render(createElement(DesktopSettingsTab)));
	expect(button('Pin to taskbar')).toBeDefined();
	await act(async () => button('Pin to taskbar')!.click());
	expect(state.request).toHaveBeenCalledTimes(1);
	expect(button('Pin to taskbar')).toBeUndefined();
});
it.each([
	{supported: false, pinned: false, lafRequired: false},
	{supported: true, pinned: true, lafRequired: false},
	{supported: true, pinned: false, lafRequired: true},
])('hides the Settings button when pinning is unavailable: %j', async (pinState) => {
	state.pinState = pinState;
	await store.refresh();
	await act(async () => root.render(createElement(DesktopSettingsTab)));
	expect(button('Pin to taskbar')).toBeUndefined();
	expect(state.request).not.toHaveBeenCalled();
});

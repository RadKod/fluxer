// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const i18n = {
	_: (descriptor: {message: string}, values?: Record<string, string>) =>
		descriptor.message.replace(/\{(\w+)\}/g, (_match, key: string) => values?.[key] ?? `{${key}}`),
	locale: 'en-US',
};

const shortcuts = vi.hoisted(() => ({
	hookError: null as 'permission' | 'start-failed' | null,
	hooksActive: false,
}));
const permissions = vi.hoisted(() => ({
	isNativeMacDesktop: true,
	isHydrated: true,
	statuses: {'input-monitoring': 'granted'} as Record<string, string>,
}));
const openMacPermissionsModal = vi.hoisted(() => vi.fn());

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n})}));
vi.mock('mobx-react-lite', () => ({observer: <T,>(component: T) => component}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {productName: 'sanalyer'}}));
vi.mock('@app/features/input/state/GlobalShortcuts', () => ({default: shortcuts}));
vi.mock('@app/features/permissions/system/state/MacPermissions', () => ({default: permissions}));
vi.mock('@app/features/permissions/system/commands/MacPermissionsModalCommands', () => ({openMacPermissionsModal}));
vi.mock('@app/features/permissions/system/components/useMacPermissionControl', () => ({
	macPermissionNameDescriptor: () => ({message: 'Input Monitoring'}),
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick}: {children: ReactNode; onClick: () => void}) =>
		createElement('button', {type: 'button', onClick}, children),
}));
vi.mock('@app/features/ui/warning_alert/WarningAlert', () => ({
	WarningAlert: ({children, actions}: {children: ReactNode; actions?: ReactNode}) =>
		createElement('div', {role: 'alert'}, children, actions),
}));

const {MacInputMonitoringShortcutsAlert, shouldShowMacInputMonitoringWarning} = await import(
	'@app/features/user/components/modals/tabs/keybinds_tab/MacInputMonitoringShortcutsAlert'
);

describe('MacInputMonitoringShortcutsAlert', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	function render(): void {
		act(() => root.render(createElement(MacInputMonitoringShortcutsAlert)));
	}

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.appendChild(container);
		root = createRoot(container);
		shortcuts.hookError = null;
		shortcuts.hooksActive = false;
		permissions.isNativeMacDesktop = true;
		permissions.isHydrated = true;
		permissions.statuses['input-monitoring'] = 'granted';
		openMacPermissionsModal.mockClear();
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it('shows the warning and a permission button when the hook reports a missing permission', () => {
		shortcuts.hookError = 'permission';
		render();
		const alert = container.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain(
			'Global shortcuts only work while sanalyer is focused until Input Monitoring is enabled.',
		);
		const button = container.querySelector('button');
		expect(button?.textContent).toBe('Enable Input Monitoring permission');
		act(() => button?.click());
		expect(openMacPermissionsModal).toHaveBeenCalledWith('input-monitoring');
	});

	it('renders nothing when the hook runs without errors', () => {
		shortcuts.hooksActive = true;
		render();
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.textContent).toBe('');
	});

	it('shows the warning before the hook was ever tried when the TCC status is not granted', () => {
		permissions.statuses['input-monitoring'] = 'not-determined';
		render();
		expect(container.querySelector('[role="alert"]')).not.toBeNull();
	});

	it('renders nothing outside the macOS desktop app', () => {
		permissions.isNativeMacDesktop = false;
		shortcuts.hookError = 'permission';
		render();
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});
});

describe('shouldShowMacInputMonitoringWarning', () => {
	const base = {
		isMacDesktop: true,
		hookError: null,
		hooksActive: false,
		permissionsHydrated: true,
		permissionStatus: 'granted',
	} as const;

	it('hides once the permission is granted and the hook is running again', () => {
		expect(shouldShowMacInputMonitoringWarning({...base, hooksActive: true})).toBe(false);
		expect(shouldShowMacInputMonitoringWarning(base)).toBe(false);
	});

	it('trusts a running hook over a stale denied status', () => {
		expect(shouldShowMacInputMonitoringWarning({...base, hooksActive: true, permissionStatus: 'denied'})).toBe(false);
	});

	it('waits for the permission store to hydrate before using the TCC status', () => {
		expect(shouldShowMacInputMonitoringWarning({...base, permissionsHydrated: false, permissionStatus: 'denied'})).toBe(
			false,
		);
	});

	it('does not treat a start failure as a permission problem', () => {
		expect(shouldShowMacInputMonitoringWarning({...base, hookError: 'start-failed'})).toBe(false);
	});
});

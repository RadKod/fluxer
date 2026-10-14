// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({level: 0, publicAllowed: true}));

const Passthrough = ({children}: {children?: ReactNode}) => createElement('div', null, children);

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	Trans: ({children}: {children: ReactNode}) => children,
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/app/components/dialogs/Modal', () => ({
	Root: Passthrough,
	Header: () => null,
	Content: Passthrough,
	ContentLayout: Passthrough,
	Description: Passthrough,
	Footer: () => null,
}));
vi.mock('@app/features/ui/warning_alert/WarningAlert', () => ({
	WarningAlert: ({children}: {children: ReactNode}) => createElement('div', {role: 'alert'}, children),
}));
vi.mock('@app/features/ui/components/form/FormSwitch', () => ({Switch: () => null}));
vi.mock('@app/features/ui/button/Button', () => ({Button: () => null}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({pop: vi.fn()}));
vi.mock('@app/features/connection/commands/ConnectionCommands', () => ({updateConnection: vi.fn()}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {getProfilePrivacy: () => state.level}}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {
		get currentUser() {
			return {publicProfileAllowed: state.publicAllowed};
		},
	},
}));

const {EditConnectionModal} = await import('@app/features/connection/components/modals/EditConnectionModal');

describe('EditConnectionModal profile visibility note (sanalyer four options)', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const connection = {type: 'github', id: '1', visibilityFlags: 1} as never;
	const render = () => act(() => root.render(createElement(EditConnectionModal, {connection})));

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	// the Everyone connection flag now means "anyone who can see the full profile".
	it.each([0, 1, 2, 101])('says only people who see the full profile see it at level %i', (level) => {
		state.level = level;
		render();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			'Only people who can see your full profile will see this connection',
		);
	});

	it('has no note while the profile is public', () => {
		state.level = ProfilePrivacyLevels.EVERYONE;
		state.publicAllowed = true;
		render();
		expect(container.querySelector('[role="alert"]')).toBeNull();
	});

	// the server reads a stored 100 as shared communities until the account may have a public profile.
	it('says so for a stored 100 while public_profile_allowed is false', () => {
		state.level = ProfilePrivacyLevels.EVERYONE;
		state.publicAllowed = false;
		render();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			'Only people who can see your full profile will see this connection',
		);
	});
});

// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const modalProps = vi.hoisted(() => ({value: null as null | Record<string, unknown>}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/user/commands/UserSettingsCommands', () => ({acknowledgeGameActivityDefault: vi.fn()}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({
	push: vi.fn((render: () => {props: Record<string, unknown>}) => {
		modalProps.value = render().props;
	}),
	modal: (render: () => unknown) => render,
}));
vi.mock('@app/features/user/components/modals/UserSettingsModal', () => ({UserSettingsModal: () => null}));
vi.mock('@app/features/app/components/shared/ExternalLink', () => ({
	ExternalLink: ({children, href}: {children: ReactNode; href: string}) => createElement('a', {href}, children),
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {privacyUrl: 'https://micup.test/privacy'}}));
vi.mock('@app/app/Routes', () => ({Routes: {privacy: () => '/privacy'}}));
vi.mock('@app/features/app/components/layout/Nagbar', () => ({
	Nagbar: ({children, onDismiss}: {children: ReactNode; onDismiss?: () => void}) =>
		createElement('div', null, createElement('button', {type: 'button', onClick: onDismiss}, 'close'), children),
}));
vi.mock('@app/features/app/components/layout/NagbarContent', () => ({
	NagbarContent: ({message, actions}: {message: ReactNode; actions?: ReactNode}) =>
		createElement('div', null, createElement('p', null, message), actions),
}));
vi.mock('@app/features/app/components/layout/NagbarButton', () => ({
	NagbarButton: ({children, onClick}: {children: ReactNode; onClick: () => void}) =>
		createElement('button', {type: 'button', onClick}, children),
}));

const UserSettingsCommands = await import('@app/features/user/commands/UserSettingsCommands');
const ModalCommands = await import('@app/features/ui/commands/ModalCommands');
const {GameActivityDefaultNagbar, canShowGameActivityDefault} = await import(
	'@app/features/app/components/layout/app_layout/nagbars/GameActivityDefaultNagbar'
);

describe('game activity default notice', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const button = (label: string) =>
		[...container.querySelectorAll('button')].find((element) => element.textContent === label)!;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		modalProps.value = null;
		vi.mocked(UserSettingsCommands.acknowledgeGameActivityDefault).mockResolvedValue(undefined);
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it('shows only while the server default is pending, settings are loaded and the rollout is on', () => {
		expect(canShowGameActivityDefault({pending: true, hydrated: true, rolloutEnabled: true})).toBe(true);
		expect(canShowGameActivityDefault({pending: false, hydrated: true, rolloutEnabled: true})).toBe(false);
		expect(canShowGameActivityDefault({pending: true, hydrated: false, rolloutEnabled: true})).toBe(false);
		expect(canShowGameActivityDefault({pending: true, hydrated: true, rolloutEnabled: false})).toBe(false);
	});

	it('tells what is shared, to whom and how to change it, with the privacy policy link', () => {
		act(() => root.render(createElement(GameActivityDefaultNagbar, {isMobile: false})));
		expect(container.textContent).toContain('Game activity is now on by default');
		expect(container.textContent).toContain('members of servers you share');
		expect(container.textContent).toContain('people you’ve blocked can’t see it');
		expect(container.textContent).toContain('Settings › Privacy › Show my game activity');
		expect(container.querySelector('a')?.getAttribute('href')).toBe('https://micup.test/privacy');
	});

	it('okay and close both acknowledge on the server', async () => {
		act(() => root.render(createElement(GameActivityDefaultNagbar, {isMobile: false})));
		await act(async () => button('Okay').click());
		expect(UserSettingsCommands.acknowledgeGameActivityDefault).toHaveBeenCalledTimes(1);
		await act(async () => button('close').click());
		expect(UserSettingsCommands.acknowledgeGameActivityDefault).toHaveBeenCalledTimes(2);
		expect(ModalCommands.push).not.toHaveBeenCalled();
	});

	it('settings acknowledges and opens privacy settings at the game activity section', async () => {
		act(() => root.render(createElement(GameActivityDefaultNagbar, {isMobile: true})));
		await act(async () => button('Settings').click());
		expect(UserSettingsCommands.acknowledgeGameActivityDefault).toHaveBeenCalledTimes(1);
		expect(ModalCommands.push).toHaveBeenCalledTimes(1);
		expect(modalProps.value).toMatchObject({initialTab: 'privacy_safety', initialSubtab: 'game-activity'});
	});

	it('a failed acknowledgement leaves the notice up', async () => {
		vi.mocked(UserSettingsCommands.acknowledgeGameActivityDefault).mockRejectedValue(new Error('503'));
		act(() => root.render(createElement(GameActivityDefaultNagbar, {isMobile: false})));
		await act(async () => button('Okay').click());
		expect(container.textContent).toContain('Game activity is now on by default');
		expect(button('Okay')).toBeDefined();
	});
});

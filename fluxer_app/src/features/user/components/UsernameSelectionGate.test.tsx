// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {UsernameSelectionGate} from '@app/features/user/components/UsernameSelectionGate';
import UsernameSelection from '@app/features/user/state/UsernameSelection';
import {act, createElement, type ReactNode, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const fixture = vi.hoisted(() => ({
	user: {
		id: '1234567890123456',
		instanceId: 'active',
		username: 'oldname',
		discriminator: '1234',
		usernameState: 'legacy',
		identityVersion: '0',
		bot: false,
		system: false,
		verified: true,
		email: 'user@example.test',
	},
	accountKey: 'active::1234567890123456' as string | null,
	authenticated: true,
	path: '/channels/@me',
	migration: {state: 'selecting', epoch: 1, started_at: '2026-10-01T00:00:00Z', forced_at: '2026-10-08T00:00:00Z'},
	post: vi.fn(),
	push: vi.fn(),
	pop: vi.fn(),
	logout: vi.fn(),
}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
	Trans: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {
		get usernameMigration() {
			return fixture.migration;
		},
	},
}));
vi.mock('@app/features/platform/state/AuthSession', () => ({
	default: {
		get currentAccountKey() {
			return fixture.accountKey;
		},
		get isAuthenticated() {
			return fixture.authenticated;
		},
		get userId() {
			return fixture.accountKey?.split('::')[1] ?? null;
		},
	},
}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {
		get currentUser() {
			return fixture.user;
		},
	},
}));
vi.mock('@app/features/platform/components/router/RouterReact', () => ({
	useLocation: () => ({pathname: fixture.path}),
}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http: {post: fixture.post}}));
vi.mock('@app/features/auth/commands/AuthenticationCommands', () => ({logout: fixture.logout}));
vi.mock('@app/features/app/components/dialogs/LoadableSettingsModals', () => ({
	UserSettingsModal: () => createElement('div', {'data-settings': true}),
}));
vi.mock('@app/features/auth/components/modals/ClaimAccountModal', () => ({
	ClaimAccountModal: () => createElement('div', {'data-claim': true}),
}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({
	push: fixture.push,
	modal: (render: () => ReactNode) => render,
}));
vi.mock('@app/features/ui/state/Modal', () => ({
	default: {push: fixture.push, pop: fixture.pop, hasModal: () => false},
}));
vi.mock('@app/features/platform/components/loadable/LoadableComponent', () => ({
	createNamedLoadableComponent: () => (props: {user: {id: string}; required?: boolean; inline?: boolean}) => {
		const [initialUserId] = useState(props.user.id);
		return createElement('div', {
			'data-picker': true,
			'data-required': String(props.required),
			'data-inline': String(props.inline),
			'data-initial-user': initialUserId,
		});
	},
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick}: {children: ReactNode; onClick: () => void}) =>
		createElement('button', {type: 'button', onClick}, children),
}));
vi.mock('@app/app/Routes', () => ({Routes: {help: () => 'https://help.example.test'}}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const render = async () =>
	act(async () => {
		root.render(
			createElement(
				UsernameSelectionGate,
				null,
				createElement('button', {id: 'app-content', type: 'button'}, 'Messages'),
			),
		);
	});
const button = (label: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === label);

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	vi.resetAllMocks();
	UsernameSelection.reset();
	fixture.accountKey = 'active::1234567890123456';
	fixture.authenticated = true;
	fixture.path = '/channels/@me';
	fixture.user.id = '1234567890123456';
	fixture.user.usernameState = 'legacy';
	fixture.user.identityVersion = '0';
	fixture.user.bot = false;
	fixture.user.system = false;
	fixture.user.verified = true;
	fixture.migration.started_at = '2026-10-01T00:00:00Z';
	fixture.post.mockResolvedValue({ok: true, body: {show: false}});
	vi.setSystemTime(Date.parse(fixture.migration.started_at));
	container = document.createElement('div');
	document.body.append(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('one root username gate', () => {
	test('asks the server immediately and retries its exact delay despite an early visibility wake', async () => {
		fixture.user.id = '1000000000000000000';
		fixture.accountKey = `active::${fixture.user.id}`;
		fixture.post
			.mockResolvedValueOnce({body: {show: false, retry_after_ms: 3329462}})
			.mockResolvedValueOnce({body: {show: true}});
		await render();
		expect(fixture.post).toHaveBeenCalledOnce();
		expect(fixture.push).not.toHaveBeenCalled();
		const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
		await act(async () => vi.advanceTimersByTime(100));
		await act(async () => document.dispatchEvent(new Event('visibilitychange')));
		expect(fixture.post).toHaveBeenCalledOnce();
		await act(async () => vi.advanceTimersByTime(3329361));
		expect(fixture.post).toHaveBeenCalledOnce();
		await act(async () => vi.advanceTimersByTime(1));
		expect(fixture.post).toHaveBeenCalledTimes(2);
		expect(fixture.push).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(1);
		visible.mockRestore();
	});
	test('visibility after a suspended tab passes the server deadline retries without consuming the day', async () => {
		vi.setSystemTime(Date.parse('2026-10-02T10:00:00Z'));
		fixture.post
			.mockResolvedValueOnce({body: {show: false, retry_after_ms: 5000}})
			.mockResolvedValueOnce({body: {show: true}});
		await render();
		expect(fixture.post).toHaveBeenCalledOnce();
		vi.setSystemTime(Date.now() + 6000);
		const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
		await act(async () => document.dispatchEvent(new Event('visibilitychange')));
		expect(fixture.post).toHaveBeenCalledTimes(2);
		expect(fixture.push).toHaveBeenCalledOnce();
		visible.mockRestore();
	});
	test('only opens a daily popup for show=true and never repeats the same day', async () => {
		vi.setSystemTime(Date.parse('2026-10-02T10:00:00Z'));
		fixture.post.mockResolvedValue({ok: true, body: {show: true}});
		await render();
		expect(fixture.push).toHaveBeenCalledOnce();
		await render();
		expect(fixture.post).toHaveBeenCalledOnce();
		await act(async () => vi.advanceTimersByTime(1000));
		expect(fixture.post).toHaveBeenCalledOnce();
	});
	test('show=false leaves the app usable and does not retry on a rerender', async () => {
		vi.setSystemTime(Date.parse('2026-10-02T10:00:00Z'));
		await render();
		await render();
		await act(async () => vi.advanceTimersByTime(10000));
		const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
		await act(async () => document.dispatchEvent(new Event('visibilitychange')));
		visible.mockRestore();
		expect(fixture.post).toHaveBeenCalledOnce();
		expect(fixture.push).not.toHaveBeenCalled();
		expect(container.querySelector('[inert]')).toBeNull();
	});
	test('a failed prompt request leaves the app usable without repeating that day', async () => {
		vi.setSystemTime(Date.parse('2026-10-02T10:00:00Z'));
		fixture.post.mockRejectedValueOnce(new Error('Prompt service unavailable'));
		await render();
		await render();
		expect(fixture.post).toHaveBeenCalledOnce();
		expect(fixture.push).not.toHaveBeenCalled();
		expect(container.querySelector('[inert]')).toBeNull();
	});
	test('opens the non-dismissable full screen at the forced deadline with settings, support and read escape', async () => {
		vi.setSystemTime(Date.parse(fixture.migration.forced_at) - 1);
		await render();
		await act(async () => vi.advanceTimersByTime(1));
		expect(container.querySelector('[data-required="true"][data-inline="true"]')).not.toBeNull();
		expect(container.querySelector('[inert] #app-content')).not.toBeNull();
		await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})));
		expect(container.querySelector('[data-required="true"]')).not.toBeNull();
		expect(button('Settings and account security')).toBeDefined();
		expect(button('Log out')).toBeDefined();
		expect(container.querySelector('a[href="https://help.example.test"]')).not.toBeNull();
		await act(async () => button('Read messages, block or report')?.click());
		expect(container.querySelector('[inert]')).toBeNull();
		expect(button('Choose your username')).toBeDefined();
	});
	test('verification and password routes remain reachable even while forced', async () => {
		vi.setSystemTime(Date.parse(fixture.migration.forced_at));
		fixture.path = '/verify';
		await render();
		expect(container.querySelector('[data-picker]')).toBeNull();
		expect(container.querySelector('[inert]')).toBeNull();
	});
	test('unverified accounts can choose a username and still reach verification through settings', async () => {
		vi.setSystemTime(Date.parse(fixture.migration.forced_at));
		fixture.user.verified = false;
		await render();
		expect(container.querySelector('[data-picker]')).not.toBeNull();
		expect(button('Settings and account security')).toBeDefined();
		await act(async () => button('Settings and account security')?.click());
		expect(fixture.push).toHaveBeenCalledOnce();
	});
	test('a direct required account switch initializes the picker for the new account', async () => {
		vi.setSystemTime(Date.parse(fixture.migration.forced_at));
		await render();
		expect(container.querySelector('[data-picker]')?.getAttribute('data-initial-user')).toBe('1234567890123456');
		fixture.user.id = '1234567890123457';
		fixture.accountKey = 'active::1234567890123457';
		await render();
		expect(container.querySelector('[data-picker]')?.getAttribute('data-initial-user')).toBe('1234567890123457');
	});
	test('account switch cancels the old timer and stale prompt response', async () => {
		let resolve: (value: {ok: boolean; body: {show: boolean}}) => void = () => {};
		fixture.post.mockImplementation(
			() =>
				new Promise((complete) => {
					resolve = complete;
				}),
		);
		vi.setSystemTime(Date.parse('2026-10-02T10:00:00Z'));
		await render();
		expect(fixture.post).toHaveBeenCalledOnce();
		const signal = fixture.post.mock.calls[0][1].signal as AbortSignal;
		fixture.accountKey = 'active::another';
		await render();
		expect(signal.aborted).toBe(true);
		await act(async () => resolve({ok: true, body: {show: true}}));
		expect(fixture.push).not.toHaveBeenCalled();
		fixture.authenticated = false;
		fixture.accountKey = null;
		await render();
		expect(vi.getTimerCount()).toBe(0);
	});
	test('a newer selected identity from another session clears the required error screen', async () => {
		await render();
		act(() => UsernameSelection.requireSelection(fixture.accountKey, '0'));
		await render();
		expect(container.querySelector('[data-required="true"]')).not.toBeNull();
		fixture.user.usernameState = 'selected';
		fixture.user.identityVersion = '1';
		await render();
		expect(container.querySelector('[data-required="true"]')).toBeNull();
	});
});

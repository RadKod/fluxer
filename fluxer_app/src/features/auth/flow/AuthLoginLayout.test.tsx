// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, cloneElement, createElement, type ReactElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const route = vi.hoisted(() => ({search: '', navigate: vi.fn()}));
const Passthrough = ({children}: {children?: ReactNode}) => children;

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/auth/state/Authentication', () => ({
	default: {loginState: 'default'},
	LoginState: {DEFAULT: 'default', MFA: 'mfa'},
}));
vi.mock('@app/features/auth/state/AuthRuntimeTarget', () => ({
	useAuthRuntimeTarget: () => ({reset: vi.fn()}),
}));
vi.mock('@app/features/auth/flow/auth_login_core/useDesktopHandoffFlow', () => ({isHandoffRequest: () => false}));
vi.mock('@app/features/auth/flow/DesktopHandoffMfaStep', () => ({DesktopHandoffMfaStep: () => null}));
vi.mock('@app/features/auth/flow/AuthFloatingBackButton', () => ({AuthFloatingBackButton: () => null}));
// The page's route wiring is independent of the selected account and login flow.
vi.mock('@app/features/auth/flow/AuthLoginLayout', () => ({
	AuthLoginLayout: ({registerLink}: {registerLink: ReactElement<Record<string, unknown>>}) =>
		cloneElement(registerLink, {asButton: true}),
}));
vi.mock('@app/features/platform/components/router/RouterReact', () => ({
	useLocation: () => ({pathname: '/login', search: route.search}),
	useNavigate: () => route.navigate,
	Link: ({to, children}: {to: string; children?: ReactNode}) => <a href={to}>{children}</a>,
}));
vi.mock('@app/features/ui/stepped_carousel/SteppedCarousel', () => ({SteppedCarousel: Passthrough}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: Passthrough}));
vi.mock('@app/features/window/hooks/useFluxerDocumentTitle', () => ({useFluxerDocumentTitle: () => {}}));

const {default: LoginPage} = await import('@app/features/auth/components/pages/LoginPage');
const {AuthLoginMethodStep} = await import('@app/features/auth/flow/auth_login_core/AuthLoginMethodStep');
const {AuthRouterLink} = await import('@app/features/auth/flow/AuthRouterLink');
const {AUTH_LOGIN_METHOD_QUERY_PARAM} = await import('@app/features/auth/flow/auth_login_core/AuthLoginStepTypes');
const {default: buttonStyles} = await import('@app/features/ui/button/Button.module.css');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	route.search = '';
	vi.clearAllMocks();
	container = document.createElement('div');
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

function renderMethodStep(registerLink: ReactElement<Record<string, unknown>>): void {
	act(() =>
		root.render(
			createElement(AuthLoginMethodStep, {
				disabled: false,
				extraTopContent: null,
				identifierField: 'email',
				leadingAction: null,
				passkeyAvailableForInstance: false,
				registerLink,
				showBrowserOption: false,
				showPasskeyOption: false,
				showTitle: true,
				ssoAction: null,
				switchError: null,
				title: 'Welcome back',
				onBrowserLogin: vi.fn(),
				onEmailLogin: vi.fn(),
				onPasskeyLogin: vi.fn(),
				onBackToInstance: null,
			}),
		),
	);
}

function registrationButton(label = 'Register an account'): HTMLButtonElement {
	const button = Array.from(container.querySelectorAll('button')).find((node) => node.textContent === label);
	expect(button, 'registration is a button in the login method picker').toBeDefined();
	return button!;
}

describe('login registration action', () => {
	it('shows a full-width secondary registration button after the primary sign-in method', () => {
		renderMethodStep(<AuthRouterLink to="/register">Register</AuthRouterLink>);
		const button = registrationButton();
		const primary = container.querySelector('button[data-step-focus="true"]');
		expect(button.classList.contains(buttonStyles.secondary)).toBe(true);
		expect(button.classList.contains(buttonStyles.fitContainer)).toBe(true);
		expect(button.getAttribute('type')).toBe('button');
		expect(button.previousElementSibling?.contains(primary)).toBe(true);
		expect(primary?.classList.contains(buttonStyles.primary)).toBe(true);
		expect(container.textContent).not.toContain('Need an account?');
	});

	it('keeps the login page registration redirect and method query when clicked', () => {
		const redirect = '/channels/123/456?message=789#latest';
		route.search = `?redirect_to=${encodeURIComponent(redirect)}&email=user%40example.com`;
		act(() => root.render(createElement(LoginPage)));
		act(() => registrationButton('Register').click());
		expect(route.navigate).toHaveBeenCalledWith({
			to: '/register',
			search: {
				redirect_to: redirect,
				[AUTH_LOGIN_METHOD_QUERY_PARAM.name]: AUTH_LOGIN_METHOD_QUERY_PARAM.value,
			},
		});
	});

	it('keeps invite-specific registration routes and their query', () => {
		renderMethodStep(
			<AuthRouterLink to="/invite/invite-code" search={{redirect_to: '/channels/123', source: 'invite'}}>
				Register
			</AuthRouterLink>,
		);
		act(() => registrationButton().click());
		expect(route.navigate).toHaveBeenCalledWith({
			to: '/invite/invite-code',
			search: {redirect_to: '/channels/123', source: 'invite'},
		});
	});
});

// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({shouldAsk: false}));
const commands = vi.hoisted(() => ({start: vi.fn(() => () => {}), accept: vi.fn(), reject: vi.fn()}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: {message: string}) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/app/Router', () => ({router: {name: 'router'}}));
vi.mock('@app/app/Routes', () => ({Routes: {privacy: () => 'https://micup.gg/marketing/privacy'}}));
vi.mock('@app/features/app/config/Config', () => ({
	default: {PUBLIC_GA4_MEASUREMENT_ID: 'G-TEST1234', PUBLIC_BUILD_VERSION: '9.9.9'},
}));
vi.mock('@app/features/app/config/I18nDisplayConstants', () => ({PRODUCT_NAME: 'Micup'}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {privacyUrl: 'https://micup.gg/gizlilik'}}));
vi.mock('@app/features/ui/utils/NativeUtils', () => ({isDesktop: () => false}));
vi.mock('@app/features/analytics/state/AnalyticsConsent', () => ({default: state}));
vi.mock('@app/features/analytics/commands/AnalyticsCommands', () => commands);
vi.mock('@app/features/app/components/shared/ExternalLink', () => ({
	ExternalLink: ({href, children}: {href: string; children: ReactNode}) => createElement('a', {href}, children),
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({
		children,
		onClick,
		variant,
		small,
	}: {
		children: ReactNode;
		onClick: () => void;
		variant?: string;
		small?: boolean;
	}) =>
		createElement('button', {type: 'button', onClick, 'data-variant': variant, 'data-small': String(small)}, children),
}));

const {AnalyticsConsentBanner} = await import('@app/features/analytics/components/AnalyticsConsentBanner');

let container: HTMLDivElement;
let root: Root;

function render(): void {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement('div');
	root = createRoot(container);
	act(() => root.render(createElement(AnalyticsConsentBanner)));
}

beforeEach(() => {
	state.shouldAsk = false;
	vi.clearAllMocks();
});

afterEach(() => {
	act(() => root.unmount());
});

describe('AnalyticsConsentBanner', () => {
	it('starts analytics with the configured id and shows nothing once the person has decided', () => {
		render();
		expect(commands.start).toHaveBeenCalledWith({
			measurementId: 'G-TEST1234',
			router: {name: 'router'},
			platform: 'web',
			appVersion: '9.9.9',
		});
		expect(container.innerHTML).toBe('');
	});

	it('gives Accept and Reject the same weight and does what each says', () => {
		state.shouldAsk = true;
		render();
		const buttons = [...container.querySelectorAll('button')];
		expect(buttons.map((button) => button.textContent)).toEqual(['Accept', 'Reject']);
		expect(new Set(buttons.map((button) => `${button.dataset.variant}/${button.dataset.small}`)).size).toBe(1);
		expect(container.textContent).toContain('Google Analytics');
		expect(container.querySelector('a')?.getAttribute('href')).toBe('https://micup.gg/gizlilik');

		act(() => buttons[1].click());
		expect(commands.reject).toHaveBeenCalledTimes(1);
		expect(commands.accept).not.toHaveBeenCalled();
		act(() => buttons[0].click());
		expect(commands.accept).toHaveBeenCalledTimes(1);
	});
});

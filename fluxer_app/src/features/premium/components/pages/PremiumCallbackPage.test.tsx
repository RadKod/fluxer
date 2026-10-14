// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const runtimeConfig = vi.hoisted(() => ({selfHosted: true, giftCodesEnabled: true}));
const location = vi.hoisted(() => ({search: ''}));
const premiumCommands = vi.hoisted(() => ({continueLocalizedCardPreapproval: vi.fn()}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
	Trans: ({children}: {children?: ReactNode}) => children,
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {
		isSelfHosted: () => runtimeConfig.selfHosted,
		get giftCodesEnabled() {
			return runtimeConfig.giftCodesEnabled;
		},
	},
}));
vi.mock('@app/features/platform/components/router/RouterReact', () => ({useLocation: () => location}));
vi.mock('@app/features/premium/commands/PremiumCommands', () => premiumCommands);

const {default: PremiumCallbackPage} = await import('@app/features/premium/components/pages/PremiumCallbackPage');

describe('PremiumCallbackPage', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let replace: ReturnType<typeof vi.fn>;

	// A fresh page each time, as a browser landing on the return address gets.
	const render = (search: string) => {
		act(() => root.unmount());
		root = createRoot(container);
		location.search = search;
		act(() => root.render(createElement(PremiumCallbackPage)));
	};
	const heading = () => container.querySelector('h1')?.textContent ?? null;
	const body = () => container.querySelector('p')?.textContent ?? null;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		Object.assign(runtimeConfig, {selfHosted: true, giftCodesEnabled: true});
		premiumCommands.continueLocalizedCardPreapproval.mockReset();
		replace = vi.fn();
		vi.spyOn(window, 'location', 'get').mockReturnValue({...window.location, replace} as unknown as Location);
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
	});

	it('shows the pending state self-hosted without a session', () => {
		render('?status=pending');

		expect(heading()).toBe('Confirming your payment');
		expect(body()).toBe(
			'You can close this tab and return to the app. Your purchase appears there once it is confirmed.',
		);
		expect(replace).not.toHaveBeenCalled();
		expect(premiumCommands.continueLocalizedCardPreapproval).not.toHaveBeenCalled();
	});

	it('success and cancel reuse the existing texts', () => {
		render('?status=success');

		expect(heading()).toBe('Payment successful');
		expect(body()).toBe('Your payment was successful. You can now close this tab and return to the app.');

		render('?status=cancel');

		expect(heading()).toBe('Payment canceled');
		expect(body()).toBe('Your payment was canceled. You can now close this tab and return to the app.');
		expect(replace).not.toHaveBeenCalled();
	});

	it('hosted (not self-hosted) behaviour is unchanged', () => {
		runtimeConfig.selfHosted = false;
		render('?status=success');

		expect(heading()).toBe('Payment successful');

		render('?status=pending');

		expect(heading()).toBe('Invalid status');
		expect(replace).not.toHaveBeenCalled();
	});

	it('a self-hosted instance that does not sell still sends the browser to the app', () => {
		runtimeConfig.giftCodesEnabled = false;
		render('?status=success');

		expect(container.innerHTML).toBe('');
		expect(replace).toHaveBeenCalledWith('/');

		runtimeConfig.giftCodesEnabled = true;
		replace.mockReset();
		render('?status=closed-billing-portal');

		expect(container.innerHTML).toBe('');
		expect(replace).toHaveBeenCalledWith('/');
	});

	it('redirects a self-hosted preapproval callback without starting a Stripe poll', () => {
		render('?status=preapproval-success&token=unexpected');
		expect(container.innerHTML).toBe('');
		expect(replace).toHaveBeenCalledWith('/');
		expect(premiumCommands.continueLocalizedCardPreapproval).not.toHaveBeenCalled();
	});

	it('rejects a retired hosted preapproval callback without polling Stripe', async () => {
		runtimeConfig.selfHosted = false;
		premiumCommands.continueLocalizedCardPreapproval.mockResolvedValue({status: 'pending'});
		render('?status=preapproval-success&token=unexpected');
		await act(async () => {});

		expect(heading()).toBe('Invalid status');
		expect(premiumCommands.continueLocalizedCardPreapproval).not.toHaveBeenCalled();
		expect(replace).not.toHaveBeenCalled();
	});
});

// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const runtime = vi.hoisted(() => ({isSelfHosted: () => true, giftCodesEnabled: true}));
const frame = vi.hoisted(() => ({props: null as null | Record<string, unknown>}));
const body = vi.hoisted(() => ({props: null as null | {filter: string; redeemInputId: string; setId: string | null}}));
const nav = vi.hoisted(() => ({search: '', transitionTo: vi.fn()}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message, locale: 'en'}}),
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: runtime}));
vi.mock('@app/features/platform/components/router/RouterReact', () => ({
	useSearch: () => new URLSearchParams(nav.search),
}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => ({transitionTo: nav.transitionTo}));
// The frame has its own test; here it only shows what the page hands to the bar and the body.
vi.mock('@app/features/channel/components/direct_message/DMPageFrame', () => ({
	DMPageFrame: (props: {
		title: string;
		tabs: Array<{key: string; label: string}>;
		activeTab: string;
		onTabChange: (key: string) => void;
		action?: React.ReactNode;
		children: React.ReactNode;
	}) => {
		frame.props = props;
		return createElement(
			'div',
			null,
			createElement(
				'header',
				null,
				props.title,
				props.tabs.map(({key, label}) =>
					createElement(
						'button',
						{
							key,
							type: 'button',
							role: 'tab',
							'aria-selected': key === props.activeTab,
							onClick: () => props.onTabChange(key),
						},
						label,
					),
				),
				props.action,
			),
			props.children,
		);
	},
}));
vi.mock('@app/features/shop/components/ShopRedeemField', () => ({
	ShopRedeemJumpButton: ({inputId}: {inputId: string}) =>
		createElement('button', {type: 'button', 'data-jump': inputId}),
}));
// The body has its own test (ShopTab.test.tsx); here it only shows the filter and the code field it gets.
vi.mock('@app/features/shop/components/ShopTab', () => ({
	SHOP_TYPE_ORDER: ['avatar_ultra', 'avatar_decoration', 'nameplate', 'profile_effect'],
	ShopTab: (props: {filter: string; redeemInputId: string; setId: string | null}) => {
		body.props = props;
		return createElement('div', {'data-testid': 'shop-body'});
	},
}));

const {ShopPage} = await import('@app/features/shop/components/pages/ShopPage');
const {Routes} = await import('@app/app/Routes');

describe('ShopPage', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		runtime.giftCodesEnabled = true;
		frame.props = null;
		body.props = null;
		nav.search = '';
		nav.transitionTo.mockClear();
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

	it('puts the type filter in the bar, ultras first, and hands it to the body', () => {
		act(() => root.render(createElement(ShopPage)));
		expect(container.querySelector('header')?.textContent).toContain('Shop');
		expect(tabs().map((tab) => tab.textContent)).toEqual([
			'All',
			'Ultra decoration',
			'Avatar decoration',
			'Nameplate',
			'Profile effect',
		]);
		expect(body.props?.filter).toBe('all');

		act(() => tabs()[3]?.click());
		expect(body.props?.filter).toBe('nameplate');
		expect(tabs()[3]?.getAttribute('aria-selected')).toBe('true');
	});

	it('opens the set named in the query, and a filter picked there goes back to the whole shop', () => {
		nav.search = '?set=70';
		act(() => root.render(createElement(ShopPage)));
		expect(body.props?.setId).toBe('70');

		act(() => tabs()[1]?.click());
		expect(body.props?.filter).toBe('avatar_ultra');
		expect(nav.transitionTo).toHaveBeenCalledWith('/shop');
	});

	it('the whole shop has no set open and a filter stays on the page', () => {
		act(() => root.render(createElement(ShopPage)));
		expect(body.props?.setId).toBeNull();
		act(() => tabs()[1]?.click());
		expect(nav.transitionTo).not.toHaveBeenCalled();
	});

	it('the bar’s "Redeem a code" jumps to the body’s code field', () => {
		act(() => root.render(createElement(ShopPage)));
		const jump = container.querySelector('header [data-jump]');
		expect(jump).not.toBeNull();
		expect(jump?.getAttribute('data-jump')).toBe(body.props?.redeemInputId);
	});

	it('with gift codes off the bar has no code button', () => {
		runtime.giftCodesEnabled = false;
		act(() => root.render(createElement(ShopPage)));
		expect(container.querySelector('[data-jump]')).toBeNull();
	});

	it('lays the body out itself, so the hero spans the full width', () => {
		act(() => root.render(createElement(ShopPage)));
		expect(typeof frame.props?.bodyClassName).toBe('string');
		expect(container.querySelector('[data-testid="shop-body"]')).not.toBeNull();
	});

	it('the shop and premium pages are special pages beside the DM list', () => {
		expect(Routes.SHOP).toBe('/shop');
		expect(Routes.PREMIUM).toBe('/premium');
		expect(Routes.isSpecialPage(Routes.SHOP)).toBe(true);
		expect(Routes.isSpecialPage(Routes.PREMIUM)).toBe(true);
		expect(Routes.isDMRoute(Routes.SHOP)).toBe(false);
	});
});

// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({pathname: '/channels/@me', premium: true, shop: true}));
const premiumModalCommands = vi.hoisted(() => ({open: vi.fn()}));
const routerUtils = vi.hoisted(() => ({transitionTo: vi.fn()}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/messaging/utils/MessagingUrlUtils', () => ({marketingUrl: (path: string) => path}));
vi.mock('@app/features/platform/components/router/RouterReact', () => ({
	useLocation: () => ({pathname: state.pathname}),
}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => routerUtils);
vi.mock('@app/features/premium/commands/PremiumModalCommands', () => premiumModalCommands);
vi.mock('@app/features/premium/utils/PremiumUtils', () => ({
	getPremiumProductName: () => 'sanalyer Plus',
	shouldShowPremiumFeatures: () => state.premium,
}));
vi.mock('@app/features/shop/utils/ShopAvailability', () => ({isShopPageAvailable: () => state.shop}));
vi.mock('@app/features/shop/utils/ShopMessageDescriptors', () => ({SHOP_DESCRIPTOR: {message: 'Shop'}}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({
	default: ({children}: {children?: React.ReactNode}) => children ?? null,
}));

const {DMListPageItems} = await import('@app/features/channel/components/direct_message/DMListPageItems');
const {default: styles} = await import('@app/features/channel/components/direct_message/DMListPageItems.module.css');
const {default: dmStyles} = await import(
	'@app/features/channel/components/direct_message/DirectMessageList.module.css'
);

// Micup: premium, Bot System and the shop are one list shared by the DM list and the feed sidebar.
describe('DMListPageItems', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let renders = 0;
	const render = () => act(() => root.render(createElement(DMListPageItems, {key: ++renders})));
	const labels = () => [...container.querySelectorAll('button')].map((button) => button.textContent);
	const row = (label: string) =>
		[...container.querySelectorAll('button')].find((button) => button.textContent === label);
	const current = () =>
		[...container.querySelectorAll('button')]
			.filter((button) => button.getAttribute('aria-current') === 'page')
			.map((button) => button.textContent);

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		Object.assign(state, {pathname: '/channels/@me', premium: true, shop: true});
		premiumModalCommands.open.mockClear();
		routerUtils.transitionTo.mockClear();
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	// The two accented rows sit together on top, Bot System under them.
	it('lists premium, the shop and Bot System in one order', () => {
		render();
		expect(labels()).toEqual(['sanalyer Plus', 'Shop', 'Bot System']);
		state.premium = false;
		render();
		expect(labels()).toEqual(['Shop', 'Bot System']);
		state.shop = false;
		render();
		expect(labels()).toEqual(['Bot System']);
	});

	it('opens premium through its command and the other pages by route', () => {
		render();
		act(() => row('sanalyer Plus')!.click());
		expect(premiumModalCommands.open).toHaveBeenCalledTimes(1);
		act(() => row('Bot System')!.click());
		expect(routerUtils.transitionTo).toHaveBeenCalledWith('/bots');
		act(() => row('Shop')!.click());
		expect(routerUtils.transitionTo).toHaveBeenCalledWith('/shop');
	});

	it.each([
		['/channels/@me', []],
		['/feed', []],
		['/premium', ['sanalyer Plus']],
		['/bots', ['Bot System']],
		['/shop', ['Shop']],
		['/feed/premium', ['sanalyer Plus']],
		['/feed/bots', ['Bot System']],
		['/feed/shop', ['Shop']],
	])('on %s marks %j as the current page', (pathname, expected) => {
		state.pathname = pathname;
		render();
		expect(current()).toEqual(expected);
	});

	it('draws the rows as DM list rows, selected or not', () => {
		state.pathname = '/feed/shop';
		render();
		expect(row('Shop')!.classList).toContain(dmStyles.clickableItemSelected);
		expect(row('Bot System')!.classList).toContain(dmStyles.clickableItem);
		expect(row('Bot System')!.classList).not.toContain(dmStyles.clickableItemSelected);
		expect(row('Bot System')!.querySelector(`.${dmStyles.clickableItemIcon} svg`)).not.toBeNull();
	});

	it('marks premium and the shop with the accent, not Bot System', () => {
		render();
		for (const label of ['sanalyer Plus', 'Shop']) {
			expect(row(label)!.classList).toContain(styles.accent);
			expect(row(label)!.querySelector(`.${styles.accentIcon}`)).not.toBeNull();
			expect(row(label)!.querySelector(`.${styles.accentLabel}`)?.textContent).toBe(label);
		}
		expect(row('Bot System')!.classList).not.toContain(styles.accent);
		expect(row('Bot System')!.querySelector(`.${styles.accentIcon}`)).toBeNull();
		expect(row('Bot System')!.querySelector(`.${styles.accentLabel}`)).toBeNull();
	});
});

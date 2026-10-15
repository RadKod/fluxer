// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ShopBundleEntry, ShopItemEntry} from '@app/features/shop/utils/ShopEntries';
import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const nav = vi.hoisted(() => ({leave: vi.fn(), transitionTo: vi.fn()}));
const modal = vi.hoisted(() => ({open: false}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/app/Routes', () => ({Routes: {SHOP: '/shop'}}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => ({transitionTo: nav.transitionTo}));
vi.mock('@app/features/shop/utils/ShopSetNavigation', () => ({leaveShopSet: nav.leave}));
vi.mock('@app/features/ui/state/Modal', () => ({default: {hasModalOpen: () => modal.open}}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({
	default: ({children}: {children: React.ReactNode}) => createElement('span', {'data-focus-ring': true}, children),
}));
// The cards and the art have their own tests.
vi.mock('@app/features/shop/components/ShopBundleCard', () => ({
	ShopBundleCard: ({entry}: {entry: ShopBundleEntry}) => createElement('div', {'data-card': entry.sku}),
	ShopBundleBuyButton: () => null,
}));
vi.mock('@app/features/shop/components/ShopItemCard', () => ({
	ShopItemCard: ({entry}: {entry: ShopItemEntry}) => createElement('div', {'data-card': entry.sku}),
}));
vi.mock('@app/features/shop/components/ShopSetArt', () => ({ShopSetArt: () => null}));

const {ShopSetView} = await import('@app/features/shop/components/ShopSetView');

const PRICE = {
	base_try_minor: 500,
	sale_try_minor: 500,
	premium_try_minor: null,
	campaign_percent: null,
	campaign_ends_at: null,
};
const BUNDLE: ShopBundleEntry = {
	kind: 'bundle',
	sku: 'bundle:70',
	price: PRICE,
	bundle: {id: '70', sku: 'bundle:70', name: 'Gece seti', description: null, items: [], price: PRICE},
};

describe('ShopSetView', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		vi.clearAllMocks();
		modal.open = false;
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = () =>
		act(() =>
			root.render(
				createElement(ShopSetView, {collection: {id: BUNDLE.sku, bundle: BUNDLE, series: null, entries: [BUNDLE]}}),
			),
		);
	const pressEscape = (target: EventTarget = document) =>
		act(() => {
			target.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
		});

	it("moves focus to the set's heading when the page opens", () => {
		const opener = document.createElement('button');
		document.body.append(opener);
		opener.focus();
		render();
		const heading = container.querySelector('h1');
		expect(heading?.textContent).toBe('Gece seti');
		expect(document.activeElement).toBe(heading);
		opener.remove();
	});

	it('Escape leaves the set without a new history entry, unless a dialog or a field has it', () => {
		render();
		pressEscape();
		expect(nav.leave).toHaveBeenCalledWith('70');
		expect(nav.transitionTo).not.toHaveBeenCalled();

		nav.leave.mockClear();
		modal.open = true;
		pressEscape();
		modal.open = false;
		const input = document.createElement('input');
		container.append(input);
		pressEscape(input);
		expect(nav.leave).not.toHaveBeenCalled();
	});

	it('the breadcrumb is a link back to the shop with the focus ring of the app', () => {
		render();
		const link = container.querySelector<HTMLButtonElement>('nav button');
		expect(link?.closest('[data-focus-ring]')).not.toBeNull();
		act(() => link?.click());
		expect(nav.transitionTo).toHaveBeenCalledWith('/shop');
		expect(nav.leave).not.toHaveBeenCalled();
	});
});

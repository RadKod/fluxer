// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ShopBundleEntry} from '@app/features/shop/utils/ShopEntries';
import {act, createElement, type ReactElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({owned: new Set<string>(), claimed: true, verified: true, sales: true}));
const commands = vi.hoisted(() => ({push: vi.fn(), pop: vi.fn(), modal: (render: () => unknown) => render}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: ({message}: {message: string}) => message}})}));
vi.mock('@app/features/ui/commands/ModalCommands', () => commands);
vi.mock('@app/features/shop/state/ShopCatalog', () => ({
	default: {
		get settings() {
			return {item_sales_open: state.sales};
		},
	},
}));
vi.mock('@app/features/cosmetics/state/Cosmetics', () => ({
	default: {
		getItem: (id: string) => ({owned: state.owned.has(id)}),
		equippedId: () => null,
	},
}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {
		get currentUser() {
			return {id: 'me', isClaimed: () => state.claimed, verified: state.verified};
		},
	},
}));
vi.mock('@app/features/app/components/dialogs/Modal', () => ({
	Root: ({children}: {children: ReactNode}) => createElement('div', null, children),
	Header: ({title}: {title: string}) => createElement('h1', null, title),
	Content: ({children}: {children: ReactNode}) => createElement('div', null, children),
	Footer: ({children}: {children: ReactNode}) => createElement('footer', null, children),
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, disabled, onClick}: {children: ReactNode; disabled?: boolean; onClick?: () => void}) =>
		createElement('button', {type: 'button', disabled, onClick}, children),
}));
vi.mock('@app/features/shop/components/PurchaseDisabledWrapper', () => ({
	PurchaseDisabledWrapper: ({children, tooltipText}: {children: ReactNode; tooltipText: string}) =>
		createElement('div', {'data-tooltip': tooltipText}, children),
}));
vi.mock('@app/features/shop/components/ShopItemStage', () => ({ShopItemStage: () => null}));
vi.mock('@app/features/shop/components/ShopPriceLine', () => ({
	ShopPriceLine: () => createElement('span', {'data-price': true}),
}));
vi.mock('@app/features/shop/components/previews/ShopDetailPreview', () => ({
	ShopDetailPreview: ({items}: {items: Array<{id: string}>}) =>
		createElement('span', {'data-items': items.map(({id}) => id).join(',')}),
}));
vi.mock('@app/features/shop/components/modals/ShopCheckoutModal', () => ({ShopCheckoutModal: () => null}));

const {ShopBundleDetailModal} = await import('@app/features/shop/components/modals/ShopBundleDetailModal');
const {ShopCheckoutModal} = await import('@app/features/shop/components/modals/ShopCheckoutModal');
const {ModalStackContext, UNSTACKED_MODAL_CONTEXT} = await import('@app/features/ui/utils/ModalStackContext');
const price = {
	base_try_minor: 900,
	sale_try_minor: 900,
	premium_try_minor: 630,
	campaign_percent: null,
	campaign_ends_at: null,
};
const entry: ShopBundleEntry = {
	kind: 'bundle',
	sku: 'bundle:70',
	price,
	bundle: {
		id: '70',
		sku: 'bundle:70',
		name: 'Night collection',
		description: 'A matching pair.',
		price,
		items: [
			{id: '1', type: 'avatar_ultra', name: 'Wings', description: null, asset: 'wings', availability: 'owned'},
			{id: '2', type: 'nameplate', name: 'Plate', description: null, asset: 'plate', availability: 'owned'},
		],
	},
};

describe('ShopBundleDetailModal', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		Object.assign(state, {owned: new Set(), claimed: true, verified: true, sales: true});
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});
	const render = (isTopmost = true) =>
		act(() =>
			root.render(
				createElement(
					ModalStackContext.Provider,
					{value: {...UNSTACKED_MODAL_CONTEXT, isTopmost}},
					createElement(ShopBundleDetailModal, {entry: {...entry}}),
				),
			),
		);
	const purchase = () => [...container.querySelectorAll('button')].find((button) => button.textContent === 'Purchase');

	it('lists the bundle contents and keeps price and purchase in the product column', () => {
		render();
		const product = container.querySelector('[data-flx="shop.shop-bundle-detail-modal.product"]');
		expect(product).not.toBeNull();
		expect(product?.textContent).toContain('Wings');
		expect(product?.textContent).toContain('Plate');
		expect(product?.textContent).toContain('Purchase');
		expect(product?.querySelector('[data-price]')).not.toBeNull();
		expect(container.querySelector('[data-items]')?.getAttribute('data-items')).toBe('1,2');
		act(() => purchase()?.click());
		const pushed = (commands.push.mock.calls[0][0] as () => ReactElement<{target: unknown}>)();
		expect(pushed.type).toBe(ShopCheckoutModal);
		expect(pushed.props.target).toEqual({kind: 'bundle', sku: 'bundle:70'});
	});

	it('keeps an unknown bundle item name visible without translating an unsupported type', () => {
		const futureItem = {...entry.bundle.items[0], name: 'Future item', type: 'future_cosmetic'};
		const future = {...entry, bundle: {...entry.bundle, items: [futureItem]}} as unknown as ShopBundleEntry;
		act(() => root.render(createElement(ShopBundleDetailModal, {entry: future})));
		expect(container.textContent).toContain('Future item');
		expect(container.textContent).not.toContain('future_cosmetic');
	});

	it.each([
		['partial', ['1']],
		['full', ['1', '2']],
	])('does not offer purchase for %s ownership', (_, ids) => {
		state.owned = new Set(ids);
		render();
		expect(purchase()).toBeUndefined();
		expect(container.textContent).toContain(
			ids.length === entry.bundle.items.length ? 'Owned' : 'You already own an item in this bundle',
		);
		expect(commands.push).not.toHaveBeenCalled();
	});

	it('does not offer purchase while item sales are closed', () => {
		state.sales = false;
		render();
		expect(purchase()).toBeUndefined();
	});

	it.each([
		['claimed', 'Claim your account to buy.'],
		['verified', 'Verify your email to buy.'],
	] as const)('disables purchase when %s is false', (field, reason) => {
		state[field] = false;
		render();
		expect(purchase()?.disabled).toBe(true);
		expect(container.querySelector('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(reason);
		act(() => purchase()?.click());
		expect(commands.push).not.toHaveBeenCalled();
	});

	it('does not infer checkout success from an ownership refresh after returning', () => {
		render();
		act(() => purchase()?.click());
		render(false);
		state.owned = new Set(['1', '2']);
		render();
		expect(commands.pop).not.toHaveBeenCalled();
	});

	it('stays open if the checkout is dismissed without purchase', () => {
		render();
		act(() => purchase()?.click());
		render(false);
		render();
		expect(commands.pop).not.toHaveBeenCalled();
	});
});

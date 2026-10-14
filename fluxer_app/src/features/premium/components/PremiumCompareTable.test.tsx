// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ShopItemEntry, ShopPackageEntry} from '@app/features/shop/utils/ShopEntries';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {ShopPriceResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {setupI18n} from '@lingui/core';
import {observable, runInAction} from 'mobx';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const DAY_MS = 24 * 60 * 60 * 1000;
const i18n = setupI18n({locale: 'en', messages: {en: {}}});
const clock = observable.box(Date.now());
const catalog = vi.hoisted(() => ({
	itemEntries: [] as Array<ShopItemEntry>,
	packageEntries: [] as Array<ShopPackageEntry>,
	settings: {premium_discount_percent: 0, usd_to_azn_rate_micro: 1700000},
	// The catalog's shared clock: it moves when a shown campaign ends.
	now: () => clock.get(),
}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n}),
	Trans: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/shop/state/ShopCatalog', () => ({default: catalog}));
vi.mock('@app/features/app/utils/UserLimits', () => ({
	Limits: {
		getStockValue: (_key: string, value: number) => value,
		getRestrictedValue: (_key: string, value: number) => value,
	},
}));
vi.mock('@app/features/cosmetics/utils/CosmeticAssetUtils', () => ({
	getCosmeticAssetURL: (_type: string, data: {item_id: string}) => `https://media.test/${data.item_id}.png`,
}));
vi.mock('@app/features/premium/utils/PremiumBadgeAsset', () => ({premiumBadgeUrl: () => 'https://cdn.test/badge.svg'}));

const {PremiumCompareTable} = await import('@app/features/premium/components/PremiumCompareTable');

function price(base: number, sale?: number): ShopPriceResponse {
	return {
		base_usd_cents: base,
		campaign_percent: sale === undefined ? null : 20,
		campaign_ends_at: null,
		sale_usd_cents: sale ?? base,
		premium_usd_cents: null,
	};
}

function pack(months: 1 | 3 | 12, packagePrice: ShopPriceResponse): ShopPackageEntry {
	return {kind: 'package', sku: `premium:${months}`, months, price: packagePrice};
}

function premiumItem(id: string): ShopItemEntry {
	const item: CosmeticItemResponse = {
		id,
		type: 'avatar_decoration',
		name: `Item ${id}`,
		description: null,
		asset: `hash${id}`,
		availability: 'premium',
	};
	return {kind: 'item', sku: `cosmetic:${id}`, item, price: null};
}

describe('PremiumCompareTable', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let renders = 0;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		catalog.itemEntries = [premiumItem('1')];
		catalog.packageEntries = [pack(1, price(499)), pack(3, price(1299)), pack(12, price(4999, 3999))];
		catalog.settings = {premium_discount_percent: 30, usd_to_azn_rate_micro: 1700000};
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.useRealTimers();
	});

	// The stores here are plain objects, so each render mounts afresh instead of waiting for a MobX reaction.
	const render = () => act(() => root.render(createElement(PremiumCompareTable, {key: ++renders})));
	const row = (label: string) =>
		[...container.querySelectorAll('tbody tr')].find(
			(tr) => tr.querySelector('th[scope="row"]')?.firstChild?.textContent === label,
		);
	const cells = (label: string) => [...row(label)!.querySelectorAll('td')].map((td) => td.textContent);

	it('is one table with a group heading per group and counts the rows in its heading', () => {
		render();

		const table = container.querySelector('table')!;
		expect(container.querySelector('h2')?.textContent).toBe('16 things change with sanalyer Plus');
		expect(table.getAttribute('aria-labelledby')).toBe(container.querySelector('h2')?.id);
		expect([...table.querySelectorAll('th[scope="rowgroup"]')].map((th) => th.textContent)).toEqual([
			'Appearance',
			'Chat and media',
			'Voice and video',
			'Communities',
			'Other',
		]);
		expect(table.querySelectorAll('th[scope="row"]')).toHaveLength(16);
		expect(row('Custom username tag')).toBeUndefined();
	});

	it('heads the columns with Free at 0.00 AZN and premium from its lowest price, recommended', () => {
		render();

		const heads = [...container.querySelectorAll('thead th')].map((th) => th.textContent);
		expect(heads).toEqual(['Pricing and features', 'Free0.00 AZN', 'sanalyer PlusFrom 8.48 AZN']);
		expect(container.querySelector('[data-flx="premium.premium-compare-table.ribbon"]')?.textContent).toBe(
			'Recommended',
		);

		// A campaign that puts the yearly package under the monthly one moves the start price.
		catalog.packageEntries = [pack(1, price(499)), pack(12, price(4999, 399))];
		render();
		expect(container.querySelector('thead th:last-child')?.textContent).toBe('sanalyer PlusFrom 6.78 AZN');
	});

	it('drops an ended campaign from the start price, also while the page is open, on the catalog clock alone', () => {
		vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']});
		runInAction(() => clock.set(Date.now()));
		const endsAt = new Date(Date.now() + DAY_MS).toISOString();
		catalog.packageEntries = [pack(1, price(499)), pack(12, {...price(4999, 399), campaign_ends_at: endsAt})];
		render();
		expect(container.querySelector('thead th:last-child')?.textContent).toBe('sanalyer PlusFrom 6.78 AZN');
		expect(vi.getTimerCount()).toBe(0);

		act(() => runInAction(() => clock.set(Date.now() + DAY_MS + 1)));
		expect(container.querySelector('thead th:last-child')?.textContent).toBe('sanalyer PlusFrom 8.48 AZN');
	});

	it('leaves the prices out when nothing is on sale', () => {
		catalog.packageEntries = [];
		render();

		expect([...container.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
			'Pricing and features',
			'Free',
			'sanalyer Plus',
		]);
	});

	it('writes a check or a cross with words for screen readers, and values as text', () => {
		render();

		expect(cells('Profile badge')).toEqual(['No', 'Yes']);
		expect(row('Profile badge')!.querySelectorAll('td svg[aria-hidden="true"]')).toHaveLength(2);
		expect(cells('Message character limit')).toEqual(['2,000', '4,000']);
		expect(cells('Community boosts')).toEqual(['0', '2']);
	});

	it('puts the Beta chip beside the feature name', () => {
		render();

		expect(row('Saved media')!.querySelector('th [data-flx="premium.premium-compare-table.beta"]')?.textContent).toBe(
			'Beta',
		);
		expect(row('Message character limit')!.querySelector('[data-flx="premium.premium-compare-table.beta"]')).toBeNull();
		expect(container.textContent).toContain('Features marked Beta are still being tried out.');
	});

	it('follows the catalog for included decorations and the shop discount', () => {
		catalog.itemEntries = [];
		catalog.settings = {premium_discount_percent: 0, usd_to_azn_rate_micro: 1700000};
		render();

		expect(row('Plus decorations')).toBeUndefined();
		expect(row('Special discounts in the shop')).toBeUndefined();
		expect(container.querySelector('h2')?.textContent).toBe('14 things change with sanalyer Plus');
	});
});

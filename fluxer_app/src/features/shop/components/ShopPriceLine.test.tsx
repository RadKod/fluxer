// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ShopItemEntry, ShopPackageEntry} from '@app/features/shop/utils/ShopEntries';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {ShopPriceResponse, ShopSettingsResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

function interpolate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	return descriptor.message.replace(/{(\w+)}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

const NOW = Date.parse('2026-09-28T20:00:00.000Z');
const state = vi.hoisted(() => ({
	settings: null as ShopSettingsResponse | null,
	premiumDiscount: false,
	owned: new Set<string>(),
	premiumUser: false,
}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {locale: 'en-US', _: interpolate}}),
	Trans: ({children}: {children: React.ReactNode}) => children,
}));
vi.mock('@app/features/user/utils/LocaleUtils', () => ({getCurrentLocale: () => 'en-US'}));
vi.mock('@app/features/shop/state/ShopCatalog', () => ({
	default: {
		get settings() {
			return state.settings;
		},
		get premiumDiscount() {
			return state.premiumDiscount;
		},
		now: () => NOW,
	},
}));
vi.mock('@app/features/cosmetics/state/Cosmetics', () => ({
	default: {getItem: (id: string) => (state.owned.has(id) ? {id, owned: true} : null), equippedId: () => null},
}));
// A trial account may wear premium items but pays the list price: the price line never asks the user.
vi.mock('@app/features/user/state/Users', () => ({default: {currentUser: {isPremium: () => state.premiumUser}}}));
vi.mock('@app/features/shop/components/ShopCountdown', () => ({
	ShopCountdown: ({endsAt, className}: {endsAt: string; className?: string}) =>
		createElement('span', {'data-countdown': endsAt, className}),
}));

const {ShopPriceLine} = await import('@app/features/shop/components/ShopPriceLine');

const SETTINGS: ShopSettingsResponse = {
	premium_sales_open: true,
	item_sales_open: true,
	premium_discount_percent: 30,
	usd_to_azn_rate: '1.7000',
	usd_to_azn_rate_micro: 1700000,
	try_to_azn_rate_micro: null,
};
const PRICE: ShopPriceResponse = {
	base_usd_cents: 500,
	campaign_percent: null,
	campaign_ends_at: null,
	sale_usd_cents: 500,
	premium_usd_cents: 350,
};
const CAMPAIGN: ShopPriceResponse = {...PRICE, campaign_percent: 20, sale_usd_cents: 400, premium_usd_cents: 280};
const ENDS_AT = new Date(NOW + 2 * 86_400_000).toISOString();

function itemEntry(
	price: ShopPriceResponse | null,
	availability: CosmeticItemResponse['availability'] = 'owned',
): ShopItemEntry {
	return {
		kind: 'item',
		sku: 'cosmetic:11',
		item: {id: '11', type: 'avatar_ultra', name: 'Yitik Melek', description: null, asset: 'hash11', availability},
		price,
	};
}

function packageEntry(price: ShopPriceResponse): ShopPackageEntry {
	return {kind: 'package', sku: 'premium:3', months: 3, price};
}

describe('ShopPriceLine', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		state.settings = SETTINGS;
		state.premiumDiscount = false;
		state.owned = new Set();
		state.premiumUser = false;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = (entry: ShopItemEntry | ShopPackageEntry, size: 'card' | 'dialog' = 'dialog') =>
		act(() => root.render(createElement(ShopPriceLine, {entry, size})));
	const part = (name: string) =>
		container.querySelector(`[data-flx="shop.shop-price-line.${name}"]`)?.textContent ?? null;
	const countdown = () => container.querySelector('[data-countdown]')?.getAttribute('data-countdown') ?? null;

	it('uses the viewer discount for the primary TL price in the dialog', () => {
		state.settings = {...SETTINGS, try_to_azn_rate_micro: 34000};
		render(itemEntry(PRICE));
		expect(part('final')).toBe('250 TLPayable: 8.50 AZN');
		expect(part('premium')).toBe('175 TL with Micup Plus');
		expect(container.querySelectorAll('[data-flx="shop.shop-price.payable"]')).toHaveLength(1);
		expect(part('was')).toBeNull();

		state.premiumDiscount = true;
		render(itemEntry({...PRICE}));
		expect(part('final')).toBe('175 TLPayable: 5.95 AZN');
		expect(part('was')).toBe('250 TL');
		expect(part('premium')).toBeNull();
	});

	// The card keeps one row; the AZN amount and the Plus price are in the dialog.
	it('uses the viewer discount for the primary TL price on the card, on one row', () => {
		state.settings = {...SETTINGS, try_to_azn_rate_micro: 34000};
		render(itemEntry(PRICE), 'card');
		expect(part('final')).toBe('250 TL');
		expect(part('premium')).toBeNull();
		expect(container.querySelector('[data-flx="shop.shop-price.payable"]')).toBeNull();

		state.premiumDiscount = true;
		render(itemEntry({...PRICE}), 'card');
		expect(part('final')).toBe('175 TL');
		expect(part('was')).toBe('250 TL');
	});

	it('normal: the price and a muted premium line; a member sees the premium price over the struck price', () => {
		render(itemEntry(PRICE));
		expect(part('final')).toBe('8.50 AZN');
		expect(part('was')).toBeNull();
		expect(part('premium')).toBe('5.95 AZN with Micup Plus');

		state.premiumDiscount = true;
		render(itemEntry({...PRICE}));
		expect(part('final')).toBe('5.95 AZN');
		expect(part('was')).toBe('8.50 AZN');
		expect(part('premium')).toBeNull();
	});

	it('a trial account that may wear premium items still sees the non-member prices', () => {
		state.premiumUser = true;
		render(itemEntry(PRICE));
		expect(part('final')).toBe('8.50 AZN');
		expect(part('premium')).toBe('5.95 AZN with Micup Plus');
	});

	it('campaign: the sale price, the struck price and the badge; a member pays the premium price', () => {
		render(itemEntry(CAMPAIGN));
		expect(part('final')).toBe('6.80 AZN');
		expect(part('was')).toBe('8.50 AZN');
		expect(part('badge')).toBe('-20%');
		expect(part('premium')).toBe('4.76 AZN with Micup Plus');
		expect(countdown()).toBeNull();

		state.premiumDiscount = true;
		render(itemEntry({...CAMPAIGN}));
		expect(part('final')).toBe('4.76 AZN');
		expect(part('was')).toBe('8.50 AZN');
		expect(part('badge')).toBe('-20%');
		expect(part('premium')).toBeNull();
	});

	it('campaign with an end adds the countdown for both columns', () => {
		render(itemEntry({...CAMPAIGN, campaign_ends_at: ENDS_AT}));
		expect(countdown()).toBe(ENDS_AT);
		state.premiumDiscount = true;
		render(itemEntry({...CAMPAIGN, campaign_ends_at: ENDS_AT}));
		expect(countdown()).toBe(ENDS_AT);
	});

	it('premium discount 0: no premium line, and a member sees the plain price', () => {
		const price = {...PRICE, premium_usd_cents: null};
		render(itemEntry(price));
		expect(part('final')).toBe('8.50 AZN');
		expect(part('premium')).toBeNull();

		state.premiumDiscount = true;
		render(itemEntry({...price}));
		expect(part('final')).toBe('8.50 AZN');
		expect(part('was')).toBeNull();
	});

	it('a premium-included item says so instead of a price', () => {
		render(itemEntry(null, 'premium'));
		expect(part('note')).toBe('Included in Plus');
		expect(part('final')).toBeNull();
	});

	it('an owned item has no price lines', () => {
		state.owned = new Set(['11']);
		render(itemEntry(PRICE));
		expect(container.textContent).toBe('');
	});

	it('closed item sales say Not on sale', () => {
		state.settings = {...SETTINGS, item_sales_open: false};
		render(itemEntry(PRICE));
		expect(part('note')).toBe('Not on sale');
		expect(part('final')).toBeNull();
	});

	it('a package shows the campaign and the countdown but never a premium line, even to a member', () => {
		state.premiumDiscount = true;
		render(packageEntry({...CAMPAIGN, premium_usd_cents: null, campaign_ends_at: ENDS_AT}));
		expect(part('final')).toBe('6.80 AZN');
		expect(part('was')).toBe('8.50 AZN');
		expect(part('badge')).toBe('-20%');
		expect(part('premium')).toBeNull();
		expect(countdown()).toBe(ENDS_AT);
	});

	it.each([undefined, null])(
		'keeps catalog prices visible when an older server sends the decimal USD rate with micro %s',
		(rate) => {
			state.settings = {...SETTINGS, usd_to_azn_rate_micro: rate};
			render(itemEntry(PRICE));
			expect(part('final')).toBe('8.50 AZN');
			expect(part('premium')).toBe('5.95 AZN with Micup Plus');
		},
	);

	it('renders only AZN when the effective TL rate is absent', () => {
		render(itemEntry(PRICE));
		expect(part('final')).toBe('8.50 AZN');
		expect(container.textContent).not.toMatch(/USD|\$|TRY|₺/);
		expect(container.querySelector('[data-flx="shop.shop-price.payable"]')).toBeNull();
	});

	it.each(['', 'invalid', '0', '-1', 'Infinity'])('hides prices for invalid legacy rate %s', (rate) => {
		state.settings = {...SETTINGS, usd_to_azn_rate_micro: undefined, usd_to_azn_rate: rate};
		render(itemEntry(PRICE));
		expect(part('final')).toBe('');
	});

	it('drops a campaign that ended on the client and draws the normal prices', () => {
		render(itemEntry({...CAMPAIGN, campaign_ends_at: new Date(NOW - 60_000).toISOString()}));
		expect(part('final')).toBe('8.50 AZN');
		expect(part('was')).toBeNull();
		expect(part('badge')).toBeNull();
		expect(part('premium')).toBe('5.95 AZN with Micup Plus');
		expect(countdown()).toBeNull();
	});
});

// The shelf card: one row with the price the viewer pays, the struck list price and the sale; nothing under it.
describe('ShopPriceLine card', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		state.settings = SETTINGS;
		state.premiumDiscount = false;
		state.owned = new Set();
		state.premiumUser = false;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = (entry: ShopItemEntry | ShopPackageEntry) =>
		act(() => root.render(createElement(ShopPriceLine, {entry, size: 'card'})));
	const part = (name: string) =>
		container.querySelector(`[data-flx="shop.shop-price-line.${name}"]`)?.textContent ?? null;
	const lines = () => container.querySelector('[data-flx="shop.shop-price-line.price-line"]')?.children.length ?? 0;

	it('a non-member sees the sale price alone', () => {
		render(itemEntry(PRICE));
		expect(part('final')).toBe('8.50 AZN');
		expect(part('was')).toBeNull();
		expect(part('premium')).toBeNull();
		expect(lines()).toBe(1);
	});

	it('a member sees the member price over the struck list price', () => {
		state.premiumDiscount = true;
		render(itemEntry(PRICE));
		expect(part('final')).toBe('5.95 AZN');
		expect(part('was')).toBe('8.50 AZN');
		expect(lines()).toBe(1);
	});

	it('campaign: sale price, struck price and the sale on one row, no countdown', () => {
		render(itemEntry({...CAMPAIGN, campaign_ends_at: ENDS_AT}));
		expect(part('final')).toBe('6.80 AZN');
		expect(part('was')).toBe('8.50 AZN');
		expect(part('badge')).toBe('-20%');
		expect(container.querySelector('[data-flx="shop.shop-price-line.badge"]')?.parentElement).toBe(
			container.querySelector('[data-flx="shop.shop-price-line.row"]'),
		);
		expect(container.querySelector('[data-countdown]')).toBeNull();
		expect(lines()).toBe(1);
	});

	it('a trial account that may wear premium items still sees the list price', () => {
		state.premiumUser = true;
		render(itemEntry(PRICE));
		expect(part('final')).toBe('8.50 AZN');
		expect(part('was')).toBeNull();
	});

	it('Owned, Included in Plus and Not on sale take the price row', () => {
		state.owned = new Set(['11']);
		render(itemEntry(PRICE));
		expect(part('status')).toBe('Owned');
		expect(part('final')).toBeNull();
		expect(lines()).toBe(1);

		state.owned = new Set();
		render(itemEntry(null, 'premium'));
		expect(part('status')).toBe('Included in Plus');

		state.settings = {...SETTINGS, item_sales_open: false};
		render(itemEntry(PRICE));
		expect(part('status')).toBe('Not on sale');
		expect(part('final')).toBeNull();
	});

	it('a package shows the campaign on one row', () => {
		state.premiumDiscount = true;
		render(packageEntry({...CAMPAIGN, premium_usd_cents: null, campaign_ends_at: ENDS_AT}));
		expect(part('final')).toBe('6.80 AZN');
		expect(part('badge')).toBe('-20%');
		expect(container.querySelector('[data-countdown]')).toBeNull();
	});
});

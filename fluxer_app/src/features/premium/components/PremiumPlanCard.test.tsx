// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ShopPackageEntry} from '@app/features/shop/utils/ShopEntries';
import type {ShopPriceResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {setupI18n} from '@lingui/core';
import {observable, runInAction} from 'mobx';
import {act, createElement, type ReactElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const DAY_MS = 24 * 60 * 60 * 1000;
const i18n = setupI18n({locale: 'en', messages: {en: {}}});
const catalog = vi.hoisted(() => ({
	settings: {premium_sales_open: true, item_sales_open: true, premium_discount_percent: 0},
	// The catalog's shared clock (ShopCatalog.now reads an observable that moves when a campaign ends).
	now: () => clock.get(),
	packageEntries: [] as Array<ShopPackageEntry>,
}));
const modalCommands = vi.hoisted(() => ({push: vi.fn(), modal: (render: () => unknown) => render}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n}),
	Trans: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/shop/state/ShopCatalog', () => ({default: catalog}));
vi.mock('@app/features/ui/commands/ModalCommands', () => modalCommands);
vi.mock('@app/features/shop/components/ShopCountdown', () => ({
	ShopCountdown: ({endsAt, size}: {endsAt: string; size: string}) => (
		<span
			data-testid="countdown"
			data-ends-at={endsAt}
			data-size={size}
			data-flx="premium.premium-plan-card-test.countdown"
		/>
	),
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick, variant}: {children: ReactNode; onClick?: () => void; variant?: string}) => (
		<button
			type="button"
			onClick={onClick}
			data-variant={variant ?? 'primary'}
			data-flx="premium.premium-plan-card-test.button.click"
		>
			{children}
		</button>
	),
}));
// Only the pushed dialog's type is checked; the real buy dialog loads the app runtime.
vi.mock('@app/features/shop/components/modals/ShopCheckoutModal', () => ({ShopCheckoutModal: () => null}));

const {PremiumPlanCard} = await import('@app/features/premium/components/PremiumPlanCard');
const {ShopCheckoutModal} = await import('@app/features/shop/components/modals/ShopCheckoutModal');

function price(base: number, campaign?: {percent: number; endsAt: string | null}): ShopPriceResponse {
	return {
		base_try_minor: base,
		campaign_percent: campaign?.percent ?? null,
		campaign_ends_at: campaign?.endsAt ?? null,
		sale_try_minor: campaign ? Math.round((base * (100 - campaign.percent)) / 100) : base,
		premium_try_minor: null,
	};
}

function pack(months: 1 | 3 | 12, packagePrice: ShopPriceResponse): ShopPackageEntry {
	return {kind: 'package', sku: `premium:${months}`, months, price: packagePrice};
}

const clock = observable.box(Date.now());
const moveClock = (to: number) => act(() => runInAction(() => clock.set(to)));

describe('PremiumPlanCard', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let renders = 0;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']});
		vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
		runInAction(() => clock.set(Date.now()));
		catalog.settings = {premium_sales_open: true, item_sales_open: true, premium_discount_percent: 0};
		modalCommands.push.mockClear();
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.useRealTimers();
	});

	const render = (entry: ShopPackageEntry, {recommended = false, isPremium = false} = {}) =>
		act(() => root.render(createElement(PremiumPlanCard, {key: ++renders, entry, recommended, isPremium})));
	const text = (flx: string) => container.querySelector(`[data-flx="premium.premium-plan-card.${flx}"]`)?.textContent;
	const button = () => container.querySelector('button')!;

	it('shows the monthly price, the daily price, the package total and two perks', () => {
		render(pack(3, price(44999)));

		expect(text('title')).toBe('3 months');
		expect(text('price')).toBe('₺150 a month≈ ₺5 a day₺449.99 in total');
		expect(container.textContent).not.toMatch(/AZN|USD|\$/);

		expect(
			[...container.querySelectorAll('[data-flx="premium.premium-plan-card.perk"]')].map((li) => li.textContent),
		).toEqual(['All sanalyer Plus perks', 'Does not renew']);
	});

	it('shows the monthly and daily price on the one month plan, without a separate total', () => {
		render(pack(1, price(14999)));

		expect(text('price')).toBe('₺149.99 a month≈ ₺5 a day');
	});

	it('shows the campaign badge, the struck price and the countdown', () => {
		const endsAt = new Date(Date.now() + 2 * DAY_MS).toISOString();
		render(pack(12, price(150000, {percent: 20, endsAt})));

		expect(text('price')).toBe('₺100 a month≈ ₺3.33 a day₺1,200 in total');
		expect(container.querySelector('s')?.textContent).toContain('₺125');
		expect(text('discount')).toBe('-20%');

		const countdown = container.querySelector('[data-testid="countdown"]');
		expect(countdown?.getAttribute('data-ends-at')).toBe(endsAt);
		expect(countdown?.getAttribute('data-size')).toBe('card');
	});

	it('drops the campaign once its end passes, also while the page is open, on the catalog clock alone', () => {
		render(pack(12, price(150000, {percent: 20, endsAt: new Date(Date.now() + 2 * DAY_MS).toISOString()})));
		expect(container.querySelector('s')).not.toBeNull();
		// No timer of its own: the catalog runs one for every card.
		expect(vi.getTimerCount()).toBe(0);

		moveClock(Date.now() + 2 * DAY_MS + 1);

		expect(text('price')).toBe('₺125 a month≈ ₺4.17 a day₺1,500 in total');
		expect(container.querySelector('s')).toBeNull();
		expect(text('discount')).toBeUndefined();
		expect(container.querySelector('[data-testid="countdown"]')).toBeNull();
	});

	it('says in green what a month of the package saves against the monthly plan', () => {
		catalog.packageEntries = [pack(1, price(500)), pack(3, price(1350))];
		render(catalog.packageEntries[1]);
		expect(text('savings')).toBe('Save 10% vs the monthly plan');
		render(catalog.packageEntries[0]);
		expect(text('savings')).toBeUndefined();
		catalog.packageEntries = [];
	});

	it('keeps the campaign badge and the saving apart when both show', () => {
		const endsAt = new Date(Date.now() + 2 * DAY_MS).toISOString();
		catalog.packageEntries = [pack(1, price(500)), pack(3, price(1500, {percent: 20, endsAt}))];
		render(catalog.packageEntries[1]);
		expect(text('discount')).toBe('-20%');
		expect(text('discount-label')).toBe('Discount -20%');
		expect(text('savings')).toBe('Save 20% vs the monthly plan');
		catalog.packageEntries = [];
	});

	it('puts the recommended plan in a ribbon and a halo, every plan buys on the accent button', () => {
		render(pack(3, price(1299)), {recommended: true});
		expect(text('ribbon')).toBe('Recommended');
		expect(container.querySelector('[data-flx="premium.premium-halo.halo"] button')).not.toBeNull();
		expect(button().getAttribute('data-variant')).toBe('primary');

		render(pack(1, price(499)));
		expect(text('ribbon')).toBeUndefined();
		expect(container.querySelector('[data-flx="premium.premium-halo.halo"]')).toBeNull();
		expect(button().getAttribute('data-variant')).toBe('primary');
	});

	it('says Süre ekle for a premium member and Satın al otherwise', () => {
		render(pack(1, price(499)));
		expect(button().textContent).toBe('Purchase');

		render(pack(1, price(499)), {isPremium: true});
		expect(button().textContent).toBe('Add time');
	});

	it('opens the checkout in premium mode with the package selected', () => {
		render(pack(3, price(1299)), {recommended: true});

		act(() => button().click());

		expect(modalCommands.push).toHaveBeenCalledTimes(1);
		const dialog = (modalCommands.push.mock.calls[0][0] as () => ReactElement<{target: unknown}>)();
		expect(dialog.type).toBe(ShopCheckoutModal);
		expect(dialog.props.target).toEqual({kind: 'premium', months: 3});
	});
});

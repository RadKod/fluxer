// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ShopPackageEntry} from '@app/features/shop/utils/ShopEntries';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {ShopPriceResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {setupI18n} from '@lingui/core';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface FakeUser {
	premiumType: number | null;
	isPremium: () => boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const i18n = setupI18n({locale: 'en', messages: {en: {}}});
const catalog = vi.hoisted(() => ({
	settings: {premium_sales_open: true, usd_to_azn_rate: '1.7000'} as {
		premium_sales_open: boolean;
		usd_to_azn_rate: string;
	} | null,
	packageEntries: [] as Array<ShopPackageEntry>,
	now: () => Date.now(),
}));
const users = vi.hoisted(() => ({currentUser: null as FakeUser | null}));
const modalCommands = vi.hoisted(() => ({push: vi.fn(), modal: (render: () => unknown) => render}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n}),
	Trans: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/shop/state/ShopCatalog', () => ({default: catalog}));
vi.mock('@app/features/user/state/Users', () => ({default: users}));
vi.mock('@app/features/ui/commands/ModalCommands', () => modalCommands);
vi.mock('@app/features/user/utils/LocaleUtils', () => ({getCurrentLocale: () => 'en'}));
vi.mock('@app/features/shop/components/ShopCountdown', () => ({
	ShopCountdown: ({endsAt, size}: {endsAt: string; size: string}) => (
		<span
			data-testid="countdown"
			data-ends-at={endsAt}
			data-size={size}
			data-flx="premium.premium-packages-test.countdown"
		/>
	),
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick, disabled}: {children: ReactNode; onClick?: () => void; disabled?: boolean}) => (
		<button type="button" onClick={onClick} disabled={disabled} data-flx="premium.premium-packages-test.button.click">
			{children}
		</button>
	),
}));
// Only the pushed dialog's type is checked; the real buy dialog loads the app runtime.
vi.mock('@app/features/shop/components/modals/ShopCheckoutModal', () => ({ShopCheckoutModal: () => null}));
// The button has its own test (ShopRedeemField.test.tsx); here it only shows where the notice points it.
vi.mock('@app/features/shop/components/ShopRedeemField', () => ({
	ShopRedeemJumpButton: ({inputId}: {inputId: string}) => (
		<button type="button" data-testid="jump" data-input={inputId} data-flx="premium.premium-packages-test.jump">
			Redeem a code
		</button>
	),
}));

const {PremiumPackages} = await import('@app/features/premium/components/PremiumPackages');

function price(base: number, campaign?: {percent: number; endsAt: string | null}): ShopPriceResponse {
	return {
		base_usd_cents: base,
		campaign_percent: campaign?.percent ?? null,
		campaign_ends_at: campaign?.endsAt ?? null,
		sale_usd_cents: campaign ? Math.round((base * (100 - campaign.percent)) / 100) : base,
		premium_usd_cents: null,
	};
}

function pack(months: 1 | 3 | 12, packagePrice: ShopPriceResponse): ShopPackageEntry {
	return {kind: 'package', sku: `premium:${months}`, months, price: packagePrice};
}

const freeUser: FakeUser = {premiumType: 0, isPremium: () => false};
const premiumUser: FakeUser = {premiumType: UserPremiumTypes.SUBSCRIPTION, isPremium: () => true};
const lifetimeUser: FakeUser = {premiumType: UserPremiumTypes.LIFETIME, isPremium: () => true};

describe('PremiumPackages', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let renders = 0;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']});
		vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
		catalog.settings = {premium_sales_open: true, usd_to_azn_rate: '1.7000'};
		catalog.packageEntries = [
			pack(1, price(500)),
			pack(3, price(1200)),
			pack(12, price(5000, {percent: 20, endsAt: new Date(Date.now() + 2 * DAY_MS).toISOString()})),
		];
		users.currentUser = freeUser;
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

	// The stores here are plain objects, so each render mounts afresh instead of waiting for a MobX reaction.
	const render = () =>
		act(() => root.render(createElement(PremiumPackages, {key: ++renders, codeInputId: 'code-field'})));
	const cards = () => [...container.querySelectorAll<HTMLElement>('[data-flx="premium.premium-plan-card.card"]')];
	const title = (el: HTMLElement) => el.querySelector('[data-flx="premium.premium-plan-card.title"]')?.textContent;
	const recommended = () =>
		cards()
			.filter((el) => el.querySelector('[data-flx="premium.premium-plan-card.ribbon"]'))
			.map(title);

	it('recommends the 3 month package and none without one', () => {
		render();
		expect(cards().map(title)).toEqual(['1 month', '3 months', '12 months']);
		expect(recommended()).toEqual(['3 months']);

		catalog.packageEntries = [pack(1, price(500)), pack(12, price(4000))];
		render();
		expect(recommended()).toEqual([]);
	});

	it('says Süre ekle for a premium member and Satın al otherwise', () => {
		render();
		expect(cards().map((el) => el.querySelector('button')?.textContent)).toEqual(['Purchase', 'Purchase', 'Purchase']);
		expect(container.textContent).toContain('One-time payment. It does not renew.');
		expect(container.textContent).not.toContain('Time is added on top of what you have left.');

		users.currentUser = premiumUser;
		render();
		expect(cards().map((el) => el.querySelector('button')?.textContent)).toEqual(['Add time', 'Add time', 'Add time']);
		expect(container.textContent).toContain('Time is added on top of what you have left.');
	});

	it('draws the plans in the section the page scrolls to and watches', () => {
		const ref = {current: null as HTMLDivElement | null};
		act(() =>
			root.render(createElement(PremiumPackages, {key: ++renders, sectionRef: ref, codeInputId: 'code-field'})),
		);

		expect(ref.current?.querySelectorAll('button')).toHaveLength(3);
	});

	it('no packages for a lifetime account', () => {
		users.currentUser = lifetimeUser;
		render();

		expect(container.innerHTML).toBe('');
	});

	it('an info box instead of packages when premium sales are closed, pointing at the page’s code field', () => {
		catalog.settings = {premium_sales_open: false, usd_to_azn_rate: '1.7000'};
		render();

		expect(cards()).toHaveLength(0);
		expect(container.textContent).toContain('Micup Plus sales are paused right now.');
		expect(container.textContent).toContain('If you have a key, you can redeem it below.');
		const jump = container.querySelector<HTMLElement>(
			'[data-flx="premium.premium-packages.notice"] [data-testid="jump"]',
		);
		expect(jump?.dataset.input).toBe('code-field');
	});
});

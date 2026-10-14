// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import type {ShopCheckoutTarget} from '@app/features/shop/components/modals/ShopCheckoutModal';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {ShopOrderResponse, ShopQuoteResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Turkish comes from the shipped catalog; the shop's new lines are not extracted yet (task I1), so until then the
// design's Turkish  stands in, and a drifted translation fails here once it ships.
const TR_CATALOG = readFileSync('src/features/i18n/locales/tr/messages.po', 'utf8');
const TR_DESIGN: Record<string, string> = {
	'{price} a month': 'Aylık {price}',
	'≈ {price} a day': 'Günde ≈ {price}',
	'{price} in total': 'Toplam {price}',
	'You will pay {price}.': 'Ödenecek tutar: {price}.',
};
let locale = 'en';

function translate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	let text = descriptor.message;
	if (locale === 'tr') {
		const entry = TR_CATALOG.split(/\r?\n\r?\n/).find((block) =>
			block.includes(`msgid ${JSON.stringify(descriptor.message)}`),
		);
		const translated = entry?.match(/^msgstr (".*")\r?$/m);
		text = translated && translated[1] !== '""' ? JSON.parse(translated[1]) : (TR_DESIGN[text] ?? text);
	}
	return text
		.replace(/\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g, (_, key: string, one: string, other: string) =>
			(values[key] === 1 ? one : other).replace('#', String(values[key])),
		)
		.replace(/\{(\w+)\}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

const i18n = {
	get locale() {
		return locale;
	},
	_: translate,
};
const Passthrough = ({children}: {children?: ReactNode}) => children;
const flow = vi.hoisted(() => ({
	state: 'ready' as string,
	quote: null as unknown,
	order: null as unknown,
	failureMessage: null as string | null,
	waitMinutes: null as number | null,
	checking: false,
	success: null as unknown,
	item: null as unknown,
	bundle: null as unknown,
	start: vi.fn(),
	openPaymentPage: vi.fn(),
	retry: vi.fn(),
	checkAgain: vi.fn(),
	equip: vi.fn(),
}));
const useShopCheckout = vi.hoisted(() => vi.fn());
const NOW = Date.parse('2026-09-28T20:00:00.000Z');
const catalog = vi.hoisted(() => ({
	settings: {premium_discount_percent: 30},
	entryForSku: vi.fn(),
	packageEntries: [] as Array<unknown>,
	now: (): number => 0,
}));
const users = vi.hoisted(() => ({currentUser: null as unknown}));
const nativeUtils = vi.hoisted(() => ({isDesktop: vi.fn(() => false), openExternalUrl: vi.fn()}));
const textCopy = vi.hoisted(() => ({copy: vi.fn()}));
const cosmetics = vi.hoisted(() => ({getItem: vi.fn(), load: vi.fn()}));

const modalCommands = vi.hoisted(() => ({
	pop: vi.fn(),
	popByType: vi.fn(),
	push: vi.fn(),
	modal: (render: unknown) => render,
}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n}), Trans: Passthrough}));
vi.mock('@app/features/app/components/dialogs/Modal', () => ({
	Root: Passthrough,
	Header: ({title}: {title: ReactNode}) => <h2 data-flx="shop.shop-checkout-modal-test.header">{title}</h2>,
	Content: Passthrough,
	Footer: Passthrough,
}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {useReducedMotion: true}}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: Passthrough}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({
	Tooltip: ({text, children}: {text: () => ReactNode; children: ReactNode}) => (
		<>
			{children}
			<span role="tooltip" data-flx="shop.shop-checkout-modal-test.tooltip">
				{text()}
			</span>
		</>
	),
}));
vi.mock('@app/features/shop/hooks/useShopCheckout', () => ({useShopCheckout}));
vi.mock('@app/features/shop/state/ShopCatalog', () => ({default: catalog}));
vi.mock('@app/features/shop/components/ShopItemStage', () => ({
	ShopItemStage: ({items}: {items: Array<CosmeticItemResponse>}) => (
		<div data-stage={items.map((item) => item.id).join(',')} data-flx="shop.shop-checkout-modal-test.stage" />
	),
}));
vi.mock('@app/features/shop/components/modals/ShopItemDetailModal', () => ({ShopItemDetailModal: () => null}));
vi.mock('@app/features/shop/components/modals/ShopBundleDetailModal', () => ({ShopBundleDetailModal: () => null}));
vi.mock('@app/features/user/state/Users', () => ({default: users}));
vi.mock('@app/features/cosmetics/state/Cosmetics', () => ({default: cosmetics}));
vi.mock('@app/features/ui/utils/NativeUtils', () => nativeUtils);
vi.mock('@app/features/ui/commands/TextCopyCommands', () => textCopy);
vi.mock('@app/features/ui/commands/ModalCommands', () => modalCommands);
vi.mock('@app/features/user/components/modals/UserSettingsModal', () => ({UserSettingsModal: () => null}));
vi.mock('@app/features/shop/components/ShopEquippedSuccess', () => ({ShopEquippedSuccess: () => null}));
vi.mock('@app/features/user/utils/DateFormatting', () => ({getFormattedFullDate: () => '28 December 2026'}));

const {ShopCheckoutModal} = await import('@app/features/shop/components/modals/ShopCheckoutModal');
const {ShopBundleDetailModal} = await import('@app/features/shop/components/modals/ShopBundleDetailModal');
const {UserSettingsModal} = await import('@app/features/user/components/modals/UserSettingsModal');
const {default: styles} = await import('@app/features/shop/components/modals/ShopCheckoutModal.module.css');

const ITEM = {
	id: '5',
	type: 'avatar_ultra',
	name: 'Yitik Melek',
	description: null,
	asset: 'a_1',
	availability: 'owned',
} as CosmeticItemResponse;
const bundleItem = (id: string, type: string) =>
	({
		id,
		type,
		name: `item ${id}`,
		description: null,
		asset: `hash${id}`,
		availability: 'owned',
	}) as CosmeticItemResponse;
const BUNDLE = {name: 'Gece seti', items: [bundleItem('1', 'avatar_decoration'), bundleItem('2', 'profile_effect')]};
const quoteFor = (sku: string, fields: Partial<ShopQuoteResponse> = {}): ShopQuoteResponse => ({
	sku,
	base_try_minor: 500,
	campaign_percent: 0,
	premium_percent: 0,
	final_try_minor: 500,
	currency: 'TRY',
	...fields,
});
const ORDER: ShopOrderResponse = {
	...quoteFor('cosmetic:5'),
	id: '1300000000000000900',
	status: 'pending',
	failure_reason: null,
	payment_url: 'https://pay.payriff.com/pay/900',
	created_at: '2026-09-28T20:00:00.000Z',
};
const packagePrice = (cents: number, campaign: number | null = null) => ({
	base_try_minor: cents,
	campaign_percent: campaign,
	campaign_ends_at: null,
	sale_try_minor: campaign ? Math.round((cents * (100 - campaign)) / 100) : cents,
	premium_try_minor: null,
});
const userWith = (fields: {verified?: boolean; claimed?: boolean; premium?: boolean}) => ({
	verified: fields.verified ?? true,
	isClaimed: () => fields.claimed ?? true,
	isPremium: () => fields.premium ?? false,
	premiumUntil: null,
	premiumLifetimeSequence: null,
});

describe('ShopCheckoutModal', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	const render = (target: ShopCheckoutTarget) => act(() => root.render(createElement(ShopCheckoutModal, {target})));
	const text = () => container.textContent ?? '';
	const texts = (selector: string) => [...container.querySelectorAll(selector)].map((node) => node.textContent);
	const button = (label: string) =>
		[...container.querySelectorAll('button')].find((node) => node.textContent === label) ?? null;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		locale = 'en';
		Object.assign(flow, {
			state: 'ready',
			quote: quoteFor('cosmetic:5'),
			order: null,
			failureMessage: null,
			waitMinutes: null,
			checking: false,
			success: null,
			item: ITEM,
			bundle: null,
		});
		for (const mock of [flow.start, flow.openPaymentPage, textCopy.copy, nativeUtils.openExternalUrl]) mock.mockReset();
		modalCommands.push.mockClear();
		useShopCheckout.mockReset().mockReturnValue(flow);
		nativeUtils.isDesktop.mockReturnValue(false);
		catalog.entryForSku.mockImplementation((sku: string) => {
			if (sku === 'cosmetic:5') {
				return {kind: 'item', sku, item: ITEM, price: {...packagePrice(500), premium_try_minor: 350}};
			}
			return sku === 'bundle:70' ? {kind: 'bundle', sku, price: {...packagePrice(900), premium_try_minor: 630}} : null;
		});
		catalog.packageEntries = [
			{kind: 'package', sku: 'premium:1', months: 1, price: packagePrice(500)},
			{kind: 'package', sku: 'premium:3', months: 3, price: packagePrice(1200)},
			{kind: 'package', sku: 'premium:12', months: 12, price: packagePrice(5000, 20)},
		];
		catalog.now = () => NOW;
		users.currentUser = userWith({});
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		modalCommands.pop.mockReset();
		modalCommands.popByType.mockReset();
		cosmetics.getItem.mockReset();
		cosmetics.load.mockReset();
	});

	// sanalyer: the order is charged in Turkish lira, the amount the shop shows; no second currency is explained.
	it.each(['payment_ready', 'awaiting'])('shows the persisted order total in Turkish in %s', (state) => {
		locale = 'tr';
		Object.assign(flow, {state, order: {...ORDER, final_try_minor: 14999}});
		render({kind: 'item', sku: 'cosmetic:5'});
		expect(text()).toContain('Ödenecek tutar: ₺149,99.');
		expect(text()).not.toMatch(/AZN|manat|Azerbaycan/);
		expect(flow.openPaymentPage).not.toHaveBeenCalled();
	});

	it('shows the persisted English total before opening the payment page on Continue', () => {
		Object.assign(flow, {state: 'payment_ready', order: ORDER});
		render({kind: 'item', sku: 'cosmetic:5'});
		expect(text()).toContain('You will pay ₺5.');
		expect(flow.openPaymentPage).not.toHaveBeenCalled();
		act(() => button('Continue')!.click());
		expect(flow.openPaymentPage).toHaveBeenCalledTimes(1);
	});

	it('a changed price shows the order total in the summary, without a second note', () => {
		locale = 'tr';
		Object.assign(flow, {state: 'price_changed', order: {...ORDER, base_try_minor: 15000, final_try_minor: 15000}});
		render({kind: 'item', sku: 'cosmetic:5'});
		expect(texts('dd').at(-1)).toBe('₺150');
		expect(container.querySelector('[data-flx="shop.shop-checkout-modal.payment-price-note"]')).toBeNull();
	});

	it('shows Turkish lira only, with no currency note', () => {
		locale = 'tr';
		render({kind: 'item', sku: 'cosmetic:5'});
		expect(texts('dd')).toContain('₺5');
		expect(text()).not.toMatch(/AZN|manat|Azerbaycan|USD|\$/);
	});

	it('shows the Plus hint in Turkish lira and no payable line', () => {
		render({kind: 'item', sku: 'cosmetic:5'});
		expect(texts('[data-flx="shop.shop-checkout-modal.premium-hint-text"]')).toEqual(['Plus: ₺3.50']);
		expect(container.querySelector('[data-flx="shop.shop-price.payable"]')).toBeNull();
	});

	it('lists the campaign and the premium discount from the server quote', () => {
		flow.quote = quoteFor('cosmetic:5', {
			campaign_percent: 20,
			premium_percent: 30,
			final_try_minor: 280,
		});
		render({kind: 'item', sku: 'cosmetic:5'});

		expect(texts('dt')).toEqual(['Price', 'Sale (-20%)', 'sanalyer Plus discount (-30%)', 'Total']);
		expect(texts('dd')).toEqual(['₺5', '−₺1', '−₺1.20', '₺2.80']);
		expect(container.querySelector('[data-stage="5"]')).not.toBeNull();
	});

	it('discount rows are differences of rounded levels, so they add up to the total', () => {
		flow.quote = quoteFor('cosmetic:5', {
			base_try_minor: 499,
			campaign_percent: 15,
			final_try_minor: 424,
		});
		render({kind: 'item', sku: 'cosmetic:5'});
		expect(texts('dd')).toEqual(['₺4.99', '−₺0.75', '₺4.24']);
	});

	it('lists the campaign alone when no Plus discount applies', () => {
		flow.quote = quoteFor('cosmetic:5', {
			campaign_percent: 20,
			final_try_minor: 400,
		});
		render({kind: 'item', sku: 'cosmetic:5'});
		expect(texts('dt')).toEqual(['Price', 'Sale (-20%)', 'Total']);
		expect(texts('dd')).toEqual(['₺5', '−₺1', '₺4']);
	});

	it('premium mode has 1/3/12 month choices with the incoming one selected', () => {
		flow.quote = quoteFor('premium:3', {base_try_minor: 1200, final_try_minor: 1200});
		render({kind: 'premium', months: 3});

		const radios = [...container.querySelectorAll('[role="radio"]')];
		expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
		expect(text()).toContain('1 month');
		expect(text()).toContain('₺4 a month');
		expect(text()).toContain('₺12 in total');
		expect(text()).toContain('₺40 in total');
		expect(text()).toContain('One-time payment. It does not renew.');
		expect(useShopCheckout).toHaveBeenLastCalledWith({kind: 'premium', months: 3});

		act(() => (radios[2] as HTMLElement).click());

		expect(useShopCheckout).toHaveBeenLastCalledWith({kind: 'premium', months: 12});
	});

	it('a package whose campaign has ended since the catalog was read shows its full price', () => {
		const ended = {...packagePrice(5000, 20), campaign_ends_at: new Date(NOW - 1).toISOString()};
		catalog.packageEntries = [{kind: 'package', sku: 'premium:12', months: 12, price: ended}];
		flow.quote = quoteFor('premium:12', {base_try_minor: 5000, final_try_minor: 5000});
		render({kind: 'premium', months: 12});

		expect(texts('[data-flx="shop.shop-checkout-modal.package-amount"]')).toEqual([
			'₺4.17 a month≈ ₺0.14 a day₺50 in total',
		]);
		expect(text()).not.toMatch(/AZN|USD|\$/);
		expect(container.querySelector(`.${styles.badge}`)).toBeNull();
	});

	// Micup: the shop is a page now, so no settings dialog is open under the checkout to switch tabs in.
	it('after an item is bought, "Profile decorations" closes the dialogs and opens the decorations settings', () => {
		Object.assign(flow, {state: 'approved', success: {}});
		render({kind: 'item', sku: 'cosmetic:5'});
		act(() => button('Profile decorations')!.click());

		expect(modalCommands.pop).toHaveBeenCalled();
		expect(modalCommands.push).toHaveBeenCalledTimes(1);
		const element = (modalCommands.push.mock.calls[0][0] as () => {type: unknown; props: {initialTab?: string}})();
		expect(element.type).toBe(UserSettingsModal);
		expect(element.props.initialTab).toBe('profile_cosmetics');
	});

	it('the order number is copyable', () => {
		Object.assign(flow, {state: 'awaiting', order: ORDER});
		render({kind: 'item', sku: 'cosmetic:5'});

		expect(text()).toContain('Order 1300000000000000900');
		act(() => (container.querySelector('button[aria-label="Copy"]') as HTMLButtonElement).click());

		expect(textCopy.copy).toHaveBeenCalledWith(i18n, '1300000000000000900');
	});

	it('keeps the payment page one click away while waiting: a link on the web, the system browser on desktop', () => {
		Object.assign(flow, {state: 'awaiting', order: ORDER});
		render({kind: 'item', sku: 'cosmetic:5'});

		const link = [...container.querySelectorAll('a')].find((node) => node.textContent === 'Open the payment page');
		expect(link?.getAttribute('href')).toBe(ORDER.payment_url);
		expect(link?.getAttribute('target')).toBe('_blank');
		expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
		expect(text()).toContain('The payment page opened in a new tab.');
		expect(text()).not.toMatch(/Payriff|AZN/);

		nativeUtils.isDesktop.mockReturnValue(true);
		render({kind: 'item', sku: 'cosmetic:5'});
		act(() => button('Open the payment page')!.click());

		expect(flow.openPaymentPage).toHaveBeenCalledTimes(1);
		expect(container.querySelector('a')).toBeNull();
	});

	it('never turns a payment address that is not https into a link', () => {
		Object.assign(flow, {state: 'awaiting', order: {...ORDER, payment_url: 'javascript:alert(1)'}});
		render({kind: 'item', sku: 'cosmetic:5'});

		expect(container.querySelector('a')).toBeNull();
		expect(button('Open the payment page')).toBeNull();
	});

	it('marks what changed in the price and opens the payment page only on a new click', () => {
		Object.assign(flow, {
			state: 'price_changed',
			quote: quoteFor('cosmetic:5', {campaign_percent: 20, final_try_minor: 400}),
			order: ORDER,
		});
		render({kind: 'item', sku: 'cosmetic:5'});

		expect(texts('h2')).toContain('The price changed');
		expect(texts('dd')).toEqual(['₺5', '₺5']);
		expect(texts(`.${styles.changed}`)).toEqual(['Total₺5']);
		expect(flow.openPaymentPage).not.toHaveBeenCalled();

		act(() => button('Continue at the new price')!.click());

		expect(flow.openPaymentPage).toHaveBeenCalledTimes(1);
	});

	it('Satın al is disabled with the tooltip for unverified accounts', () => {
		users.currentUser = userWith({verified: false});
		render({kind: 'item', sku: 'cosmetic:5'});

		expect(button('Purchase')?.disabled).toBe(true);
		expect(texts('[role="tooltip"]')).toEqual(['Verify your email to buy.']);
		act(() => button('Purchase')!.click());
		expect(flow.start).not.toHaveBeenCalled();

		users.currentUser = userWith({});
		render({kind: 'item', sku: 'cosmetic:5'});
		act(() => button('Purchase')!.click());

		expect(flow.start).toHaveBeenCalledTimes(1);
		expect(container.querySelector('[role="tooltip"]')).toBeNull();
	});

	it('tells a daily order limit apart from a short one', () => {
		Object.assign(flow, {state: 'busy', waitMinutes: 72});
		render({kind: 'item', sku: 'cosmetic:5'});

		expect(text()).toContain("You're being rate limited. Wait 72 minutes before trying again.");
		expect(text()).not.toContain('Try again in a few seconds.');

		Object.assign(flow, {waitMinutes: null});
		render({kind: 'item', sku: 'cosmetic:5'});

		expect(text()).toContain('Try again in a few seconds.');
	});

	describe('a bundle', () => {
		const target: ShopCheckoutTarget = {kind: 'bundle', sku: 'bundle:70'};
		const listed = () => texts('[data-flx="shop.shop-checkout-modal.bundle-item"]');

		beforeEach(() => {
			Object.assign(flow, {item: null, bundle: BUNDLE, quote: quoteFor('bundle:70', {base_try_minor: 900})});
		});

		it.each(['Okay', 'Profile decorations'])(
			'%s removes the bundle preview before the delayed ownership load finishes',
			async (label) => {
				let resolvePending!: () => void;
				const pending = {
					promise: new Promise<void>((resolve) => (resolvePending = resolve)),
					resolve: () => resolvePending(),
				};
				const owned = new Set<string>();
				cosmetics.getItem.mockImplementation((id: string) => ({owned: owned.has(id)}));
				cosmetics.load.mockImplementation(() =>
					pending.promise.then(() => BUNDLE.items.forEach(({id}) => owned.add(id))),
				);
				const loading = cosmetics.load();
				const stack: Array<unknown> = [UserSettingsModal, ShopBundleDetailModal, ShopCheckoutModal];
				modalCommands.pop.mockImplementation(() => stack.pop());
				modalCommands.popByType.mockImplementation((type) => {
					const index = stack.lastIndexOf(type);
					if (index !== -1) stack.splice(index, 1);
				});
				Object.assign(flow, {state: 'approved', success: {kind: 'bundle', items: BUNDLE.items}});
				render(target);
				act(() => button(label)!.click());
				expect(owned.size).toBe(0);
				expect(stack).toEqual([UserSettingsModal]);
				pending.resolve();
				await loading;
				expect(owned.size).toBe(BUNDLE.items.length);
				expect(stack).toEqual([UserSettingsModal]);
			},
		);

		it('canceling checkout keeps the bundle preview underneath', () => {
			render(target);
			act(() => button('Cancel')!.click());
			expect(modalCommands.pop).toHaveBeenCalledTimes(1);
			expect(modalCommands.popByType).not.toHaveBeenCalled();
		});

		it('is named in the title, worn whole on the stage, and lists what it includes', () => {
			render(target);

			expect(texts('h2')).toEqual(['Buy Gece seti']);
			expect(container.querySelector('[data-stage="1,2"]')).not.toBeNull();
			expect(text()).toContain('Includes');
			expect(listed()).toEqual(['Avatar decorationitem 1', 'Profile effectitem 2']);
			expect(text()).toContain('Plus: ₺6.30');
		});

		// the list the order froze, shown before a second click opens the payment page.
		it("shows the order's items when the bundle changed, and pays only on Continue", () => {
			Object.assign(flow, {
				state: 'contents_changed',
				order: {...ORDER, sku: 'bundle:70', item_ids: ['2', '3']},
				bundle: {name: 'Gece seti', items: [BUNDLE.items[1], bundleItem('3', 'nameplate')]},
			});
			render(target);

			expect(texts('h2')).toContain("This bundle's contents changed");
			expect(listed()).toEqual(['Profile effectitem 2', 'Nameplateitem 3']);
			expect(texts('dt')).toEqual(['Price', 'Total']);
			expect(flow.openPaymentPage).not.toHaveBeenCalled();

			act(() => button('Continue')!.click());

			expect(flow.openPaymentPage).toHaveBeenCalledTimes(1);
		});

		it('says an item of it is owned already and offers nothing to equip', () => {
			Object.assign(flow, {state: 'already_owned'});
			render(target);

			expect(texts('h2')).toContain('You already own an item in this bundle');
			expect(button('Equip')).toBeNull();
			expect(button('Close')).not.toBeNull();
		});

		it('leads to the decorations settings once bought', () => {
			Object.assign(flow, {state: 'approved', success: {}});
			render(target);

			expect(button('Profile decorations')).not.toBeNull();
		});
	});

	it('a Visionary checkout shows the lifetime note, no discount rows and the kept-time line for a premium member', () => {
		Object.assign(flow, {
			item: null,
			quote: quoteFor('visionary', {base_try_minor: 10000, final_try_minor: 10000}),
		});
		users.currentUser = userWith({premium: true});
		render({kind: 'visionary'});

		expect(texts('h2')).toEqual(['sanalyer Visionary']);
		expect(texts('dt')).toEqual(['Price', 'Total']);
		expect(texts('p')).toEqual(
			expect.arrayContaining([
				'Lifetime sanalyer Plus, a numbered badge, the #0000 tag and a decoration only Visionaries have.',
				'Lifetime means for as long as sanalyer runs.',
				'Your remaining sanalyer Plus time becomes part of the lifetime plan. It is not refunded.',
			]),
		);

		users.currentUser = userWith({});
		render({kind: 'visionary'});

		expect(text()).not.toContain('Your remaining');
	});
});

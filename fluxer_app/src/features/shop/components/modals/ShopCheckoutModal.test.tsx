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
	'Payable: {amount} AZN': 'Ödenecek: {amount} AZN',
	'{price} a month': 'Aylık {price}',
	'≈ {price} a day': 'Günde ≈ {price}',
	"Micup is an Azerbaijani company, so payments are collected in Azerbaijani manat (AZN). TL amounts are informational, based on the Central Bank of Azerbaijan's daily exchange rate.":
		"Micup bir Azerbaycan şirketi olduğu için ödemeler Azerbaycan manatı (AZN) ile alınır. TL tutarı Azerbaycan Merkez Bankası'nın günlük kuruyla bilgi amaçlıdır.",
	'The TL amount on your card statement may differ slightly: your bank converts AZN at its own exchange rate and may charge a foreign transaction fee.':
		"Kart ekstrenizdeki TL tutarı biraz farklı olabilir: bankanız AZN'yi kendi kuruyla çevirir ve yurt dışı işlem ücreti alabilir.",
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
	settings: {usd_to_azn_rate_micro: 1700000, try_to_azn_rate_micro: null as number | null},
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
	base_usd_cents: 500,
	campaign_percent: 0,
	premium_percent: 0,
	final_usd_cents: 500,
	amount_azn_minor: 850,
	usd_to_azn_rate: '1.7000',
	usd_to_azn_rate_micro: 1700000,
	currency: 'AZN',
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
	base_usd_cents: cents,
	campaign_percent: campaign,
	campaign_ends_at: null,
	sale_usd_cents: campaign ? Math.round((cents * (100 - campaign)) / 100) : cents,
	premium_usd_cents: null,
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
		catalog.settings.try_to_azn_rate_micro = null;
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
				return {kind: 'item', sku, item: ITEM, price: {...packagePrice(500), premium_usd_cents: 350}};
			}
			return sku === 'bundle:70' ? {kind: 'bundle', sku, price: {...packagePrice(900), premium_usd_cents: 630}} : null;
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

	it.each(['payment_ready', 'awaiting', 'price_changed', 'contents_changed'])(
		'shows the persisted Turkish quote in %s independently of the current catalog rate',
		(state) => {
			locale = 'tr';
			catalog.settings.try_to_azn_rate_micro = 999999;
			Object.assign(flow, {
				state,
				order: {
					...ORDER,
					amount_azn_minor: 338,
					display_currency: 'TRY',
					display_amount_minor: 6800,
					display_rate_micro: 49706,
				},
			});
			render({kind: 'item', sku: 'cosmetic:5'});
			expect(text()).toContain('Ödeme sayfası Azerbaycan manatı gösterecek: 3,38 AZN (mağazadaki fiyat 68 TL).');
			expect(text()).not.toContain('bankanız');
			expect(flow.openPaymentPage).not.toHaveBeenCalled();
		},
	);

	it('shows the persisted English quote before opening the payment page on Continue', () => {
		Object.assign(flow, {
			state: 'payment_ready',
			order: {
				...ORDER,
				amount_azn_minor: 338,
				display_currency: 'TRY',
				display_amount_minor: 6838,
				display_rate_micro: 49430,
			},
		});
		render({kind: 'item', sku: 'cosmetic:5'});
		expect(text()).toContain('The payment page will show Azerbaijani manat: 3.38 AZN (store price 68.38 TL).');
		expect(flow.openPaymentPage).not.toHaveBeenCalled();
		act(() => button('Continue')!.click());
		expect(flow.openPaymentPage).toHaveBeenCalledTimes(1);
	});

	it.each(['AZN', null, undefined])('shows AZN store price for no-rate and legacy %s orders', (currency) => {
		locale = 'tr';
		catalog.settings.try_to_azn_rate_micro = 40000;
		Object.assign(flow, {
			state: 'payment_ready',
			order: {
				...ORDER,
				amount_azn_minor: 338,
				display_currency: currency,
				display_amount_minor: currency === 'AZN' ? 338 : null,
				display_rate_micro: null,
			},
		});
		render({kind: 'item', sku: 'cosmetic:5'});
		expect(text()).toContain('Ödeme sayfası Azerbaycan manatı gösterecek: 3,38 AZN (mağazadaki fiyat 3,38 AZN).');
		expect(text()).not.toContain('TL');
	});

	it('keeps changed-price total equal to the persisted TRY quote after the catalog rate changes', () => {
		locale = 'tr';
		catalog.settings.try_to_azn_rate_micro = 999999;
		Object.assign(flow, {
			state: 'price_changed',
			order: {
				...ORDER,
				amount_azn_minor: 338,
				display_currency: 'TRY',
				display_amount_minor: 6800,
				display_rate_micro: 49706,
			},
		});
		render({kind: 'item', sku: 'cosmetic:5'});
		expect(texts('dd').at(-1)).toBe('68 TLÖdenecek: 3,38 AZN');
	});

	it('shows the AZN note word for word', () => {
		locale = 'tr';
		render({kind: 'item', sku: 'cosmetic:5'});

		expect(text()).toContain(
			"Micup bir Azerbaycan şirketi olduğu için ödemeler Azerbaycan manatı (AZN) ile alınır. TL tutarı Azerbaycan Merkez Bankası'nın günlük kuruyla bilgi amaçlıdır.",
		);
		expect(text()).toContain(
			"Kart ekstrenizdeki TL tutarı biraz farklı olabilir: bankanız AZN'yi kendi kuruyla çevirir ve yurt dışı işlem ücreti alabilir.",
		);
		expect(texts('dd')).toContain('8,50 AZN');
	});

	it('converts only for display and keeps the authoritative quote AZN when catalog pricing differs', () => {
		catalog.settings.try_to_azn_rate_micro = 40000;
		flow.quote = quoteFor('cosmetic:5', {amount_azn_minor: 851});
		render({kind: 'item', sku: 'cosmetic:5'});
		expect(texts('dd').at(-1)).toBe('212.75 TLPayable: 8.51 AZN');
		expect(text()).not.toMatch(/USD|\$/);
	});

	it('shows one authoritative payable amount while the Plus hint stays informational', () => {
		catalog.settings.try_to_azn_rate_micro = 40000;
		flow.quote = quoteFor('cosmetic:5', {amount_azn_minor: 851});
		render({kind: 'item', sku: 'cosmetic:5'});
		expect(texts('[data-flx="shop.shop-price.payable"]')).toEqual(['Payable: 8.51 AZN']);
		expect(texts('[data-flx="shop.shop-checkout-modal.premium-hint-text"]')).toEqual(['Plus: 148.75 TL']);
	});

	it('lists the campaign and the premium discount from the server quote', () => {
		flow.quote = quoteFor('cosmetic:5', {
			campaign_percent: 20,
			premium_percent: 30,
			final_usd_cents: 280,
			amount_azn_minor: 476,
		});
		render({kind: 'item', sku: 'cosmetic:5'});

		expect(texts('dt')).toEqual(['Price', 'Sale (-20%)', 'Micup Plus discount (-30%)', 'Total']);
		expect(texts('dd')).toEqual(['8.50 AZN', '−1.70 AZN', '−2.04 AZN', '4.76 AZN']);
		expect(container.querySelector('[data-stage="5"]')).not.toBeNull();
	});

	it('uses the quote rate for every summary row even when the catalog rate is older', () => {
		flow.quote = quoteFor('cosmetic:5', {
			usd_to_azn_rate: '2.0000',
			usd_to_azn_rate_micro: 2000000,
			amount_azn_minor: 1000,
		});
		render({kind: 'item', sku: 'cosmetic:5'});
		expect(texts('dd')).toEqual(['10.00 AZN', '10.00 AZN']);
	});

	it.each([null, 40001])('subtracts converted cumulative amounts so discount rows add up with TRY rate %s', (rate) => {
		catalog.settings.try_to_azn_rate_micro = rate;
		flow.quote = quoteFor('cosmetic:5', {
			base_usd_cents: 499,
			campaign_percent: 15,
			final_usd_cents: 424,
			amount_azn_minor: 721,
		});
		render({kind: 'item', sku: 'cosmetic:5'});
		expect(texts('dd')).toEqual(
			rate === null ? ['8.48 AZN', '−1.27 AZN', '7.21 AZN'] : ['211.99 TL', '−31.74 TL', '180.25 TLPayable: 7.21 AZN'],
		);
	});

	it('uses the legacy quote rate for summary rows from an older server', () => {
		flow.quote = quoteFor('cosmetic:5', {
			campaign_percent: 20,
			final_usd_cents: 400,
			amount_azn_minor: 680,
			usd_to_azn_rate_micro: undefined,
		});
		render({kind: 'item', sku: 'cosmetic:5'});
		expect(texts('dt')).toEqual(['Price', 'Sale (-20%)', 'Total']);
		expect(texts('dd')).toEqual(['8.50 AZN', '−1.70 AZN', '6.80 AZN']);
	});

	it('premium mode has 1/3/12 month choices with the incoming one selected', () => {
		flow.quote = quoteFor('premium:3', {base_usd_cents: 1200, final_usd_cents: 1200, amount_azn_minor: 2040});
		render({kind: 'premium', months: 3});

		const radios = [...container.querySelectorAll('[role="radio"]')];
		expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
		expect(text()).toContain('1 month');
		expect(text()).toContain('20.40 AZN');
		expect(text()).toContain('68.00 AZN');
		expect(text()).toContain('One-time payment. It does not renew.');
		expect(useShopCheckout).toHaveBeenLastCalledWith({kind: 'premium', months: 3});

		act(() => (radios[2] as HTMLElement).click());

		expect(useShopCheckout).toHaveBeenLastCalledWith({kind: 'premium', months: 12});
	});

	it('a package whose campaign has ended since the catalog was read shows its full price', () => {
		const ended = {...packagePrice(5000, 20), campaign_ends_at: new Date(NOW - 1).toISOString()};
		catalog.packageEntries = [{kind: 'package', sku: 'premium:12', months: 12, price: ended}];
		flow.quote = quoteFor('premium:12', {base_usd_cents: 5000, final_usd_cents: 5000, amount_azn_minor: 8500});
		render({kind: 'premium', months: 12});

		expect(texts('[data-flx="shop.shop-checkout-modal.package-amount"]')).toEqual(['85.00 AZN']);
		expect(text()).not.toMatch(/TRY|₺|USD|\$/);
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
		expect(text()).toContain('The Payriff page is in English and shows the amount in AZN: 8.50 AZN.');

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
			quote: quoteFor('cosmetic:5', {campaign_percent: 20, final_usd_cents: 400, amount_azn_minor: 680}),
			order: ORDER,
		});
		render({kind: 'item', sku: 'cosmetic:5'});

		expect(texts('h2')).toContain('The price changed');
		expect(texts('dd')).toEqual(['8.50 AZN', '8.50 AZN']);
		expect(texts(`.${styles.changed}`)).toEqual(['Total8.50 AZN']);
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
			Object.assign(flow, {item: null, bundle: BUNDLE, quote: quoteFor('bundle:70', {base_usd_cents: 900})});
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
			expect(text()).toContain('Plus: 10.71 AZN');
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
			quote: quoteFor('visionary', {base_usd_cents: 10000, final_usd_cents: 10000, amount_azn_minor: 17000}),
		});
		users.currentUser = userWith({premium: true});
		render({kind: 'visionary'});

		expect(texts('h2')).toEqual(['Micup Visionary']);
		expect(texts('dt')).toEqual(['Price', 'Total']);
		expect(texts('p')).toEqual(
			expect.arrayContaining([
				'Lifetime Micup Plus, a numbered badge, the #0000 tag and a decoration only Visionaries have.',
				"Micup is an Azerbaijani company, so payments are collected in Azerbaijani manat (AZN). TL amounts are informational, based on the Central Bank of Azerbaijan's daily exchange rate. The TL amount on your card statement may differ slightly: your bank converts AZN at its own exchange rate and may charge a foreign transaction fee.",
				'Lifetime means for as long as Micup runs.',
				'Your remaining Micup Plus time becomes part of the lifetime plan. It is not refunded.',
			]),
		);

		users.currentUser = userWith({});
		render({kind: 'visionary'});

		expect(text()).not.toContain('Your remaining');
	});
});

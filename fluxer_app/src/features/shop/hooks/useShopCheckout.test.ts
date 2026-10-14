// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {HttpError} from '@app/features/platform/types/EndpointError';
import type {ShopCheckoutTarget} from '@app/features/shop/components/modals/ShopCheckoutModal';
import type {ShopCheckoutFlow} from '@app/features/shop/hooks/useShopCheckout';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {ShopOrderResponse, ShopQuoteResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {observable, runInAction} from 'mobx';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface FakeUser {
	premiumType: number | null;
	premiumUntil: Date | null;
	premiumLifetimeSequence: number | null;
	worn: Record<string, string>;
}

const shopCommands = vi.hoisted(() => ({fetchQuote: vi.fn(), createOrder: vi.fn(), fetchOrder: vi.fn()}));
const nativeUtils = vi.hoisted(() => ({openExternalUrl: vi.fn()}));
const toastCommands = vi.hoisted(() => ({createToast: vi.fn()}));
const catalog = vi.hoisted(() => ({load: vi.fn(), entryForSku: vi.fn()}));
const profileCommands = vi.hoisted(() => ({clearCurrentUserProfiles: vi.fn()}));
const cosmeticCommands = vi.hoisted(() => ({fetchItems: vi.fn()}));
const users = observable({currentUser: null as FakeUser | null});
const windowState = observable({focused: true, visible: true});
// Stands in for Cosmetics: the worn slots are read off the current user, which USER_UPDATE replaces.
const cosmetics = {
	equippedId: (type: string) => users.currentUser?.worn[type] ?? null,
	load: vi.fn(),
	equip: vi.fn(),
};

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: (d: {message: string}) => d.message}})}));
vi.mock('@app/features/shop/commands/ShopCommands', () => shopCommands);
vi.mock('@app/features/shop/state/ShopCatalog', () => ({default: catalog}));
vi.mock('@app/features/ui/utils/NativeUtils', () => nativeUtils);
vi.mock('@app/features/ui/commands/ToastCommands', () => toastCommands);
vi.mock('@app/features/user/state/Users', () => ({default: users}));
vi.mock('@app/features/window/state/Window', () => ({default: windowState}));
vi.mock('@app/features/cosmetics/state/Cosmetics', () => ({default: cosmetics}));
vi.mock('@app/features/user/commands/UserProfileCommands', () => profileCommands);
vi.mock('@app/features/cosmetics/commands/CosmeticCommands', () => cosmeticCommands);

const {useShopCheckout} = await import('@app/features/shop/hooks/useShopCheckout');

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
const FRAME = bundleItem('1', 'avatar_decoration');
const EFFECT = bundleItem('2', 'profile_effect');
const BUNDLE_ONLY = bundleItem('3', 'nameplate');
const BUNDLE_TARGET: ShopCheckoutTarget = {kind: 'bundle', sku: 'bundle:70'};
const PAYMENT_URL = 'https://pay.payriff.com/pay/900';
const quoteFor = (sku: string, fields: Partial<ShopQuoteResponse> = {}): ShopQuoteResponse => ({
	sku,
	base_try_minor: 500,
	campaign_percent: 20,
	premium_percent: 0,
	final_try_minor: 400,
	currency: 'TRY',
	...fields,
});
const orderFor = (sku: string, fields: Partial<ShopOrderResponse> = {}): ShopOrderResponse => ({
	...quoteFor(sku),
	id: '900',
	status: 'pending',
	failure_reason: null,
	payment_url: PAYMENT_URL,
	created_at: '2026-09-28T20:00:00.000Z',
	...fields,
});
const shopError = (code: string, status = 400, message?: string, fields: Record<string, unknown> = {}) =>
	new HttpError({method: 'POST', path: '/shop/orders', status, body: {code, message: message ?? code, ...fields}});
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('useShopCheckout', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot> | null = null;
	let checkout!: ShopCheckoutFlow;

	const Harness = ({target}: {target: ShopCheckoutTarget}) => {
		checkout = useShopCheckout(target);
		return null;
	};
	const mount = async (target: ShopCheckoutTarget) => {
		if (root) await unmount();
		root = createRoot(container);
		await act(async () => root!.render(createElement(Harness, {target})));
		await flush();
	};
	const unmount = async () => {
		await act(async () => root!.unmount());
		root = null;
	};
	// Opens an order at the quoted price, so the dialog waits for the payment.
	const openOrder = async (target: ShopCheckoutTarget = {kind: 'item', sku: 'cosmetic:5'}) => {
		await mount(target);
		checkout.start();
		await flush();
		expect(checkout.state).toBe('payment_ready');
		checkout.openPaymentPage();
		expect(checkout.state).toBe('awaiting');
	};
	const wear = (fields: Partial<FakeUser>) => {
		runInAction(() => {
			users.currentUser = {...users.currentUser!, ...fields};
		});
	};

	beforeEach(() => {
		vi.useFakeTimers();
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		for (const mock of [
			...Object.values(shopCommands),
			nativeUtils.openExternalUrl,
			toastCommands.createToast,
			catalog.load,
			cosmetics.load,
			cosmetics.equip,
			profileCommands.clearCurrentUserProfiles,
			cosmeticCommands.fetchItems,
		]) {
			mock.mockReset();
		}
		shopCommands.fetchQuote.mockImplementation(async (sku: string) => quoteFor(sku));
		shopCommands.createOrder.mockImplementation(async (sku: string) => orderFor(sku));
		shopCommands.fetchOrder.mockImplementation(async () => orderFor('cosmetic:5'));
		catalog.entryForSku.mockImplementation((sku: string) => {
			if (sku === 'cosmetic:5') return {kind: 'item', sku, item: ITEM, price: null};
			if (sku === 'bundle:70') return {kind: 'bundle', sku, bundle: {name: 'Gece seti', items: [FRAME, EFFECT]}};
			return null;
		});
		cosmetics.load.mockResolvedValue(undefined);
		cosmetics.equip.mockResolvedValue(undefined);
		runInAction(() => {
			users.currentUser = {premiumType: null, premiumUntil: null, premiumLifetimeSequence: null, worn: {}};
			windowState.focused = true;
			windowState.visible = true;
		});
		container = document.createElement('div');
		document.body.append(container);
	});

	afterEach(async () => {
		if (root) await unmount();
		container.remove();
		vi.useRealTimers();
	});

	it('asks the server for the quote and sends only the sku when buying', async () => {
		await mount({kind: 'item', sku: 'cosmetic:5'});

		expect(shopCommands.fetchQuote).toHaveBeenCalledWith('cosmetic:5');
		expect(checkout.state).toBe('ready');
		expect(checkout.quote).toEqual(quoteFor('cosmetic:5'));

		checkout.start();
		await flush();

		expect(shopCommands.createOrder.mock.calls).toEqual([['cosmetic:5']]);
	});

	it('asks for a new quote when the premium package changes, and names Visionary by its sku', async () => {
		await mount({kind: 'premium', months: 3});
		await act(async () => root!.render(createElement(Harness, {target: {kind: 'premium', months: 12}})));
		await flush();
		await mount({kind: 'visionary'});

		expect(shopCommands.fetchQuote.mock.calls).toEqual([['premium:3'], ['premium:12'], ['visionary']]);
		expect(checkout.quote?.sku).toBe('visionary');
	});

	it('keeps the order ready without redirecting or polling until the user confirms', async () => {
		await mount({kind: 'item', sku: 'cosmetic:5'});
		await checkout.start();
		expect(checkout.state).toBe('payment_ready');
		expect(checkout.order?.id).toBe('900');
		expect(nativeUtils.openExternalUrl).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(shopCommands.fetchOrder).not.toHaveBeenCalled();
		checkout.openPaymentPage();
		expect(checkout.state).toBe('awaiting');
		expect(nativeUtils.openExternalUrl.mock.calls).toEqual([[PAYMENT_URL]]);
		await vi.advanceTimersByTimeAsync(2000);
		expect(shopCommands.fetchOrder).toHaveBeenCalledWith('900');
		expect(shopCommands.createOrder).toHaveBeenCalledTimes(1);
	});

	it('opens the payment page through openExternalUrl after confirmation and can reopen it', async () => {
		await openOrder();

		expect(nativeUtils.openExternalUrl.mock.calls).toEqual([[PAYMENT_URL]]);

		checkout.openPaymentPage();

		expect(nativeUtils.openExternalUrl.mock.calls).toEqual([[PAYMENT_URL], [PAYMENT_URL]]);
	});

	it('does not open the payment page when the order amount differs from the quote', async () => {
		shopCommands.createOrder.mockImplementation(async (sku: string) =>
			orderFor(sku, {campaign_percent: 0, final_try_minor: 500}),
		);
		await mount({kind: 'item', sku: 'cosmetic:5'});
		checkout.start();
		await flush();

		expect(checkout.state).toBe('price_changed');
		expect(checkout.order?.final_try_minor).toBe(500);
		expect(nativeUtils.openExternalUrl).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(shopCommands.fetchOrder).not.toHaveBeenCalled();

		checkout.openPaymentPage();
		await vi.advanceTimersByTimeAsync(2000);

		expect(nativeUtils.openExternalUrl.mock.calls).toEqual([[PAYMENT_URL]]);
		expect(checkout.state).toBe('awaiting');
		expect(shopCommands.createOrder).toHaveBeenCalledTimes(1);
		expect(shopCommands.fetchOrder).toHaveBeenCalledWith('900');
	});

	it('polls at 2, 2, 3, 5, 8, 13, 15 s and times out after 10 minutes', async () => {
		const startedAt = Date.now();
		const pollTimes: Array<number> = [];
		shopCommands.fetchOrder.mockImplementation(async () => {
			pollTimes.push(Date.now() - startedAt);
			return orderFor('cosmetic:5');
		});
		await openOrder();

		await vi.advanceTimersByTimeAsync(63_000);
		expect(pollTimes).toEqual([2000, 4000, 7000, 12000, 20000, 33000, 48000, 63000]);

		await vi.advanceTimersByTimeAsync(600_000 - 63_000 - 1);
		expect(checkout.state).toBe('awaiting');
		await vi.advanceTimersByTimeAsync(1);
		expect(checkout.state).toBe('timeout');

		const polls = pollTimes.length;
		await vi.advanceTimersByTimeAsync(600_000);
		expect(pollTimes).toHaveLength(polls);
	});

	it('checks at once when the window comes back, at most every 2 s', async () => {
		const startedAt = Date.now();
		const pollTimes: Array<number> = [];
		shopCommands.fetchOrder.mockImplementation(async () => {
			pollTimes.push(Date.now() - startedAt);
			return orderFor('cosmetic:5');
		});
		await openOrder();
		await vi.advanceTimersByTimeAsync(10_000);
		const refocus = () => {
			runInAction(() => {
				windowState.focused = false;
			});
			runInAction(() => {
				windowState.focused = true;
			});
		};

		refocus();
		await flush();
		await vi.advanceTimersByTimeAsync(500);
		refocus();
		await vi.advanceTimersByTimeAsync(2000);

		expect(pollTimes).toEqual([2000, 4000, 7000, 10000, 12000]);
	});

	it('turns granted into approved and amount_mismatch into failed_mismatch', async () => {
		shopCommands.fetchOrder.mockResolvedValueOnce(orderFor('cosmetic:5', {status: 'granted', payment_url: null}));
		await openOrder();
		await vi.advanceTimersByTimeAsync(2000);

		expect(checkout.state).toBe('approved');
		expect(checkout.success).toEqual({kind: 'item', item: ITEM});
		expect(cosmetics.load).toHaveBeenCalledTimes(1);
		expect(catalog.load).toHaveBeenCalledWith(true);

		shopCommands.fetchOrder.mockResolvedValueOnce(
			orderFor('cosmetic:5', {status: 'failed', failure_reason: 'amount_mismatch', payment_url: null}),
		);
		await openOrder();
		await vi.advanceTimersByTimeAsync(2000);

		expect(checkout.state).toBe('failed_mismatch');

		shopCommands.fetchOrder.mockResolvedValueOnce(orderFor('cosmetic:5', {status: 'expired', payment_url: null}));
		await openOrder();
		await vi.advanceTimersByTimeAsync(2000);

		expect(checkout.state).toBe('failed');
		const polls = shopCommands.fetchOrder.mock.calls.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(shopCommands.fetchOrder).toHaveBeenCalledTimes(polls);
	});

	it.each([
		['SHOP_SALES_CLOSED on the quote', 'quote', shopError('SHOP_SALES_CLOSED', 403), 'sales_closed'],
		['SHOP_ITEM_UNAVAILABLE on an item', 'order', shopError('SHOP_ITEM_UNAVAILABLE'), 'sales_closed'],
		['SHOP_BUSY on the order', 'order', shopError('SHOP_BUSY', 503), 'busy'],
		['a rate limit on the order', 'order', shopError('RATE_LIMITED', 429), 'busy'],
		['COSMETIC_ALREADY_OWNED on the order', 'order', shopError('COSMETIC_ALREADY_OWNED'), 'already_owned'],
	] as const)('maps %s to its state', async (_case, where, error, state) => {
		const failing = where === 'quote' ? shopCommands.fetchQuote : shopCommands.createOrder;
		failing.mockRejectedValueOnce(error);
		await mount({kind: 'item', sku: 'cosmetic:5'});
		if (where === 'order') {
			checkout.start();
			await flush();
		}

		expect(checkout.state).toBe(state);
		expect(checkout.failureMessage).toBeNull();
		expect(nativeUtils.openExternalUrl).not.toHaveBeenCalled();
		expect(catalog.load).toHaveBeenCalledTimes(state === 'sales_closed' ? 1 : 0);
	});

	it('tells the daily order limit apart from the per-minute one by the wait', async () => {
		const rateLimited = (retryAfter: number) =>
			shopError('RATE_LIMITED', 429, 'Hız sınırlamasına takıldın.', {retry_after: retryAfter, global: false});
		shopCommands.createOrder.mockRejectedValueOnce(rateLimited(4320));
		await mount({kind: 'item', sku: 'cosmetic:5'});
		checkout.start();
		await flush();

		expect(checkout.state).toBe('busy');
		expect(checkout.waitMinutes).toBe(72);
		expect(checkout.failureMessage).toBeNull();

		checkout.retry();
		await flush();
		expect(checkout.waitMinutes).toBeNull();

		shopCommands.createOrder.mockRejectedValueOnce(rateLimited(12.5));
		checkout.start();
		await flush();

		expect(checkout.state).toBe('busy');
		expect(checkout.waitMinutes).toBeNull();
	});

	it("shows the server's own words for too many open orders", async () => {
		shopCommands.createOrder.mockRejectedValueOnce(
			shopError('SHOP_TOO_MANY_OPEN_ORDERS', 409, 'Birkaç dakika bekleyin.'),
		);
		await mount({kind: 'item', sku: 'cosmetic:5'});
		checkout.start();
		await flush();

		expect(checkout.state).toBe('busy');
		expect(checkout.failureMessage).toBe('Birkaç dakika bekleyin.');

		checkout.retry();
		await flush();

		expect(checkout.state).toBe('ready');
		expect(checkout.failureMessage).toBeNull();
	});

	it('a USER_UPDATE that wears the item triggers one check and stops polling', async () => {
		await openOrder();
		await vi.advanceTimersByTimeAsync(500);
		shopCommands.fetchOrder.mockResolvedValueOnce(orderFor('cosmetic:5', {status: 'granted', payment_url: null}));

		wear({worn: {avatar_ultra: '5'}});
		await flush();

		expect(shopCommands.fetchOrder).toHaveBeenCalledTimes(1);
		expect(checkout.state).toBe('approved');
		await vi.advanceTimersByTimeAsync(600_000);
		expect(shopCommands.fetchOrder).toHaveBeenCalledTimes(1);
	});

	it('closing while awaiting stops polling and shows the follow-up toast', async () => {
		await mount({kind: 'item', sku: 'cosmetic:5'});
		await unmount();
		expect(toastCommands.createToast).not.toHaveBeenCalled();

		await openOrder();
		await unmount();

		expect(toastCommands.createToast.mock.calls).toEqual([
			[{type: 'info', children: 'Once the payment is confirmed, your purchase is added to your account.'}],
		]);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(shopCommands.fetchOrder).not.toHaveBeenCalled();
	});

	it('maps SHOP_ITEM_UNAVAILABLE on Visionary to sold out', async () => {
		shopCommands.createOrder.mockRejectedValueOnce(shopError('SHOP_ITEM_UNAVAILABLE'));
		await mount({kind: 'visionary'});
		checkout.start();
		await flush();

		expect(checkout.state).toBe('sold_out');
		expect(catalog.load).toHaveBeenCalledWith(true);
		expect(nativeUtils.openExternalUrl).not.toHaveBeenCalled();
	});

	it('ends a Visionary checkout with the number from the account', async () => {
		await openOrder({kind: 'visionary'});
		shopCommands.fetchOrder.mockResolvedValueOnce(orderFor('visionary', {status: 'granted', payment_url: null}));

		wear({premiumType: 2, premiumLifetimeSequence: 7});
		await flush();

		expect(shopCommands.fetchOrder).toHaveBeenCalledTimes(1);
		expect(checkout.state).toBe('approved');
		expect(checkout.success).toEqual({kind: 'visionary', number: 7});
		expect(cosmetics.load).not.toHaveBeenCalled();
	});

	it('a premium purchase ends when premium_until grows and reports the new end', async () => {
		const until = new Date('2026-12-28T20:00:00.000Z');
		await openOrder({kind: 'premium', months: 3});
		shopCommands.fetchOrder.mockResolvedValueOnce(orderFor('premium:3', {status: 'granted', payment_url: null}));

		wear({premiumUntil: until});
		await flush();

		expect(checkout.state).toBe('approved');
		expect(checkout.success).toEqual({kind: 'premium', premiumUntil: until.toISOString()});
	});

	it('equips an item that arrived another way', async () => {
		shopCommands.createOrder.mockRejectedValueOnce(shopError('COSMETIC_ALREADY_OWNED'));
		await mount({kind: 'item', sku: 'cosmetic:5'});
		checkout.start();
		await flush();

		checkout.equip();
		await flush();

		expect(cosmetics.equip).toHaveBeenCalledWith({avatar_ultra: '5'});
		expect(checkout.state).toBe('approved');
	});

	it('keeps showing the item after the catalog drops it during the payment', async () => {
		const effect = {...ITEM, type: 'profile_effect'} as CosmeticItemResponse;
		catalog.entryForSku.mockImplementation((sku: string) =>
			sku === 'cosmetic:5' ? {kind: 'item', sku, item: effect, price: null} : null,
		);
		await openOrder();
		catalog.entryForSku.mockReturnValue(null);
		shopCommands.fetchOrder.mockResolvedValueOnce(orderFor('cosmetic:5', {status: 'granted', payment_url: null}));
		await vi.advanceTimersByTimeAsync(2000);

		expect(checkout.state).toBe('approved');
		expect(checkout.item).toEqual(effect);
		expect(checkout.success).toEqual({kind: 'item', item: effect});
		expect(profileCommands.clearCurrentUserProfiles).toHaveBeenCalledTimes(1);
	});

	it('ends a bundle checkout with its items: the owned list reloads and an effect clears the profile', async () => {
		shopCommands.createOrder.mockImplementation(async (sku: string) => orderFor(sku, {item_ids: ['1', '2']}));
		await openOrder(BUNDLE_TARGET);

		expect(shopCommands.fetchQuote).toHaveBeenCalledWith('bundle:70');
		expect(nativeUtils.openExternalUrl.mock.calls).toEqual([[PAYMENT_URL]]);
		expect(cosmeticCommands.fetchItems).not.toHaveBeenCalled();

		shopCommands.fetchOrder.mockResolvedValueOnce(
			orderFor('bundle:70', {status: 'granted', payment_url: null, item_ids: ['1', '2']}),
		);
		// Delivery wears the first of each type: the frame's USER_UPDATE is the sign.
		wear({worn: {avatar_decoration: '1'}});
		await flush();

		expect(shopCommands.fetchOrder).toHaveBeenCalledTimes(1);
		expect(checkout.state).toBe('approved');
		expect(checkout.success).toEqual({kind: 'bundle', name: 'Gece seti', items: [FRAME, EFFECT]});
		expect(cosmetics.load).toHaveBeenCalledTimes(1);
		expect(profileCommands.clearCurrentUserProfiles).toHaveBeenCalledTimes(1);
		expect(catalog.load).toHaveBeenCalledWith(true);
	});

	// the catalog on screen may be older than the bundle the order froze. The price alone does not
	// tell, so the lists are compared, order included, before any payment page opens.
	it('stops before paying when the order froze other items than the ones shown, and shows the order ones', async () => {
		shopCommands.createOrder.mockImplementation(async (sku: string) => orderFor(sku, {item_ids: ['2', '3']}));
		cosmeticCommands.fetchItems.mockResolvedValue([BUNDLE_ONLY]);
		await mount(BUNDLE_TARGET);
		checkout.start();
		await flush();

		expect(checkout.state).toBe('contents_changed');
		expect(checkout.bundle).toEqual({name: 'Gece seti', items: [EFFECT, BUNDLE_ONLY]});
		expect(cosmeticCommands.fetchItems).toHaveBeenCalledWith(['3']);
		expect(catalog.load).toHaveBeenCalledWith(true);
		expect(nativeUtils.openExternalUrl).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(shopCommands.fetchOrder).not.toHaveBeenCalled();

		checkout.openPaymentPage();
		expect(checkout.state).toBe('awaiting');
		expect(nativeUtils.openExternalUrl.mock.calls).toEqual([[PAYMENT_URL]]);

		// The catalog drops the bundle meanwhile; the success view still draws the order's list.
		catalog.entryForSku.mockReturnValue(null);
		shopCommands.fetchOrder.mockResolvedValueOnce(
			orderFor('bundle:70', {status: 'granted', payment_url: null, item_ids: ['2', '3']}),
		);
		await vi.advanceTimersByTimeAsync(2000);

		expect(checkout.state).toBe('approved');
		expect(checkout.success).toEqual({kind: 'bundle', name: 'Gece seti', items: [EFFECT, BUNDLE_ONLY]});
	});

	// the Payriff order is open once createOrder answers; a failed item read must not lose it.
	it('keeps the open order when reading its new items fails, naming them from the reloaded catalog', async () => {
		shopCommands.createOrder.mockImplementation(async (sku: string) => orderFor(sku, {item_ids: ['2', '3']}));
		cosmeticCommands.fetchItems.mockRejectedValue(new Error('network'));
		await mount(BUNDLE_TARGET);
		catalog.load.mockImplementation(async () => {
			catalog.entryForSku.mockReturnValue({kind: 'bundle', sku: 'bundle:70', bundle: {items: [EFFECT, BUNDLE_ONLY]}});
		});
		checkout.start();
		await flush();

		expect(checkout.order?.id).toBe('900');
		expect(checkout.state).toBe('contents_changed');
		expect(checkout.bundle).toEqual({name: 'Gece seti', items: [EFFECT, BUNDLE_ONLY]});

		checkout.openPaymentPage();
		expect(checkout.state).toBe('awaiting');
		expect(nativeUtils.openExternalUrl.mock.calls).toEqual([[PAYMENT_URL]]);
		expect(shopCommands.createOrder).toHaveBeenCalledTimes(1);
	});

	it('counts the same items in another order as changed contents', async () => {
		shopCommands.createOrder.mockImplementation(async (sku: string) => orderFor(sku, {item_ids: ['2', '1']}));
		await mount(BUNDLE_TARGET);
		checkout.start();
		await flush();

		expect(checkout.state).toBe('contents_changed');
		expect(checkout.bundle?.items).toEqual([EFFECT, FRAME]);
		expect(cosmeticCommands.fetchItems).not.toHaveBeenCalled();
	});

	it('a bundle with an item the account has ends in already_owned with nothing to equip', async () => {
		shopCommands.createOrder.mockRejectedValueOnce(shopError('COSMETIC_ALREADY_OWNED'));
		await mount(BUNDLE_TARGET);
		checkout.start();
		await flush();
		expect(checkout.state).toBe('already_owned');

		checkout.equip();
		await flush();

		expect(cosmetics.equip).not.toHaveBeenCalled();
		expect(checkout.state).toBe('already_owned');
	});

	it('checks again once after the timeout', async () => {
		await openOrder();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(checkout.state).toBe('timeout');
		shopCommands.fetchOrder.mockResolvedValueOnce(orderFor('cosmetic:5', {status: 'granted', payment_url: null}));

		checkout.checkAgain();
		await flush();

		expect(checkout.state).toBe('approved');
	});
});

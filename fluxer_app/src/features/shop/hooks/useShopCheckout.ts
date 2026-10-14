// SPDX-License-Identifier: AGPL-3.0-or-later

import * as CosmeticCommands from '@app/features/cosmetics/commands/CosmeticCommands';
import Cosmetics, {type CosmeticType} from '@app/features/cosmetics/state/Cosmetics';
import {HttpError} from '@app/features/platform/types/EndpointError';
import {failureCode, failureMessage, failureRetryAfter} from '@app/features/platform/utils/ResponseInspection';
import * as ShopCommands from '@app/features/shop/commands/ShopCommands';
import type {ShopCheckoutTarget} from '@app/features/shop/components/modals/ShopCheckoutModal';
import type {ShopEquippedSuccessResult} from '@app/features/shop/components/ShopEquippedSuccess';
import ShopCatalog from '@app/features/shop/state/ShopCatalog';
import {packageSku, VISIONARY_SKU} from '@app/features/shop/utils/ShopEntries';
import {PURCHASE_ADDED_ONCE_CONFIRMED_DESCRIPTOR} from '@app/features/shop/utils/ShopMessageDescriptors';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {openExternalUrl} from '@app/features/ui/utils/NativeUtils';
import * as UserProfileCommands from '@app/features/user/commands/UserProfileCommands';
import Users from '@app/features/user/state/Users';
import WindowState from '@app/features/window/state/Window';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {ShopOrderResponse, ShopQuoteResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {useLingui} from '@lingui/react/macro';
import {type IReactionDisposer, makeAutoObservable, reaction, runInAction} from 'mobx';
import {useEffect, useState} from 'react';

export type ShopCheckoutState =
	| 'quoting'
	| 'ready'
	| 'creating'
	| 'payment_ready'
	| 'price_changed'
	| 'contents_changed'
	| 'awaiting'
	| 'approved'
	| 'failed'
	| 'failed_mismatch'
	| 'timeout'
	| 'sales_closed'
	| 'sold_out'
	| 'busy'
	| 'already_owned';

// The client reads only our own order record; the server asks Payriff. A waiting dialog reads
// it after 2, 2, 3, 5, 8, 13 s and then every 15 s, about once every 7 s over ten minutes.
const POLL_DELAYS_MS = [2000, 2000, 3000, 5000, 8000, 13000, 15000];
const POLL_LIMIT_MS = 10 * 60 * 1000;
const EARLY_CHECK_GAP_MS = 2000;

export function shopCheckoutSku(target: ShopCheckoutTarget): string {
	switch (target.kind) {
		case 'item':
			return target.sku;
		case 'premium':
			return packageSku(target.months);
		case 'visionary':
			return VISIONARY_SKU;
		case 'bundle':
			return target.sku;
	}
}

function sameIds(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
	return a.length === b.length && a.every((id, index) => id === b[index]);
}

export class ShopCheckoutFlow {
	state: ShopCheckoutState = 'quoting';
	quote: ShopQuoteResponse | null = null;
	order: ShopOrderResponse | null = null;
	// The server's own words, for a refusal the dialog has no text of its own for.
	failureMessage: string | null = null;
	// A rate limit that lasts longer than a minute: the daily order bucket.
	waitMinutes: number | null = null;
	// Taken from the catalog when the quote is asked for, so an item taken off sale meanwhile still shows.
	item: CosmeticItemResponse | null = null;
	// A bundle as the catalog showed it; once the order opens, its items are the ones the order froze.
	bundle: {name: string; items: Array<CosmeticItemResponse>} | null = null;
	checking = false;
	private sku = '';
	private quoteRequest = 0;
	private pollIndex = 0;
	private lastCheckAt = Number.NEGATIVE_INFINITY;
	private pollTimer: ReturnType<typeof setTimeout> | null = null;
	private limitTimer: ReturnType<typeof setTimeout> | null = null;
	private watchers: Array<IReactionDisposer> = [];
	private disposed = false;

	constructor(private readonly kind: ShopCheckoutTarget['kind']) {
		makeAutoObservable(this, {}, {autoBind: true});
	}

	// What the success view shows; the premium end and the Visionary number follow USER_UPDATE.
	get success(): ShopEquippedSuccessResult | null {
		if (this.state !== 'approved') return null;
		const user = Users.currentUser;
		if (this.kind === 'premium') return {kind: 'premium', premiumUntil: user?.premiumUntil?.toISOString() ?? null};
		if (this.kind === 'visionary') return {kind: 'visionary', number: user?.premiumLifetimeSequence ?? null};
		if (this.kind === 'bundle') return this.bundle ? {kind: 'bundle', ...this.bundle} : null;
		return this.item ? {kind: 'item', item: this.item} : null;
	}

	// What the purchase gives to wear: the item, or the bundle's items.
	private get items(): Array<CosmeticItemResponse> {
		return this.kind === 'bundle' ? (this.bundle?.items ?? []) : this.item ? [this.item] : [];
	}

	// The price is fixed once an order exists, so only a dialog without one asks again.
	async quoteFor(sku: string): Promise<void> {
		if (this.order) return;
		this.sku = sku;
		const entry = ShopCatalog.entryForSku(sku);
		if (entry?.kind === 'item') this.item = entry.item;
		if (entry?.kind === 'bundle') this.bundle = {name: entry.bundle.name, items: entry.bundle.items};
		this.state = 'quoting';
		this.quote = null;
		this.failureMessage = null;
		this.waitMinutes = null;
		const request = ++this.quoteRequest;
		try {
			const quote = await ShopCommands.fetchQuote(sku);
			runInAction(() => {
				if (request !== this.quoteRequest || this.disposed) return;
				this.quote = quote;
				this.state = 'ready';
			});
		} catch (error) {
			runInAction(() => {
				if (request === this.quoteRequest && !this.disposed) this.refuse(error);
			});
		}
	}

	// The client sends the sku and nothing else; the server prices the order again.
	async start(): Promise<void> {
		if (this.state !== 'ready' || !this.quote) return;
		const quote = this.quote;
		this.state = 'creating';
		try {
			const order = await ShopCommands.createOrder(this.sku);
			// The Payriff order is open from here on; kept at once, so nothing after this can lose it.
			runInAction(() => {
				this.order = order;
			});
			const shownIds = this.bundle?.items.map((item) => item.id) ?? [];
			const orderItems = this.bundle ? await this.itemsOf(order.item_ids ?? []) : null;
			runInAction(() => {
				if (this.disposed) return;
				// The catalog on screen may be older than the bundle: the order's list is what gets paid for, so a
				// different one, even in another order, is shown before any payment page opens.
				if (this.bundle && orderItems) {
					this.bundle = {name: this.bundle.name, items: orderItems};
					if (!sameIds(order.item_ids ?? [], shownIds)) {
						this.state = 'contents_changed';
						void ShopCatalog.load(true);
						return;
					}
				}
				if (order.final_usd_cents !== quote.final_usd_cents || order.amount_azn_minor !== quote.amount_azn_minor) {
					this.state = 'price_changed';
					return;
				}
				this.state = 'payment_ready';
			});
		} catch (error) {
			runInAction(() => {
				if (!this.disposed) this.refuse(error);
			});
		}
	}

	// Runs in the click that confirms the order's price note; the waiting dialog keeps a button to reopen the page.
	openPaymentPage(): void {
		if (this.state === 'price_changed' || this.state === 'contents_changed' || this.state === 'payment_ready') {
			this.beginWaiting();
		}
		const url = this.order?.payment_url;
		if (url) void openExternalUrl(url);
	}

	// Back to a fresh quote: a declined or refused attempt keeps nothing.
	retry(): void {
		this.stopWaiting();
		this.order = null;
		void this.quoteFor(this.sku);
	}

	async checkAgain(): Promise<void> {
		if (this.state === 'timeout') await this.check();
	}

	// The item came another way meanwhile (a code or an admin); putting it on ends the dialog as a success.
	async equip(): Promise<void> {
		const item = this.item;
		if (this.state !== 'already_owned' || !item || this.checking) return;
		this.checking = true;
		try {
			await Cosmetics.equip({[item.type as CosmeticType]: item.id});
			runInAction(() => this.approve());
		} catch {
			// Still owned and not worn; the button can be pressed again.
		} finally {
			runInAction(() => {
				this.checking = false;
			});
		}
	}

	dispose(): void {
		this.disposed = true;
		this.stopWaiting();
	}

	// The order's items in its order. Items the catalog on screen did not have (bundle-only ones the admin added) are
	// read by ID, or, if that read fails, named by the reloaded catalog's bundle. One deleted since is left out, as
	// delivery skips it too; so is one neither read names, which delivery still gives.
	private async itemsOf(ids: ReadonlyArray<string>): Promise<Array<CosmeticItemResponse>> {
		const known = new Map(this.items.map((item) => [item.id, item]));
		const missing = ids.filter((id) => !known.has(id));
		if (missing.length > 0) {
			try {
				for (const item of await CosmeticCommands.fetchItems(missing)) known.set(item.id, item);
			} catch {
				await ShopCatalog.load(true);
				const entry = ShopCatalog.entryForSku(this.sku);
				if (entry?.kind === 'bundle') for (const item of entry.bundle.items) known.set(item.id, item);
			}
		}
		return ids.flatMap((id) => known.get(id) ?? []);
	}

	private beginWaiting(): void {
		this.state = 'awaiting';
		this.pollIndex = 0;
		this.schedulePoll();
		this.limitTimer = setTimeout(this.timeOut, POLL_LIMIT_MS);
		const premiumUntilBefore = Users.currentUser?.premiumUntil?.getTime() ?? 0;
		this.watchers = [
			// A USER_UPDATE that shows the purchase: the item is worn, premium runs longer, or the account went lifetime.
			reaction(
				() => {
					const user = Users.currentUser;
					switch (this.kind) {
						case 'item':
						case 'bundle':
							return this.items.some((item) => Cosmetics.equippedId(item.type as CosmeticType) === item.id);
						case 'premium':
							return (user?.premiumUntil?.getTime() ?? 0) > premiumUntilBefore;
						case 'visionary':
							return user?.premiumType === UserPremiumTypes.LIFETIME;
					}
				},
				(shown) => shown && this.checkSoon(),
			),
			// Back from the payment tab.
			reaction(
				() => WindowState.focused && WindowState.visible,
				(back) => back && this.checkSoon(),
			),
		];
	}

	private stopWaiting(): void {
		if (this.pollTimer) clearTimeout(this.pollTimer);
		if (this.limitTimer) clearTimeout(this.limitTimer);
		this.pollTimer = null;
		this.limitTimer = null;
		for (const dispose of this.watchers) dispose();
		this.watchers = [];
	}

	private schedulePoll(delayMs = POLL_DELAYS_MS[Math.min(this.pollIndex++, POLL_DELAYS_MS.length - 1)]): void {
		if (this.pollTimer) clearTimeout(this.pollTimer);
		this.pollTimer = setTimeout(this.poll, delayMs);
	}

	// At once, but never twice within 2 s: a focus return or a USER_UPDATE pulls the next poll forward.
	private checkSoon(): void {
		if (this.checking) return;
		this.schedulePoll(Math.max(0, this.lastCheckAt + EARLY_CHECK_GAP_MS - Date.now()));
	}

	private async poll(): Promise<void> {
		this.pollTimer = null;
		if (this.state !== 'awaiting') return;
		await this.check();
		runInAction(() => {
			if (this.state === 'awaiting' && !this.disposed) this.schedulePoll();
		});
	}

	private async check(): Promise<void> {
		const order = this.order;
		if (!order || this.checking) return;
		this.checking = true;
		this.lastCheckAt = Date.now();
		try {
			const current = await ShopCommands.fetchOrder(order.id);
			runInAction(() => {
				if (!this.disposed) this.settle(current);
			});
		} catch {
			// A failed read waits for the next poll.
		} finally {
			runInAction(() => {
				this.checking = false;
			});
		}
	}

	// Paid but not yet granted keeps waiting: "Equipped" is shown only once the item is on the account.
	private settle(current: ShopOrderResponse): void {
		switch (current.status) {
			case 'granted':
				this.approve();
				return;
			case 'failed':
				this.finish(current.failure_reason === 'amount_mismatch' ? 'failed_mismatch' : 'failed');
				return;
			case 'expired':
				this.finish('failed');
				return;
		}
	}

	private approve(): void {
		this.finish('approved');
		if (this.kind === 'item' || this.kind === 'bundle') {
			void Cosmetics.load();
			// The effect lives on the profile, which no gateway event updates.
			if (this.items.some((item) => item.type === 'profile_effect')) UserProfileCommands.clearCurrentUserProfiles();
		}
		// The premium member discount and the Visionary stock change with a purchase.
		void ShopCatalog.load(true);
	}

	private timeOut(): void {
		if (this.state === 'awaiting') this.finish('timeout');
	}

	private finish(state: ShopCheckoutState): void {
		this.stopWaiting();
		this.state = state;
	}

	private refuse(error: unknown): void {
		this.stopWaiting();
		const code = failureCode(error);
		if (code === APIErrorCodes.SHOP_SALES_CLOSED || code === APIErrorCodes.SHOP_ITEM_UNAVAILABLE) {
			this.state =
				code === APIErrorCodes.SHOP_ITEM_UNAVAILABLE && this.kind === 'visionary' ? 'sold_out' : 'sales_closed';
			void ShopCatalog.load(true);
			return;
		}
		if (code === APIErrorCodes.COSMETIC_ALREADY_OWNED) {
			this.state = 'already_owned';
			return;
		}
		this.state = 'busy';
		const rateLimited = error instanceof HttpError && error.status === 429;
		// The per-minute order bucket and the global limit ask for seconds, the daily one for up to 72 minutes.
		const waitSeconds = rateLimited ? (failureRetryAfter(error) ?? 0) : 0;
		this.waitMinutes = waitSeconds > 60 ? Math.ceil(waitSeconds / 60) : null;
		// Too many open orders, or a refusal nobody planned for: the server's localized message says why.
		const plainBusy = code === undefined || code === APIErrorCodes.SHOP_BUSY || rateLimited;
		this.failureMessage = plainBusy ? null : (failureMessage(error) ?? null);
	}
}

export function useShopCheckout(target: ShopCheckoutTarget): ShopCheckoutFlow {
	const {i18n} = useLingui();
	const [flow] = useState(() => new ShopCheckoutFlow(target.kind));
	const sku = shopCheckoutSku(target);
	useEffect(() => {
		void flow.quoteFor(sku);
	}, [flow, sku]);
	useEffect(
		() => () => {
			// Closed while waiting: the server still delivers a payment that goes through.
			if (flow.state === 'awaiting') {
				ToastCommands.createToast({type: 'info', children: i18n._(PURCHASE_ADDED_ONCE_CONFIRMED_DESCRIPTOR)});
			}
			flow.dispose();
		},
		[flow],
	);
	return flow;
}

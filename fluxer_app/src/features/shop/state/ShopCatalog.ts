// SPDX-License-Identifier: AGPL-3.0-or-later

import {ResettableStates} from '@app/features/app/state/ResettableStates';
import {AccountScopedWork} from '@app/features/platform/state/AccountScopedWork';

import SessionManager from '@app/features/platform/state/AuthSession';
import * as ShopCommands from '@app/features/shop/commands/ShopCommands';
import {
	itemSku,
	type ShopBundleEntry,
	type ShopEntry,
	type ShopItemEntry,
	type ShopPackageEntry,
} from '@app/features/shop/utils/ShopEntries';
import {campaignShown} from '@app/features/shop/utils/ShopPriceFormat';
import type {
	ShopPriceResponse,
	ShopSettingsResponse,
	ShopVisionaryResponse,
} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {makeAutoObservable, runInAction} from 'mobx';

// The catalog is the same for every account apart from the viewer flag, so a session reads it at most every five
// minutes. Card prices are display only: the checkout shows the server's quote and the order is priced again.
const CATALOG_TTL_MS = 5 * 60 * 1000;
// setTimeout fires at once above this; a later campaign end is waited for in steps.
const MAX_TIMER_MS = 2_147_483_647;

class ShopCatalog {
	status: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
	settings: ShopSettingsResponse | null = null;
	itemEntries: Array<ShopItemEntry> = [];
	packageEntries: Array<ShopPackageEntry> = [];
	bundleEntries: Array<ShopBundleEntry> = [];
	visionary: ShopVisionaryResponse | null = null;
	serverTimeOffsetMs = 0;
	premiumDiscount = false;
	private generation = 0;
	private loadedAt = 0;
	private loadedFor: string | null = null;
	private pending: Promise<void> | null = null;
	private tryRateExpiryTimer: ReturnType<typeof setTimeout> | null = null;
	// Moves when a shown campaign ends; now() reads it, so everything drawn from the clock is drawn again.
	private campaignClock = 0;
	private campaignTimer: ReturnType<typeof setTimeout> | null = null;

	constructor() {
		makeAutoObservable<this, 'tryRateExpiryTimer' | 'campaignTimer' | 'generation'>(
			this,
			{tryRateExpiryTimer: false, campaignTimer: false, generation: false},
			{autoBind: true},
		);
	}

	// viewer.premium_discount belongs to one account, so a switched account reads the catalog again.
	load(force = false): Promise<void> {
		if (AccountScopedWork.isSuspended) return Promise.resolve();
		this.refreshTryRateExpiry();
		const fresh =
			this.status === 'ready' &&
			this.loadedFor === SessionManager.currentAccountKey &&
			Date.now() - this.loadedAt < CATALOG_TTL_MS;
		if (!this.pending && (force || !fresh)) {
			this.pending = this.fetchCatalog();
		}
		return this.pending ?? Promise.resolve();
	}

	reset(): void {
		this.generation++;
		if (this.tryRateExpiryTimer !== null) clearTimeout(this.tryRateExpiryTimer);
		this.tryRateExpiryTimer = null;
		if (typeof document !== 'undefined')
			document.removeEventListener('visibilitychange', this.onTryRateVisibilityChange);
		this.status = 'idle';
		this.settings = null;
		this.itemEntries = [];
		this.packageEntries = [];
		this.bundleEntries = [];
		this.visionary = null;
		this.serverTimeOffsetMs = 0;
		this.premiumDiscount = false;
		this.loadedAt = 0;
		this.loadedFor = null;
		this.pending = null;
	}

	private async fetchCatalog(): Promise<void> {
		const generation = this.generation;
		if (this.status !== 'ready') this.status = 'loading';
		const viewerId = SessionManager.currentAccountKey;
		try {
			const catalog = await ShopCommands.fetchCatalog();
			runInAction(() => {
				if (generation !== this.generation) return;
				this.settings = catalog.settings;
				this.itemEntries = catalog.items.map(({item, price}) => ({kind: 'item', sku: itemSku(item.id), item, price}));
				this.packageEntries = catalog.packages.map(({sku, months, price}) => ({kind: 'package', sku, months, price}));
				this.bundleEntries = (catalog.bundles ?? []).map((bundle) => ({
					kind: 'bundle',
					sku: bundle.sku,
					bundle,
					price: bundle.price,
				}));
				this.visionary = catalog.visionary;
				this.premiumDiscount = catalog.viewer.premium_discount;
				this.serverTimeOffsetMs = Date.parse(catalog.server_time) - Date.now();
				this.refreshTryRateExpiry();
				this.refreshCampaignEnd();
				this.loadedAt = Date.now();
				this.loadedFor = viewerId;
				this.status = 'ready';
			});
		} catch {
			// A failed reload in the background keeps the catalog it had on screen.
			runInAction(() => {
				if (generation !== this.generation) return;
				this.refreshTryRateExpiry();
				if (this.status !== 'ready') this.status = 'failed';
			});
		} finally {
			runInAction(() => {
				if (generation !== this.generation) return;
				this.pending = null;
			});
		}
	}

	// One local timer for the catalog, never a fetch or a timer per price. Overrides have no expiry.
	private refreshTryRateExpiry(): void {
		if (this.tryRateExpiryTimer !== null) clearTimeout(this.tryRateExpiryTimer);
		this.tryRateExpiryTimer = null;
		if (typeof document !== 'undefined')
			document.removeEventListener('visibilitychange', this.onTryRateVisibilityChange);
		const settings = this.settings;
		if (settings?.try_to_azn_rate_micro == null || !settings.try_rate_expires_at) return;
		const remaining = Date.parse(settings.try_rate_expires_at) - this.now();
		if (remaining <= 0) {
			settings.try_to_azn_rate_micro = null;
			return;
		}
		this.tryRateExpiryTimer = setTimeout(this.refreshTryRateExpiry, remaining);
		if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onTryRateVisibilityChange);
	}

	// One timer for the catalog, at the first shown campaign's end among every price it sells.
	private refreshCampaignEnd(): void {
		if (this.campaignTimer !== null) clearTimeout(this.campaignTimer);
		this.campaignTimer = null;
		const now = this.now();
		const prices: Array<ShopPriceResponse | null> = [
			...this.itemEntries.map((entry) => entry.price),
			...this.bundleEntries.map((entry) => entry.price),
			...this.packageEntries.map((entry) => entry.price),
			this.visionary?.price ?? null,
		];
		const ends = prices.flatMap((price) =>
			price?.campaign_ends_at && campaignShown(price, now) ? [Date.parse(price.campaign_ends_at)] : [],
		);
		if (ends.length === 0) return;
		this.campaignTimer = setTimeout(this.onCampaignEnd, Math.min(Math.min(...ends) - now + 1, MAX_TIMER_MS));
	}

	private onCampaignEnd(): void {
		this.campaignClock++;
		this.refreshCampaignEnd();
	}

	private onTryRateVisibilityChange(): void {
		if (document.visibilityState === 'visible') this.refreshTryRateExpiry();
	}

	// Visionary is not a shop entry: it lives in `visionary` and the premium page sells it.
	entryForSku(sku: string): ShopEntry | null {
		return (
			this.itemEntries.find((entry) => entry.sku === sku) ??
			this.packageEntries.find((entry) => entry.sku === sku) ??
			this.bundleEntries.find((entry) => entry.sku === sku) ??
			null
		);
	}

	// Campaign countdowns run on the server's clock.
	now(): number {
		void this.campaignClock;
		return Date.now() + this.serverTimeOffsetMs;
	}

	get premiumIncludedCount(): number {
		return this.itemEntries.filter((entry) => entry.item.availability === 'premium').length;
	}
}

const shopCatalog = new ShopCatalog();
ResettableStates.register(shopCatalog, shopCatalog.reset);
AccountScopedWork.registerCancellation(() => shopCatalog.reset());

export default shopCatalog;

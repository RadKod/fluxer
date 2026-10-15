// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BadgeRepository} from '@app/api/badge/BadgeRepository';
import {PIONEER_NUMBER_TOKEN} from '@app/api/badge/PioneerService';
import {Config} from '@app/api/Config';
import type {CosmeticRepository} from '@app/api/cosmetics/CosmeticRepository';
import type {CosmeticService} from '@app/api/cosmetics/CosmeticService';
import type {CosmeticItemRow} from '@app/api/database/types/CosmeticTypes';
import {SHOP_PRICE_CATALOG, type ShopBundleRow, type ShopPriceRow} from '@app/api/database/types/ShopTypes';
import type {ISnowflakeService} from '@app/api/infrastructure/ISnowflakeService';
import type {InstanceConfigRepository, ShopConfig} from '@app/api/instance/InstanceConfigRepository';
import {getCachedInstancePremiumMode} from '@app/api/limits/InstancePremiumModeCache';
import type {User} from '@app/api/models/User';
import type {PremiumLedgerRepository} from '@app/api/premium/ledger/PremiumLedgerRepository';
import {isShopPaymentProviderConfigured} from '@app/api/shop/ShopPaymentProvider';
import type {ShopPriceRepository} from '@app/api/shop/ShopPriceRepository';
import {
	bundleSku,
	computeShopPrice,
	isPaidPremiumForShop,
	isSellable,
	parseShopSku,
	type ShopPriceBreakdown,
	sellsAsCosmetic,
} from '@app/api/shop/ShopPricing';
import {assertUserCanPurchase} from '@app/api/stripe/services/StripeCheckoutService';
import {checkIsPremium} from '@app/api/user/UserHelpers';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {FeatureNotAvailableSelfHostedError} from '@fluxer/errors/src/domains/core/FeatureNotAvailableSelfHostedError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {NotFoundError} from '@fluxer/errors/src/domains/core/NotFoundError';
import {ShopItemUnavailableError} from '@fluxer/errors/src/domains/payment/ShopItemUnavailableError';
import {ShopSalesClosedError} from '@fluxer/errors/src/domains/payment/ShopSalesClosedError';
import {CosmeticAlreadyOwnedError} from '@fluxer/errors/src/domains/user/CosmeticAlreadyOwnedError';
import {
	type CosmeticItemResponse,
	CosmeticItemType,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {
	ApplyShopCampaignRequest,
	CreateShopBundleRequest,
	SetShopPricesRequest,
	ShopAdminBundle,
	ShopAdminHealth,
	ShopAdminResponse,
	ShopAdminSettingsResponse,
	UpdateShopBundleRequest,
	UpdateShopSettingsRequest,
} from '@fluxer/schema/src/domains/shop/ShopAdminSchemas';
import type {
	ShopBundleResponse,
	ShopCatalogItemResponse,
	ShopCatalogResponse,
	ShopPackageResponse,
	ShopPriceResponse,
} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

// VisionaryService in production; the catalog depends on this read only, never on the Visionary service itself.
export interface VisionaryStockReader {
	getStock(): Promise<{total: number; remaining: number}>;
}

export interface ShopCatalogServiceDeps {
	priceRepository: ShopPriceRepository;
	badgeRepository: Pick<BadgeRepository, 'getBadge'>;
	cosmeticService: CosmeticService;
	cosmeticRepository: CosmeticRepository;
	instanceConfigRepository: InstanceConfigRepository;
	premiumLedgerRepository: PremiumLedgerRepository;
	kvClient: IKVProvider;
	visionaryStock: VisionaryStockReader;
	snowflakeService: ISnowflakeService;
}

export interface PreparedCheckout {
	sku: string;
	kind: 'cosmetic' | 'premium' | 'visionary' | 'bundle';
	item: CosmeticItemRow | null;
	months: 1 | 3 | 12 | null;
	price: ShopPriceBreakdown;
	// Bundles only: the items in bundle order, from the bundle row this check read.
	bundle: {name: string; itemIds: Array<bigint>} | null;
}

// 'cached': the pubsub-refreshed settings and the 5 s price list. 'direct': both straight from their tables — only for
// order creation, under the per-user create lock, including the reuse comparison.
export type ShopReads = 'cached' | 'direct';

type SharedCatalog = Omit<ShopCatalogResponse, 'server_time' | 'viewer'>;
// The shop tab's answer and the on-sale map it was built from, which cached bundle quotes reuse.
type CachedCatalog = {
	expiresAt: number;
	value: SharedCatalog;
	onSale: ReadonlyMap<string, CosmeticItemResponse>;
	config: ShopConfig;
};
type PriceFields = Pick<ShopPriceRow, 'sku' | 'base_try_minor' | 'campaign_percent' | 'campaign_ends_at'>;

const PACKAGE_MONTHS = [1, 3, 12] as const;
// TEMPORARY: each API process keeps the shared catalog for 60 s and
// the price and bundle lists for 5 s, so a campaign end shows up to 60 s late (the amount charged is read straight at
// order creation). Trigger: complaints about late campaign ends, or more than 2 000 reads/s on shop_prices['default'],
// shop_bundles['default'] or instance_configuration['shop_config']. Path: keep the price and bundle lists in a KV
// pubsub-refreshed process cache as InstanceConfigCache does.
const CATALOG_CACHE_MS = 60_000;
const PRICE_CACHE_MS = 5_000;
// shop_bundles['default'] stays one bounded partition; a bundle delivery holds its order lock
// 10 s longer per item (ShopOrderService), 130 s at 10 items.
const MAX_BUNDLES = 200;
const MIN_BUNDLE_ITEMS = 2;
const MAX_BUNDLE_ITEMS = 10;
const HOUR_MS = 3_600_000;
const VISIONARY_STOCK_KEY = 'shop:visionary:stock';

export function assertShopAvailable(): void {
	if (!Config.instance.selfHosted || getCachedInstancePremiumMode() !== 'mirror') {
		throw new FeatureNotAvailableSelfHostedError();
	}
}

// The premium member discount only ever applies to items and bundles; packages and Visionary take campaigns only.
function priceOf(row: PriceFields, config: ShopConfig, memberDiscount: boolean, now: Date): ShopPriceBreakdown {
	return computeShopPrice({
		baseTryMinor: row.base_try_minor,
		campaignPercent: row.campaign_percent ?? null,
		campaignEndsAt: row.campaign_ends_at ?? null,
		premiumPercent: config.premium_discount_percent,
		applyPremium: memberDiscount,
		now,
	});
}

function priceResponse(row: PriceFields, config: ShopConfig, now: Date): ShopPriceResponse {
	const price = priceOf(row, config, sellsAsCosmetic(parseShopSku(row.sku)), now);
	const campaign = price.campaignPercent > 0;
	return {
		base_try_minor: row.base_try_minor,
		campaign_percent: campaign ? price.campaignPercent : null,
		campaign_ends_at: campaign ? (row.campaign_ends_at?.toISOString() ?? null) : null,
		sale_try_minor: price.campaignTryMinor,
		premium_try_minor: price.premiumPercent > 0 ? price.finalTryMinor : null,
	};
}

// Admin writes check the worst stacking (campaign and, on items, the member discount) so no product ends below
// ₺1; order creation checks again.
function assertSellable(row: PriceFields, config: ShopConfig, path: string, now: Date): void {
	if (!isSellable(priceOf(row, config, sellsAsCosmetic(parseShopSku(row.sku)), now))) {
		throw InputValidationError.create(
			path,
			`Final price would be below ₺1 for ${row.sku}; raise the price or lower the discount`,
		);
	}
}

// One badge for the whole programme: once it has opened, every take-back and backfill means that one badge.
function assertEarlyPlusChange(current: ShopConfig, next: Partial<ShopConfig>): void {
	const open = next.early_plus_open ?? current.early_plus_open;
	const badgeId = next.early_plus_badge_id === undefined ? current.early_plus_badge_id : next.early_plus_badge_id;
	if (open && badgeId === null) {
		throw InputValidationError.create('early_plus_open', 'Choose the Early Plus badge before opening it');
	}
	if (current.early_plus_opened_once && badgeId !== current.early_plus_badge_id) {
		throw InputValidationError.create(
			'early_plus_badge_id',
			'The Early Plus badge is fixed once Early Plus has opened',
		);
	}
}

function adminBundle(row: ShopBundleRow): ShopAdminBundle {
	return {
		id: `${row.bundle_id}`,
		sku: bundleSku(row.bundle_id),
		name: row.name,
		description: row.description ?? null,
		item_ids: row.item_ids.map(String),
	};
}

// The bundle's items in bundle order when every one is on sale (the catalog holds on-sale items only), owned-availability
// and not a Visionary reward; null otherwise, and the bundle is neither shown nor sold.
function bundleItemsOnSale(
	bundle: ShopBundleRow,
	onSale: ReadonlyMap<string, CosmeticItemResponse>,
	config: ShopConfig,
): Array<CosmeticItemResponse> | null {
	const items = bundle.item_ids.map((id) => onSale.get(`${id}`));
	return items.every((item) => item?.availability === 'owned' && !config.visionary_reward_item_ids.includes(item.id))
		? (items as Array<CosmeticItemResponse>)
		: null;
}

// The one item rule of admin bundle writes and order creation: a known type, owned
// availability, on sale (priced or not: a bundle-only item has no price of its own) and not a Visionary reward.
function isSellableBundleItem(item: CosmeticItemRow, config: ShopConfig, onSale: boolean): boolean {
	return (
		CosmeticItemType.safeParse(item.item_type).success &&
		item.availability === 'owned' &&
		onSale &&
		!config.visionary_reward_item_ids.includes(`${item.item_id}`)
	);
}

// Audit form of one price or campaign change, `sku:old→new` ('none' for no price or no campaign); unchanged is left out.
function auditChange(sku: string, before: string, after: string): Array<string> {
	return before === after ? [] : [`${sku}:${before}→${after}`];
}

function campaignOf(row: PriceFields | undefined): string {
	if (row?.campaign_percent == null) return 'none';
	return row.campaign_ends_at
		? `${row.campaign_percent}%@${row.campaign_ends_at.toISOString()}`
		: `${row.campaign_percent}%`;
}

function counter(value: string | null): number {
	const count = Number(value);
	return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

export class ShopCatalogService {
	private catalogCache: CachedCatalog | null = null;
	private priceCache: {expiresAt: number; rows: Map<string, ShopPriceRow>} | null = null;
	private bundleCache: {expiresAt: number; rows: Map<bigint, ShopBundleRow>} | null = null;

	constructor(readonly deps: ShopCatalogServiceDeps) {}

	clearCachesForTesting(): void {
		this.catalogCache = null;
		this.priceCache = null;
		this.bundleCache = null;
	}

	async getCatalog(user: User): Promise<ShopCatalogResponse> {
		assertShopAvailable();
		const [cached, premiumDiscount] = await Promise.all([this.sharedCatalog(), this.premiumDiscountFor(user)]);
		return {
			...cached.value,
			server_time: new Date().toISOString(),
			viewer: {premium_discount: premiumDiscount},
		};
	}

	quote(user: User, sku: string): Promise<PreparedCheckout> {
		return this.check(user, sku, 'cached', false);
	}

	prepareCheckout(user: User, sku: string, reads: ShopReads): Promise<PreparedCheckout> {
		return this.check(user, sku, reads, true);
	}

	async premiumDiscountFor(user: User): Promise<boolean> {
		if (!checkIsPremium(user)) return false;
		return isPaidPremiumForShop(user, await this.deps.premiumLedgerRepository.find(user.id));
	}

	async getAdminView(): Promise<ShopAdminResponse> {
		const [config, rows, health, bundles] = await Promise.all([
			this.deps.instanceConfigRepository.readStoredShopConfig(),
			this.deps.priceRepository.listPrices(),
			this.readHealth(),
			this.deps.priceRepository.listBundles(),
		]);
		const now = new Date();
		return {
			settings: this.adminSettings(config),
			prices: rows.map((row) => ({
				sku: row.sku,
				base_try_minor: row.base_try_minor,
				campaign_percent: row.campaign_percent ?? null,
				campaign_ends_at: row.campaign_ends_at?.toISOString() ?? null,
				now: priceResponse(row, config, now),
			})),
			health,
			bundles: bundles.map(adminBundle),
		};
	}

	adminSettings(config: ShopConfig): ShopAdminSettingsResponse {
		return {
			premium_sales_open: config.premium_sales_open,
			item_sales_open: config.item_sales_open,
			premium_discount_percent: config.premium_discount_percent,
			payment_provider_configured: isShopPaymentProviderConfigured(),
			visionary_on_sale: config.visionary_on_sale,
			visionary_reward_item_ids: config.visionary_reward_item_ids,
			early_plus_badge_id: config.early_plus_badge_id,
			early_plus_open: config.early_plus_open,
			early_plus_opened_once: config.early_plus_opened_once,
		};
	}

	async updateSettings(patch: UpdateShopSettingsRequest): Promise<{before: ShopConfig; after: ShopConfig}> {
		const {visionary_reward_item_ids: rewardIds, early_plus_badge_id: earlyPlusBadgeId, ...switches} = patch;
		const rows = await this.deps.priceRepository.listPrices();
		const next = Object.fromEntries(
			Object.entries(switches).filter(([, value]) => value !== undefined),
		) as Partial<ShopConfig>;
		if (rewardIds !== undefined) next.visionary_reward_item_ids = await this.checkRewardItems(rewardIds, rows);
		if (earlyPlusBadgeId !== undefined) {
			next.early_plus_badge_id = earlyPlusBadgeId === null ? null : await this.checkEarlyPlusBadge(earlyPlusBadgeId);
		}
		const now = new Date();
		let before = null as ShopConfig | null;
		const after = await this.deps.instanceConfigRepository.updateShopConfig((current) => {
			before = current;
			for (const row of rows) assertSellable(row, {...current, ...next}, 'settings', now);
			assertEarlyPlusChange(current, next);
			return {
				...next,
				...(next.early_plus_open && !current.early_plus_opened_once ? {early_plus_opened_once: true} : {}),
			};
		});
		return {before: before!, after};
	}

	async createBundle(request: CreateShopBundleRequest): Promise<ShopAdminBundle> {
		if ((await this.deps.priceRepository.listBundles()).length >= MAX_BUNDLES) {
			throw InputValidationError.create('name', `At most ${MAX_BUNDLES} bundles; delete one first`);
		}
		const itemIds = await this.checkBundleItems(request.item_ids);
		const now = new Date();
		const row: ShopBundleRow = {
			catalog: SHOP_PRICE_CATALOG,
			bundle_id: await this.deps.snowflakeService.generate(),
			name: request.name,
			description: request.description ?? null,
			item_ids: itemIds,
			created_at: now,
			updated_at: now,
		};
		await this.deps.priceRepository.putBundle(row);
		return adminBundle(row);
	}

	async updateBundle(
		bundleId: bigint,
		request: UpdateShopBundleRequest,
	): Promise<{before: ShopAdminBundle; after: ShopAdminBundle}> {
		const current = await this.requireBundle(bundleId);
		const row: ShopBundleRow = {
			...current,
			name: request.name ?? current.name,
			description: request.description === undefined ? current.description : request.description,
			item_ids: request.item_ids ? await this.checkBundleItems(request.item_ids) : current.item_ids,
			updated_at: new Date(),
		};
		await this.deps.priceRepository.putBundle(row);
		return {before: adminBundle(current), after: adminBundle(row)};
	}

	// The price row goes with the bundle; open and paid orders keep the item list frozen in them.
	async deleteBundle(bundleId: bigint): Promise<ShopAdminBundle> {
		const current = await this.requireBundle(bundleId);
		await this.deps.priceRepository.deleteBundle(bundleId);
		return adminBundle(current);
	}

	// Returns the audit changes (`sku:old→new`).
	async setPrices(entries: SetShopPricesRequest['prices']): Promise<Array<string>> {
		const wanted = new Map(entries.map((entry) => [entry.sku, entry.base_try_minor]));
		const [config, rows] = await Promise.all([
			this.deps.instanceConfigRepository.readStoredShopConfig(),
			this.deps.priceRepository.listPrices(),
		]);
		const existing = new Map(rows.map((row) => [row.sku, row]));
		const itemIds = [...wanted].flatMap(([sku, base]) => {
			const ref = parseShopSku(sku);
			return base !== null && ref?.kind === 'cosmetic' ? [ref.itemId] : [];
		});
		const pricesBundle = [...wanted].some(([sku, base]) => base !== null && parseShopSku(sku)?.kind === 'bundle');
		const [items, bundles] = await Promise.all([
			this.deps.cosmeticRepository.getItems(itemIds),
			pricesBundle ? this.deps.priceRepository.listBundles() : [],
		]);
		const ownedItems = new Set(items.filter((item) => item.availability === 'owned').map((item) => `${item.item_id}`));
		const bundleIds = new Set(bundles.map((bundle) => bundle.bundle_id));
		const now = new Date();
		const puts: Array<ShopPriceRow> = [];
		const deletes: Array<string> = [];
		for (const [sku, base] of wanted) {
			if (base === null) {
				deletes.push(sku);
				continue;
			}
			const ref = parseShopSku(sku);
			if (ref?.kind === 'cosmetic') {
				const itemId = `${ref.itemId}`;
				if (!ownedItems.has(itemId)) {
					throw InputValidationError.create('prices', `Item ${itemId} is not an owned-availability item`);
				}
				if (config.visionary_reward_item_ids.includes(itemId)) {
					throw InputValidationError.create('prices', `Item ${itemId} is a Visionary reward and cannot be sold`);
				}
			}
			if (ref?.kind === 'bundle' && !bundleIds.has(ref.bundleId)) {
				throw InputValidationError.create('prices', `Bundle ${ref.bundleId} does not exist`);
			}
			const current = existing.get(sku);
			const row: ShopPriceRow = {
				catalog: SHOP_PRICE_CATALOG,
				sku,
				base_try_minor: base,
				campaign_percent: current?.campaign_percent ?? null,
				campaign_ends_at: current?.campaign_ends_at ?? null,
				updated_at: now,
			};
			assertSellable(row, config, 'prices', now);
			puts.push(row);
		}
		await Promise.all([this.deps.priceRepository.putPrices(puts), this.deps.priceRepository.deletePrices(deletes)]);
		return [...wanted].flatMap(([sku, base]) =>
			auditChange(sku, String(existing.get(sku)?.base_try_minor ?? 'none'), String(base ?? 'none')),
		);
	}

	async applyCampaign(request: ApplyShopCampaignRequest): Promise<Array<string>> {
		const [config, rows] = await Promise.all([
			this.deps.instanceConfigRepository.readStoredShopConfig(),
			this.deps.priceRepository.listPrices(),
		]);
		const existing = new Map(rows.map((row) => [row.sku, row]));
		const now = new Date();
		const endsAt = request.ends_at === null ? null : new Date(request.ends_at);
		if (endsAt !== null && endsAt.getTime() <= now.getTime()) {
			throw InputValidationError.create('ends_at', 'The campaign would end in the past');
		}
		const puts = [...new Set(request.skus)].map((sku) => {
			const current = existing.get(sku);
			if (!current) throw InputValidationError.create('skus', `${sku} has no price`);
			const row: ShopPriceRow = {
				...current,
				campaign_percent: request.percent,
				campaign_ends_at: endsAt,
				updated_at: now,
			};
			assertSellable(row, config, 'skus', now);
			return row;
		});
		await this.deps.priceRepository.putPrices(puts);
		return puts.flatMap((row) => auditChange(row.sku, campaignOf(existing.get(row.sku)), campaignOf(row)));
	}

	async removeCampaign(skus: ReadonlyArray<string>): Promise<Array<string>> {
		const wanted = new Set(skus);
		const now = new Date();
		const rows = (await this.deps.priceRepository.listPrices()).filter((row) => wanted.has(row.sku));
		await this.deps.priceRepository.putPrices(
			rows.map((row) => ({...row, campaign_percent: null, campaign_ends_at: null, updated_at: now})),
		);
		return rows.flatMap((row) => auditChange(row.sku, campaignOf(row), 'none'));
	}

	private async check(user: User, sku: string, reads: ShopReads, purchase: boolean): Promise<PreparedCheckout> {
		assertShopAvailable();
		if (purchase) assertUserCanPurchase(user);
		const ref = parseShopSku(sku);
		if (!ref) throw new ShopItemUnavailableError();
		const config =
			reads === 'direct'
				? await this.deps.instanceConfigRepository.readStoredShopConfig()
				: await this.deps.instanceConfigRepository.getShopConfig();
		const salesOpen = sellsAsCosmetic(ref) ? config.item_sales_open : config.premium_sales_open;
		if (!salesOpen || !isShopPaymentProviderConfigured()) throw new ShopSalesClosedError();
		if (ref.kind === 'visionary' && !config.visionary_on_sale) throw new ShopItemUnavailableError();
		const row =
			reads === 'direct'
				? await this.deps.priceRepository.getPrice(sku)
				: ((await this.cachedPrices()).get(sku) ?? null);
		if (!row) throw new ShopItemUnavailableError();
		let item: CosmeticItemRow | null = null;
		let bundle: PreparedCheckout['bundle'] = null;
		if (ref.kind === 'cosmetic') {
			item = await this.deps.cosmeticRepository.getItem(ref.itemId);
			if (
				!item ||
				!CosmeticItemType.safeParse(item.item_type).success ||
				item.availability !== 'owned' ||
				!(await this.deps.cosmeticRepository.isOnSale(item))
			) {
				throw new ShopItemUnavailableError();
			}
			if (await this.deps.cosmeticRepository.getOwned(user.id, item.item_id)) throw new CosmeticAlreadyOwnedError();
		} else if (ref.kind === 'bundle') {
			bundle = await this.checkBundle(user, ref.bundleId, config, reads);
		} else if (user.premiumType === UserPremiumTypes.LIFETIME) {
			throw new ShopItemUnavailableError();
		}
		const memberDiscount = sellsAsCosmetic(ref) && (await this.premiumDiscountFor(user));
		const now = new Date();
		const price = priceOf(row, config, memberDiscount, now);
		if (!isSellable(price)) throw new ShopItemUnavailableError();
		return {sku, kind: ref.kind, item, months: ref.kind === 'premium' ? ref.months : null, price, bundle};
	}

	// 'cached' (quotes): the bundle from the 5 s list and its items from the shop tab's on-sale
	// map. 'direct' (order creation under its user lock): the bundle row, one IN read of its items and at most 10
	// on-sale point reads. Ownership: at most 10 parallel point reads, never the account's whole cosmetics partition.
	private async checkBundle(
		user: User,
		bundleId: bigint,
		config: ShopConfig,
		reads: ShopReads,
	): Promise<{name: string; itemIds: Array<bigint>}> {
		const row =
			reads === 'direct'
				? await this.deps.priceRepository.getBundle(bundleId)
				: ((await this.cachedBundles()).get(bundleId) ?? null);
		if (!row) throw new ShopItemUnavailableError();
		const sellable =
			reads === 'direct'
				? await this.bundleItemsSellable(row.item_ids, config)
				: bundleItemsOnSale(row, (await this.sharedCatalog()).onSale, config) !== null;
		if (!sellable) throw new ShopItemUnavailableError();
		const owned = await Promise.all(
			row.item_ids.map((itemId) => this.deps.cosmeticRepository.getOwned(user.id, itemId)),
		);
		if (owned.some(Boolean)) throw new CosmeticAlreadyOwnedError();
		return {name: row.name, itemIds: row.item_ids};
	}

	private async bundleItemsSellable(ids: ReadonlyArray<bigint>, config: ShopConfig): Promise<boolean> {
		const items = await this.deps.cosmeticRepository.getItems([...ids]);
		if (items.length !== ids.length) return false;
		const onSale = await Promise.all(items.map((item) => this.deps.cosmeticRepository.isOnSale(item)));
		return items.every((item, index) => isSellableBundleItem(item, config, onSale[index]!));
	}

	// Admin writes: repeats are dropped in order, then 2–10 items, each passing isSellableBundleItem (şart 6).
	private async checkBundleItems(ids: ReadonlyArray<bigint>): Promise<Array<bigint>> {
		const unique = [...new Set(ids)];
		if (unique.length < MIN_BUNDLE_ITEMS || unique.length > MAX_BUNDLE_ITEMS) {
			throw InputValidationError.create(
				'item_ids',
				`A bundle holds ${MIN_BUNDLE_ITEMS}–${MAX_BUNDLE_ITEMS} different items`,
			);
		}
		const [config, items] = await Promise.all([
			this.deps.instanceConfigRepository.readStoredShopConfig(),
			this.deps.cosmeticRepository.getItems(unique),
		]);
		const onSale = await Promise.all(items.map((item) => this.deps.cosmeticRepository.isOnSale(item)));
		const sellable = new Set(
			items.filter((item, index) => isSellableBundleItem(item, config, onSale[index]!)).map((item) => item.item_id),
		);
		for (const id of unique) {
			if (sellable.has(id)) continue;
			throw InputValidationError.create(
				'item_ids',
				config.visionary_reward_item_ids.includes(`${id}`)
					? `Item ${id} is a Visionary reward and cannot be sold`
					: `Item ${id} is not an owned-availability item on sale`,
			);
		}
		return unique;
	}

	private async requireBundle(bundleId: bigint): Promise<ShopBundleRow> {
		const row = await this.deps.priceRepository.getBundle(bundleId);
		if (!row) throw new NotFoundError({code: APIErrorCodes.NOT_FOUND});
		return row;
	}

	private async sharedCatalog(): Promise<CachedCatalog> {
		const cached = this.catalogCache;
		if (cached && cached.expiresAt > Date.now()) return cached;
		const [config, prices, items, bundles] = await Promise.all([
			this.deps.instanceConfigRepository.getShopConfig(),
			this.cachedPrices(),
			this.deps.cosmeticService.listCatalog(),
			this.cachedBundles(),
		]);
		const onSale = new Map(items.map((item) => [item.id, item]));
		const now = new Date();
		const payments = isShopPaymentProviderConfigured();
		const visionaryRow = prices.get('visionary');
		const stock = visionaryRow ? await this.sharedVisionaryStock() : null;
		const value: SharedCatalog = {
			settings: {
				premium_sales_open: config.premium_sales_open && payments,
				item_sales_open: config.item_sales_open && payments,
				premium_discount_percent: config.premium_discount_percent,
			},
			items: items.flatMap((item): Array<ShopCatalogItemResponse> => {
				if (item.availability === 'premium') return [{item, price: null}];
				const row = item.availability === 'owned' ? prices.get(`cosmetic:${item.id}`) : undefined;
				return row ? [{item, price: priceResponse(row, config, now)}] : [];
			}),
			packages: PACKAGE_MONTHS.flatMap((months): Array<ShopPackageResponse> => {
				const row = prices.get(`premium:${months}`);
				return row ? [{sku: row.sku, months, price: priceResponse(row, config, now)}] : [];
			}),
			visionary:
				visionaryRow && stock
					? {
							sku: 'visionary',
							price: priceResponse(visionaryRow, config, now),
							total: stock.total,
							remaining: stock.remaining,
							visible: config.premium_sales_open && config.visionary_on_sale && payments,
						}
					: null,
			// Bundle items come embedded: a bundle-only item has no price, so it is not in items. TEMPORARY: up to 200 × 10 embedded items. Trigger: more than 20 priced bundles or a catalog answer over
			// 100 KB. Path: one deduplicated bundle_items list, bundles carrying item IDs.
			bundles: [...bundles.values()].flatMap((bundle): Array<ShopBundleResponse> => {
				const row = prices.get(bundleSku(bundle.bundle_id));
				const bundleItems = row ? bundleItemsOnSale(bundle, onSale, config) : null;
				return row && bundleItems
					? [
							{
								sku: row.sku,
								id: `${bundle.bundle_id}`,
								name: bundle.name,
								description: bundle.description ?? null,
								items: bundleItems,
								price: priceResponse(row, config, now),
							},
						]
					: [];
			}),
		};
		this.catalogCache = {expiresAt: Date.now() + CATALOG_CACHE_MS, value, onSale, config};
		return this.catalogCache;
	}

	// One stock read (a whole visionary_slots read) a minute for all API processes, not one per process: the catalog shows
	// `remaining` up to 60 s old anyway, and order creation decides.
	private async sharedVisionaryStock(): Promise<{total: number; remaining: number}> {
		const cached = await this.deps.kvClient.get(VISIONARY_STOCK_KEY);
		if (cached) return JSON.parse(cached) as {total: number; remaining: number};
		const {total, remaining} = await this.deps.visionaryStock.getStock();
		await this.deps.kvClient.setex(VISIONARY_STOCK_KEY, CATALOG_CACHE_MS / 1000, JSON.stringify({total, remaining}));
		return {total, remaining};
	}

	private async cachedPrices(): Promise<Map<string, ShopPriceRow>> {
		const cached = this.priceCache;
		if (cached && cached.expiresAt > Date.now()) return cached.rows;
		const rows = new Map((await this.deps.priceRepository.listPrices()).map((row) => [row.sku, row]));
		this.priceCache = {expiresAt: Date.now() + PRICE_CACHE_MS, rows};
		return rows;
	}

	private async cachedBundles(): Promise<Map<bigint, ShopBundleRow>> {
		const cached = this.bundleCache;
		if (cached && cached.expiresAt > Date.now()) return cached.rows;
		const rows = new Map((await this.deps.priceRepository.listBundles()).map((row) => [row.bundle_id, row]));
		this.bundleCache = {expiresAt: Date.now() + PRICE_CACHE_MS, rows};
		return rows;
	}

	private async checkRewardItems(
		ids: ReadonlyArray<bigint>,
		prices: ReadonlyArray<ShopPriceRow>,
	): Promise<Array<string>> {
		const unique = [...new Set(ids.map((id) => `${id}`))];
		const [items, bundles] = await Promise.all([
			this.deps.cosmeticRepository.getItems(unique.map((id) => BigInt(id))),
			this.deps.priceRepository.listBundles(),
		]);
		const owned = new Set(items.filter((item) => item.availability === 'owned').map((item) => `${item.item_id}`));
		const priced = new Set(prices.map((row) => row.sku));
		const bundled = new Set(bundles.flatMap((bundle) => bundle.item_ids.map(String)));
		for (const id of unique) {
			if (!owned.has(id)) {
				throw InputValidationError.create('visionary_reward_item_ids', `Item ${id} is not an owned-availability item`);
			}
			if (priced.has(`cosmetic:${id}`)) {
				throw InputValidationError.create('visionary_reward_item_ids', `Item ${id} has a shop price; remove it first`);
			}
			if (bundled.has(id)) {
				throw InputValidationError.create('visionary_reward_item_ids', `Item ${id} is in a bundle; take it out first`);
			}
		}
		return unique;
	}

	// A numbered badge ({n}) is given only with its own number, so it cannot be the Early Plus badge.
	private async checkEarlyPlusBadge(badgeId: bigint): Promise<string> {
		const badge = await this.deps.badgeRepository.getBadge(badgeId);
		if (!badge) throw InputValidationError.create('early_plus_badge_id', `Badge ${badgeId} does not exist`);
		if (badge.description.includes(PIONEER_NUMBER_TOKEN)) {
			throw InputValidationError.create('early_plus_badge_id', 'A numbered badge cannot be the Early Plus badge');
		}
		return `${badgeId}`;
	}

	// The temporary payment provider budget triggers: the busy counter per hour since the
	// epoch (floor(ms / 3 600 000)), the reconcile lag in seconds and the 429 back-off flag.
	private async readHealth(): Promise<ShopAdminHealth> {
		const hour = Math.floor(Date.now() / HOUR_MS);
		const [busyNow, busyBefore, lag, backoff] = await this.deps.kvClient.mget(
			`shop:busy:${hour}`,
			`shop:busy:${hour - 1}`,
			'shop:checks:lag',
			'payriff:backoff',
		);
		return {
			busy_refusals_last_hour: counter(busyNow) + counter(busyBefore),
			reconcile_lag_seconds: counter(lag),
			provider_backing_off: backoff !== null,
		};
	}
}

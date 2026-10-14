// SPDX-License-Identifier: AGPL-3.0-or-later

import {BatchBuilder, fetchMany, fetchOne, upsertOne} from '@app/api/database/CassandraQueryExecution';
import {SHOP_PRICE_CATALOG, type ShopBundleRow, type ShopPriceRow} from '@app/api/database/types/ShopTypes';
import {bundleSku} from '@app/api/shop/ShopPricing';
import {ShopBundles, ShopPrices} from '@app/api/shop/ShopTables';

const LIST_PRICES_CQL = ShopPrices.select({where: ShopPrices.where.eq('catalog')});
const FETCH_PRICE_CQL = ShopPrices.select({
	where: [ShopPrices.where.eq('catalog'), ShopPrices.where.eq('sku')],
	limit: 1,
});
const LIST_BUNDLES_CQL = ShopBundles.select({where: ShopBundles.where.eq('catalog')});
const FETCH_BUNDLE_CQL = ShopBundles.select({
	where: [ShopBundles.where.eq('catalog'), ShopBundles.where.eq('bundle_id')],
	limit: 1,
});

// One partition: the price list is admin-curated; writes are single-partition batches.
export class ShopPriceRepository {
	async listPrices(): Promise<Array<ShopPriceRow>> {
		return fetchMany<ShopPriceRow>(LIST_PRICES_CQL.bind({catalog: SHOP_PRICE_CATALOG}));
	}

	async getPrice(sku: string): Promise<ShopPriceRow | null> {
		return fetchOne<ShopPriceRow>(FETCH_PRICE_CQL.bind({catalog: SHOP_PRICE_CATALOG, sku}));
	}

	async putPrices(rows: Array<ShopPriceRow>): Promise<void> {
		if (rows.length === 0) return;
		const batch = new BatchBuilder();
		for (const row of rows) batch.addPrepared(ShopPrices.upsertAll(row));
		await batch.execute();
	}

	async deletePrices(skus: ReadonlyArray<string>): Promise<void> {
		if (skus.length === 0) return;
		const batch = new BatchBuilder();
		for (const sku of skus) batch.addPrepared(ShopPrices.deleteByPk({catalog: SHOP_PRICE_CATALOG, sku}));
		await batch.execute();
	}

	async listBundles(): Promise<Array<ShopBundleRow>> {
		return fetchMany<ShopBundleRow>(LIST_BUNDLES_CQL.bind({catalog: SHOP_PRICE_CATALOG}));
	}

	async getBundle(bundleId: bigint): Promise<ShopBundleRow | null> {
		return fetchOne<ShopBundleRow>(FETCH_BUNDLE_CQL.bind({catalog: SHOP_PRICE_CATALOG, bundle_id: bundleId}));
	}

	async putBundle(row: ShopBundleRow): Promise<void> {
		await upsertOne(ShopBundles.upsertAll(row));
	}

	// The bundle and its price row go together, so no price is left for a bundle that is gone.
	async deleteBundle(bundleId: bigint): Promise<void> {
		const batch = new BatchBuilder();
		batch.addPrepared(ShopPrices.deleteByPk({catalog: SHOP_PRICE_CATALOG, sku: bundleSku(bundleId)}));
		batch.addPrepared(ShopBundles.deleteByPk({catalog: SHOP_PRICE_CATALOG, bundle_id: bundleId}));
		await batch.execute();
	}
}

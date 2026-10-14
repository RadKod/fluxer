// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {Config} from '@app/api/Config';
import type {ShopConfig} from '@app/api/instance/InstanceConfigRepository';
import {getCachedInstancePremiumMode, setCachedInstancePremiumMode} from '@app/api/limits/InstancePremiumModeCache';
import {getShopCatalogService} from '@app/api/middleware/ServiceSingletons';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {ShopAdminBundle} from '@fluxer/schema/src/domains/shop/ShopAdminSchemas';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export async function createShopAdmin(harness: ApiTestHarness): Promise<TestAccount> {
	return setUserACLs(harness, await createTestAccount(harness), [
		AdminACLs.AUTHENTICATE,
		AdminACLs.SHOP_MANAGE,
		AdminACLs.COSMETICS_MANAGE,
		AdminACLs.INSTANCE_CONFIG_VIEW,
		AdminACLs.INSTANCE_CONFIG_UPDATE,
		AdminACLs.GIFT_CODES_GENERATE,
	]);
}

// openShop changes process-wide switches and vitest runs many files in one process: take this in beforeAll and call
// the result in afterAll.
export function saveShopEnvironment(): () => void {
	const selfHosted = Config.instance.selfHosted;
	const payriffEnabled = Config.payriff.enabled;
	const premiumMode = getCachedInstancePremiumMode();
	return () => {
		Config.instance.selfHosted = selfHosted;
		Config.payriff.enabled = payriffEnabled;
		setCachedInstancePremiumMode(premiumMode);
	};
}

export async function setPremiumMode(
	harness: ApiTestHarness,
	admin: TestAccount,
	premiumMode: 'mirror' | 'everyone',
): Promise<void> {
	await createBuilder(harness, admin.token)
		.patch('/admin/instance/config')
		.body({policy: {premium_mode: premiumMode}})
		.execute();
}

// Self-hosted in mirror mode, a payment provider (the fake Payriff) configured, both sales open. harness.reset() keeps service
// singletons, so this also empties the shop's process caches left by an earlier test.
export async function openShop(
	harness: ApiTestHarness,
	admin: TestAccount,
	settings: Partial<ShopConfig> = {},
): Promise<void> {
	getShopCatalogService().clearCachesForTesting();
	Config.instance.selfHosted = true;
	Config.payriff.enabled = true;
	await setPremiumMode(harness, admin, 'mirror');
	await createBuilder(harness, admin.token)
		.patch('/admin/shop/settings')
		.body({premium_sales_open: true, item_sales_open: true, ...settings})
		.execute();
}

export async function setPrices(
	harness: ApiTestHarness,
	admin: TestAccount,
	prices: Record<string, number | null>,
): Promise<void> {
	await createBuilder(harness, admin.token)
		.put('/admin/shop/prices')
		.body({prices: Object.entries(prices).map(([sku, base]) => ({sku, base_try_minor: base}))})
		.execute();
}

export async function createShopItem(
	harness: ApiTestHarness,
	admin: TestAccount,
	availability: 'free' | 'premium' | 'owned',
	name = `Item ${availability}`,
): Promise<CosmeticItemResponse> {
	return createBuilder<CosmeticItemResponse>(harness, admin.token)
		.post('/admin/cosmetics/items')
		.body({type: 'avatar_decoration', name, availability, asset: PNG})
		.execute();
}

export async function createBundle(
	harness: ApiTestHarness,
	admin: TestAccount,
	itemIds: ReadonlyArray<string>,
	name = 'Bundle',
): Promise<ShopAdminBundle> {
	return createBuilder<ShopAdminBundle>(harness, admin.token)
		.post('/admin/shop/bundles')
		.body({name, item_ids: itemIds})
		.execute();
}

// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {BatchBuilder, fetchMany} from '@app/api/database/CassandraQueryExecution';
import type {VisionarySlotRow} from '@app/api/database/types/PaymentTypes';
import {setCachedInstancePremiumMode} from '@app/api/limits/InstancePremiumModeCache';
import {getInstanceConfigRepository, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import type {User} from '@app/api/models/User';
import {VisionarySlots} from '@app/api/Tables';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Callers put 'everyone' back in afterEach: the premium mode cache is process wide and outlives the harness reset.
export async function premiumMode(mode: 'mirror' | 'everyone'): Promise<void> {
	await getInstanceConfigRepository().setInstancePolicyConfig({premium_mode: mode});
	setCachedInstancePremiumMode(mode);
}

export function mirrorMode(): Promise<void> {
	return premiumMode('mirror');
}

export async function readUser(userId: UserID): Promise<User> {
	return (await getUserRepository().findUnique(userId))!;
}

// A lifetime account written straight to the user row; endsInPast leaves the end fields a ledger repair would write.
export async function lifetimeUser(
	harness: ApiTestHarness,
	opts: {sequence: number; endsInPast?: boolean},
): Promise<{account: TestAccount; userId: UserID}> {
	const account = await createTestAccount(harness);
	const userId = createUserID(BigInt(account.userId));
	const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
	const user = await readUser(userId);
	await getUserRepository().patchUpsert(
		userId,
		{
			premium_type: UserPremiumTypes.LIFETIME,
			premium_lifetime_sequence: opts.sequence,
			premium_since: past,
			...(opts.endsInPast ? {premium_gift_extension_ends_at: past, premium_grace_ends_at: past} : {}),
		},
		user.toRow(),
	);
	return {account, userId};
}

export async function slotRows(): Promise<Array<VisionarySlotRow>> {
	const rows = await fetchMany<VisionarySlotRow>(VisionarySlots.selectCql(), {});
	return rows.sort((a, b) => a.slot_index - b.slot_index);
}

// Stripe test mode opens upstream's test slots at startup (VisionarySlotInitializer); a Micup instance starts with none.
export async function clearVisionarySlots(): Promise<void> {
	const batch = new BatchBuilder();
	for (const row of await slotRows()) {
		batch.addPrepared(VisionarySlots.deleteByPk({slot_index: row.slot_index}));
	}
	await batch.execute();
}

// Owned, unpriced items of the given slots, saved as the Visionary rewards; the admin needs SHOP_MANAGE and
// COSMETICS_MANAGE (ShopTestUtils.createShopAdmin).
export async function setRewardItems(
	harness: ApiTestHarness,
	admin: TestAccount,
	types: Array<'avatar_decoration' | 'nameplate'>,
): Promise<Array<CosmeticItemResponse>> {
	const items: Array<CosmeticItemResponse> = [];
	for (const type of types) {
		items.push(
			await createBuilder<CosmeticItemResponse>(harness, admin.token)
				.post('/admin/cosmetics/items')
				.body({type, name: `Reward ${type}`, availability: 'owned', asset: PNG})
				.execute(),
		);
	}
	await createBuilder(harness, admin.token)
		.patch('/admin/shop/settings')
		.body({visionary_reward_item_ids: items.map((item) => item.id)})
		.execute();
	return items;
}

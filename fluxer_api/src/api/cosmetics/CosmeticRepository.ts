// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {CosmeticGrants, CosmeticItems, CosmeticItemsByType, UserCosmetics} from '@app/api/cosmetics/CosmeticTables';
import {
	BatchBuilder,
	deleteOneOrMany,
	executeConditional,
	fetchMany,
	fetchManyInChunks,
	fetchOne,
	upsertOne,
} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import type {
	CosmeticGrantRow,
	CosmeticItemByTypeRow,
	CosmeticItemRow,
	UserCosmeticRow,
} from '@app/api/database/types/CosmeticTypes';

const FETCH_ITEM_CQL = CosmeticItems.select({where: CosmeticItems.where.eq('item_id'), limit: 1});
const FETCH_ALL_ITEMS_CQL = CosmeticItems.select();
const FETCH_ITEMS_CQL = CosmeticItems.selectCql({where: CosmeticItems.where.in('item_id', 'item_ids')});
const LIST_CATALOG_CQL = CosmeticItemsByType.select({where: CosmeticItemsByType.where.eq('item_type')});
const FETCH_CATALOG_ENTRY_CQL = CosmeticItemsByType.select({
	where: [CosmeticItemsByType.where.eq('item_type'), CosmeticItemsByType.where.eq('item_id')],
	limit: 1,
});
const LIST_OWNED_CQL = UserCosmetics.select({where: UserCosmetics.where.eq('user_id')});
const FETCH_OWNED_CQL = UserCosmetics.select({
	where: [UserCosmetics.where.eq('user_id'), UserCosmetics.where.eq('item_id')],
	limit: 1,
});
const LIST_GRANTS_CQL = CosmeticGrants.select({where: CosmeticGrants.where.eq('user_id')});
const FETCH_GRANT_CQL = CosmeticGrants.select({
	where: [CosmeticGrants.where.eq('user_id'), CosmeticGrants.where.eq('grant_key')],
	limit: 1,
});

function catalogEntry(item: CosmeticItemRow): CosmeticItemByTypeRow {
	const {version: _version, ...entry} = item;
	return entry;
}

export class CosmeticRepository {
	async getItem(itemId: bigint): Promise<CosmeticItemRow | null> {
		return fetchOne<CosmeticItemRow>(FETCH_ITEM_CQL.bind({item_id: itemId}));
	}

	async getItems(itemIds: Array<bigint>): Promise<Array<CosmeticItemRow>> {
		return fetchManyInChunks<CosmeticItemRow>(FETCH_ITEMS_CQL, itemIds, (chunk) => ({item_ids: chunk}));
	}

	// TEMPORARY: one partition per type holds the whole on-sale catalog; page it once a type passes ~2 000 items.
	async listCatalog(itemType: string): Promise<Array<CosmeticItemByTypeRow>> {
		return fetchMany<CosmeticItemByTypeRow>(LIST_CATALOG_CQL.bind({item_type: itemType}));
	}

	// TEMPORARY: reads the whole admin-curated item table in one query, off-sale items included (the Fluxer
	// pattern for small admin tables, as BillingProducts). Trigger: more than a few thousand items → page it with a
	// TOKEN(item_id) cursor and let the admin panel follow it.
	async listAllItems(): Promise<Array<CosmeticItemRow>> {
		return fetchMany<CosmeticItemRow>(FETCH_ALL_ITEMS_CQL.bind({}));
	}

	async isOnSale(item: CosmeticItemRow): Promise<boolean> {
		const entry = await fetchOne<CosmeticItemByTypeRow>(
			FETCH_CATALOG_ENTRY_CQL.bind({item_type: item.item_type, item_id: item.item_id}),
		);
		return entry !== null;
	}

	async putItem(item: CosmeticItemRow, onSale: boolean): Promise<void> {
		await new BatchBuilder()
			.addPrepared(CosmeticItems.upsertAll(item))
			.addPreparedIf(onSale, CosmeticItemsByType.upsertAll(catalogEntry(item)))
			.execute();
	}

	// Off sale, not deleted: accounts that wear it keep showing it and accounts that own it can still put it on.
	async takeOffSale(item: CosmeticItemRow): Promise<void> {
		await new BatchBuilder()
			.addPrepared(
				CosmeticItems.patchByPk(
					{item_id: item.item_id},
					{availability: Db.set('owned'), version: Db.set(item.version + 1)},
				),
			)
			.addPrepared(CosmeticItemsByType.deleteByPk({item_type: item.item_type, item_id: item.item_id}))
			.execute();
	}

	async listOwned(userId: UserID): Promise<Array<UserCosmeticRow>> {
		return fetchMany<UserCosmeticRow>(LIST_OWNED_CQL.bind({user_id: userId}));
	}

	async getOwned(userId: UserID, itemId: bigint): Promise<UserCosmeticRow | null> {
		return fetchOne<UserCosmeticRow>(FETCH_OWNED_CQL.bind({user_id: userId, item_id: itemId}));
	}

	async putOwned(row: UserCosmeticRow): Promise<void> {
		await upsertOne(UserCosmetics.upsertAll(row));
	}

	async deleteOwned(userId: UserID, itemId: bigint): Promise<void> {
		await deleteOneOrMany(UserCosmetics.deleteByPk({user_id: userId, item_id: itemId}));
	}

	async claimGrant(row: CosmeticGrantRow): Promise<boolean> {
		return executeConditional(CosmeticGrants.insertIfNotExists(row));
	}

	async getGrant(userId: UserID, grantKey: string): Promise<CosmeticGrantRow | null> {
		return fetchOne<CosmeticGrantRow>(FETCH_GRANT_CQL.bind({user_id: userId, grant_key: grantKey}));
	}

	async markGrantDelivered(userId: UserID, grantKey: string, at: Date): Promise<boolean> {
		return executeConditional(
			CosmeticGrants.conditionalPatchByPk(
				{user_id: userId, grant_key: grantKey},
				{state: Db.set('delivered'), delivered_at: Db.set(at)},
				{state: 'pending'},
			),
		);
	}

	// One user partition, bounded by the purchases and redeemed codes of that account.
	async listGrants(userId: UserID): Promise<Array<CosmeticGrantRow>> {
		return fetchMany<CosmeticGrantRow>(LIST_GRANTS_CQL.bind({user_id: userId}));
	}

	async revokePendingGrant(userId: UserID, grantKey: string): Promise<boolean> {
		return executeConditional(
			CosmeticGrants.conditionalPatchByPk(
				{user_id: userId, grant_key: grantKey},
				{state: Db.set('revoked')},
				{state: 'pending'},
			),
		);
	}

	async deleteAllOwned(userId: UserID): Promise<void> {
		await deleteOneOrMany(UserCosmetics.deletePartition({user_id: userId}));
	}
}

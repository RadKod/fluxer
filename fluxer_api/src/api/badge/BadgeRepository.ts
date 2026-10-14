// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {BadgeCatalog, Badges, UserBadges} from '@app/api/badge/BadgeTables';
import {BatchBuilder, deleteOneOrMany, fetchMany, fetchOne, upsertOne} from '@app/api/database/CassandraQueryExecution';
import type {BadgeCatalogRow, BadgeRow, UserBadgeRow} from '@app/api/database/types/BadgeTypes';
import {getProfileAccessCache} from '@app/api/middleware/ServiceSingletons';

// TEMPORARY: every badge sits in catalog partition 0 and List badges returns it unpaged (see BadgeTables).
// Trigger: more than 10 000 badges. Then spread new badges over more catalog numbers and page the admin list.
const CATALOG = 0;

const LIST_CATALOG_CQL = BadgeCatalog.select({where: BadgeCatalog.where.eq('catalog')});
const FETCH_BADGE_CQL = Badges.select({where: Badges.where.eq('badge_id'), limit: 1});
const LIST_USER_BADGES_CQL = UserBadges.select({where: UserBadges.where.eq('user_id')});

export class BadgeRepository {
	async listCatalog(): Promise<Array<BadgeCatalogRow>> {
		return fetchMany<BadgeCatalogRow>(LIST_CATALOG_CQL.bind({catalog: CATALOG}));
	}

	async getBadge(badgeId: bigint): Promise<BadgeRow | null> {
		return fetchOne<BadgeRow>(FETCH_BADGE_CQL.bind({badge_id: badgeId}));
	}

	// The badge row and its catalog copy change together in one logged batch.
	async upsertBadge(row: BadgeRow): Promise<void> {
		const {version: _version, ...catalogRow} = row;
		await new BatchBuilder()
			.addPrepared(Badges.upsertAll(row))
			.addPrepared(BadgeCatalog.upsertAll({...catalogRow, catalog: CATALOG}))
			.execute();
	}

	async listUserBadges(userId: UserID): Promise<Array<UserBadgeRow>> {
		return fetchMany<UserBadgeRow>(LIST_USER_BADGES_CQL.bind({user_id: userId}));
	}

	// A grant or a take-back (BadgeService, the Öncü PioneerService) reaches the cached profile view at once.
	async grantUserBadge(row: Omit<UserBadgeRow, 'sequence'> & {sequence?: number | null}): Promise<void> {
		await upsertOne(UserBadges.upsertAll({...row, sequence: row.sequence ?? null}));
		await getProfileAccessCache().forgetView(row.user_id);
	}

	async revokeUserBadge(userId: UserID, badgeId: bigint): Promise<void> {
		await deleteOneOrMany(UserBadges.deleteByPk({user_id: userId, badge_id: badgeId}));
		await getProfileAccessCache().forgetView(userId);
	}

	async deleteUserBadges(userId: UserID): Promise<void> {
		await deleteOneOrMany(UserBadges.deletePartition({user_id: userId}));
	}
}

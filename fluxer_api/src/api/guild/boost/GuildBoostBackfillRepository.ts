// SPDX-License-Identifier: AGPL-3.0-or-later

import {fetchPage} from '@app/api/database/CassandraQueryExecution';
import type {GuildBoostStateRow} from '@app/api/database/types/GuildBoostTypes';
import {GuildBoostState} from '@app/api/guild/boost/GuildBoostTables';

const SCAN_GUILD_IDS_CQL = GuildBoostState.selectCql({columns: ['guild_id']});

export class GuildBoostBackfillRepository {
	async scanStateGuildIdsPage(pageState: string | null) {
		return fetchPage<Pick<GuildBoostStateRow, 'guild_id'>>(SCAN_GUILD_IDS_CQL, {}, {pageSize: 100, pageState});
	}
}

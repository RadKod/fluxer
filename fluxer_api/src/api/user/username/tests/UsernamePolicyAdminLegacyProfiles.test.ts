// SPDX-License-Identifier: AGPL-3.0-or-later

import {AdminBanManagementService} from '@app/api/admin/services/AdminBanManagementService';
import {createUserID} from '@app/api/BrandedTypes';
import {
	resetCassandraQueryExecutorForTesting,
	setCassandraQueryExecutorForTesting,
	upsertOne,
} from '@app/api/database/CassandraQueryExecution';
import type {BannedProfileSubstringRow} from '@app/api/database/types/AdminArchiveTypes';
import {BannedProfileSubstrings} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const rows: Array<BannedProfileSubstringRow> = [
	{
		scope: 'username',
		substring: 'oldname',
		notes: 'legacy name',
		added_at: new Date('2026-01-01T00:00:00Z'),
		added_by: 1n,
	},
	{scope: 'bio', substring: 'oldbio', notes: 'legacy bio', added_at: null, added_by: null},
	{scope: 'uname_exact:g1', substring: 'dictionaryword', notes: null, added_at: null, added_by: null},
];

describe('legacy profile administration partition isolation', () => {
	let reads: Array<unknown>;
	beforeEach(async () => {
		reads = [];
		setCassandraQueryExecutorForTesting(
			new InMemoryCassandraQueryExecutor({
				beforeQuery: (query) => {
					if (query.kvMeta?.action === 'select' && query.kvMeta.table.name === 'banned_profile_substrings')
						reads.push(query.params.scope);
				},
			}),
		);
		for (const row of rows) await upsertOne(BannedProfileSubstrings.insert(row));
	});
	afterEach(() => {
		resetCassandraQueryExecutorForTesting();
	});
	function setup() {
		const broadLoader = vi.fn().mockResolvedValue(rows);
		const service = new AdminBanManagementService({
			apiContext: {},
			adminRepository: {loadAllBannedProfileSubstrings: broadLoader},
			auditService: {},
		} as never);
		return {service, broadLoader};
	}
	it('unscoped legacy listing excludes all dictionary generations and reads only five legacy partitions', async () => {
		const {service, broadLoader} = setup();
		const result = await service.listBlocklistEntries({
			listType: 'profile-substring',
			scope: null,
			limit: 100,
			after: null,
		});
		expect(result.items.map((row) => row.value).sort()).toEqual(['oldbio', 'oldname']);
		expect(reads.sort()).toEqual(['bio', 'global_name', 'nickname', 'pronouns', 'username']);
		expect(broadLoader).not.toHaveBeenCalled();
		expect(result.items.find((row) => row.value === 'oldname')).toMatchObject({
			list_type: 'profile-substring',
			scope: 'username',
			notes: 'legacy name',
			created_at: '2026-01-01T00:00:00.000Z',
			created_by_user_id: '1',
		});
	});
	it('scoped legacy listing reads only the requested partition', async () => {
		const {service, broadLoader} = setup();
		const result = await service.listBlocklistEntries({
			listType: 'profile-substring',
			scope: 'bio',
			limit: 100,
			after: null,
		});
		expect(result.items.map((row) => row.value)).toEqual(['oldbio']);
		expect(reads).toEqual(['bio']);
		expect(broadLoader).not.toHaveBeenCalled();
	});
	it('dictionary publication never broadcasts on the legacy profile refresh channel', async () => {
		const publish = vi.fn().mockResolvedValue(undefined);
		const audit = vi.fn().mockResolvedValue(undefined);
		const result = {
			dictionary_gen: 1,
			count: 1,
			hash: 'a'.repeat(64),
			counts: {uname_exact: 1, uname_contains: 0, uname_allow: 0},
			entries: {uname_exact: ['admin'], uname_contains: [], uname_allow: []},
		};
		const service = new AdminBanManagementService({
			apiContext: {services: {cache: {publish}}},
			adminRepository: {},
			auditService: {createAuditLog: audit},
			usernameDictionaryPublisher: {change: vi.fn().mockResolvedValue(result)},
		} as never);
		await expect(
			service.publishUsernameDictionary(
				{scope: 'uname_exact', add: ['admin'], remove: []},
				createUserID(1n),
				'publish',
			),
		).resolves.toEqual(result);
		expect(publish).not.toHaveBeenCalled();
		expect(audit).toHaveBeenCalledOnce();
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {CassandraUsernameDictionaryStorage} from '@app/api/admin/services/AdminBanManagementService';
import {
	resetCassandraQueryExecutorForTesting,
	setCassandraQueryExecutorForTesting,
} from '@app/api/database/CassandraQueryExecution';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import type {UsernameDictionaryEntries} from '@app/api/user/username/UsernamePolicyService';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const now = new Date('2026-10-09T12:00:00Z');
const old = '2026-10-07T12:00:00Z';
const entries: UsernameDictionaryEntries = {uname_exact: ['admin'], uname_contains: ['fuck'], uname_allow: ['shilton']};

class Config {
	policy = {revision: 4, dictionary_gen: 5, previous_dictionary_gen: 3, next_dictionary_gen: 7};
	metadata = new Map([
		[1, {created_at: old}],
		[2, {created_at: old}],
		[3, {created_at: old}],
		[4, {created_at: '2026-10-08T12:00:00Z'}],
		[5, {created_at: old}],
		[6, {created_at: '2026-10-09T11:00:00Z'}],
	]);
	state: {day: string; cursor: number} | null = null;
	beforeFence: (() => void) | null = null;
	async readUsernamePolicyConfig() {
		return {...this.policy};
	}
	async readUsernameDictionaryGenerationMetadata(generation: number) {
		return this.metadata.get(generation) ?? null;
	}
	async readUsernameDictionaryCleanupState() {
		return this.state && {...this.state};
	}
	async compareAndSetUsernameDictionaryCleanupState(expected: typeof this.state, next: NonNullable<typeof this.state>) {
		if (JSON.stringify(expected) !== JSON.stringify(this.state)) return false;
		this.state = {...next};
		return true;
	}
	async fenceUsernameDictionaryGenerationCleanup(expected: typeof this.policy) {
		this.beforeFence?.();
		this.beforeFence = null;
		if (JSON.stringify(expected) !== JSON.stringify(this.policy)) return false;
		this.policy.revision++;
		return true;
	}
}

describe('username dictionary generation cleanup', () => {
	let deletes: Array<string>;
	let failScope: string | null;
	beforeEach(() => {
		deletes = [];
		failScope = null;
		setCassandraQueryExecutorForTesting(
			new InMemoryCassandraQueryExecutor({
				beforeQuery: (query) => {
					if (query.kvMeta?.action !== 'delete' || query.kvMeta.table.name !== 'banned_profile_substrings') return;
					const scope = String(query.params.scope);
					deletes.push(scope);
					if (scope === failScope) throw new Error('delete interrupted');
				},
			}),
		);
	});
	afterEach(() => resetCassandraQueryExecutorForTesting());
	it('deletes old staging and successful generations while preserving actual current and previous pointers', async () => {
		const config = new Config();
		const storage = new CassandraUsernameDictionaryStorage(config as never);
		for (let generation = 1; generation < 7; generation++) await storage.write(generation, entries);
		expect(await storage.cleanupUsernameDictionaryGenerations(now)).toBe(2);
		expect(deletes.sort()).toEqual([
			'uname_allow:g1',
			'uname_allow:g2',
			'uname_contains:g1',
			'uname_contains:g2',
			'uname_exact:g1',
			'uname_exact:g2',
		]);
		for (const generation of [3, 4, 5, 6]) expect(await storage.read(generation)).toEqual(entries);
		expect(await storage.read(1)).toEqual({uname_exact: [], uname_contains: [], uname_allow: []});
		expect(config.metadata.size).toBe(6);
	});
	it('re-cleans late restored staging rows on the next UTC day', async () => {
		const config = new Config();
		const storage = new CassandraUsernameDictionaryStorage(config as never);
		await storage.cleanupUsernameDictionaryGenerations(now);
		await storage.write(1, entries);
		expect(await storage.cleanupUsernameDictionaryGenerations(now)).toBe(0);
		expect(await storage.read(1)).toEqual(entries);
		await storage.cleanupUsernameDictionaryGenerations(new Date('2026-10-10T12:00:00Z'));
		expect(await storage.read(1)).toEqual({uname_exact: [], uname_contains: [], uname_allow: []});
	});
	it('does not delete if publication changes the pointer before the cleanup fence', async () => {
		const config = new Config();
		config.beforeFence = () => {
			config.policy = {...config.policy, revision: 5, dictionary_gen: 2, previous_dictionary_gen: 5};
		};
		const storage = new CassandraUsernameDictionaryStorage(config as never);
		await storage.write(2, entries);
		expect(await storage.cleanupUsernameDictionaryGenerations(now)).toBe(0);
		expect(deletes).toEqual([]);
		expect(await storage.read(2)).toEqual(entries);
	});
	it('fences delayed publication and resumes a partially failed partition deletion', async () => {
		const config = new Config();
		const reservedRevision = config.policy.revision;
		const storage = new CassandraUsernameDictionaryStorage(config as never);
		await storage.write(1, entries);
		failScope = 'uname_contains:g1';
		await expect(storage.cleanupUsernameDictionaryGenerations(now)).rejects.toThrow('delete interrupted');
		expect(config.policy.revision).toBeGreaterThan(reservedRevision);
		expect(config.state?.cursor).toBe(1);
		failScope = null;
		expect(await storage.cleanupUsernameDictionaryGenerations(now)).toBe(2);
		expect(await storage.read(1)).toEqual({uname_exact: [], uname_contains: [], uname_allow: []});
	});
	it('retains a generation whose reservation timestamp is unavailable', async () => {
		const config = new Config();
		config.metadata.delete(1);
		const storage = new CassandraUsernameDictionaryStorage(config as never);
		await storage.write(1, entries);
		expect(await storage.cleanupUsernameDictionaryGenerations(now)).toBe(1);
		expect(await storage.read(1)).toEqual(entries);
	});
});

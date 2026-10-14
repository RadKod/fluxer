// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	UsernameDictionaryPublisher,
	type UsernameDictionaryStorage,
} from '@app/api/admin/services/AdminBanManagementService';
import {
	computeUsernameDictionaryManifest,
	type UsernameDictionaryEntries,
} from '@app/api/user/username/UsernamePolicyService';
import {describe, expect, it} from 'vitest';

const empty = (): UsernameDictionaryEntries => ({uname_exact: [], uname_contains: [], uname_allow: []});

class Storage implements UsernameDictionaryStorage {
	rows = new Map<number, UsernameDictionaryEntries>([[1, {...empty(), uname_exact: ['admin']}]]);
	policy = {
		dictionary_gen: 1,
		revision: 1,
		dictionary_hash: computeUsernameDictionaryManifest({...empty(), uname_exact: ['admin']}).hash,
	};
	next = 2;
	deleted: Array<number> = [];
	beforePublish: (() => Promise<void>) | null = null;
	failWrite = false;
	loseAppliedResponse = false;
	unknownPublication = false;
	async readPolicy() {
		return {...this.policy};
	}
	async reserve() {
		return {
			generation: this.next++,
			createdAt: new Date().toISOString(),
			baseGeneration: this.policy.dictionary_gen,
			baseRevision: this.policy.revision,
			baseHash: this.policy.dictionary_hash,
		};
	}
	async read(generation: number) {
		return this.rows.get(generation) ?? empty();
	}
	async write(generation: number, entries: UsernameDictionaryEntries) {
		this.rows.set(generation, {...entries, uname_exact: [...entries.uname_exact]});
		if (this.failWrite) throw new Error('write interrupted');
	}
	async publish(reservation: {generation: number; baseGeneration: number; baseRevision: number}, hash: string) {
		if (this.unknownPublication) throw new Error('unknown publication');
		const callback = this.beforePublish;
		this.beforePublish = null;
		await callback?.();
		if (this.policy.dictionary_gen !== reservation.baseGeneration || this.policy.revision !== reservation.baseRevision)
			return false;
		this.policy = {dictionary_gen: reservation.generation, revision: this.policy.revision + 1, dictionary_hash: hash};
		if (this.loseAppliedResponse) throw new Error('response lost');
		return true;
	}
	async delete(generation: number) {
		this.deleted.push(generation);
		this.rows.delete(generation);
	}
}

describe('username dictionary publication', () => {
	it('retries a losing publisher from the winner and deletes only its own generation', async () => {
		const storage = new Storage();
		const publisher = new UsernameDictionaryPublisher(storage);
		storage.beforePublish = async () => {
			await publisher.change({scope: 'uname_contains', add: ['fuck'], remove: []});
		};
		const result = await publisher.change({scope: 'uname_exact', add: ['support'], remove: []});
		expect(result.entries).toEqual({uname_exact: ['admin', 'support'], uname_contains: ['fuck'], uname_allow: []});
		expect(storage.deleted).toEqual([2]);
		expect(storage.rows.get(1)).toEqual({...empty(), uname_exact: ['admin']});
		expect(storage.policy.dictionary_hash).toBe(computeUsernameDictionaryManifest(result.entries).hash);
	});
	it('never publishes a partially written generation', async () => {
		const storage = new Storage();
		storage.failWrite = true;
		await expect(
			new UsernameDictionaryPublisher(storage).change({scope: 'uname_exact', add: ['staff'], remove: []}),
		).rejects.toThrow('write interrupted');
		expect(storage.policy.dictionary_gen).toBe(1);
		expect(storage.deleted).toEqual([2]);
	});
	it('resolves a lost applied CAS response without deleting the published generation', async () => {
		const storage = new Storage();
		storage.loseAppliedResponse = true;
		const result = await new UsernameDictionaryPublisher(storage).change({
			scope: 'uname_exact',
			add: ['staff'],
			remove: [],
		});
		expect(storage.rows.get(result.dictionary_gen)?.uname_exact).toEqual(['admin', 'staff']);
		expect(storage.deleted).toEqual([]);
	});
	it('preserves its staged generation when publication outcome remains unknown', async () => {
		const storage = new Storage();
		storage.unknownPublication = true;
		await expect(
			new UsernameDictionaryPublisher(storage).change({scope: 'uname_exact', add: ['staff'], remove: []}),
		).rejects.toThrow('unknown publication');
		expect(storage.rows.get(2)?.uname_exact).toEqual(['admin', 'staff']);
		expect(storage.deleted).toEqual([]);
	});
	it('loads the published generation after restart without notifications', async () => {
		const storage = new Storage();
		await new UsernameDictionaryPublisher(storage).change({scope: 'uname_allow', add: ['shilton'], remove: []});
		const result = await new UsernameDictionaryPublisher(storage).current();
		expect(result.entries.uname_allow).toEqual(['shilton']);
		expect(result.hash).toBe(storage.policy.dictionary_hash);
	});
	it('rejects source corruption rather than publishing it as a new generation', async () => {
		const storage = new Storage();
		storage.rows.set(1, {...empty(), uname_exact: ['tampered']});
		await expect(
			new UsernameDictionaryPublisher(storage).change({scope: 'uname_allow', add: ['shilton'], remove: []}),
		).rejects.toThrow('hash mismatch');
		expect(storage.policy.dictionary_gen).toBe(1);
		expect(storage.deleted).toEqual([2]);
	});
	it('rejects over 20000 entries before writing or publishing', async () => {
		const storage = new Storage();
		await expect(
			new UsernameDictionaryPublisher(storage).change({
				scope: 'uname_exact',
				add: Array.from({length: 20000}, (_, i) => `word${i}`),
				remove: [],
			}),
		).rejects.toThrow();
		expect(storage.rows.size).toBe(1);
		expect(storage.policy.dictionary_gen).toBe(1);
	});
});

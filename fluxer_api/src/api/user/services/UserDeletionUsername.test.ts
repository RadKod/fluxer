// SPDX-License-Identifier: AGPL-3.0-or-later
import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {fetchMany, upsertOne} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {getSnowflakeService, setInjectedUsernameOwnershipService} from '@app/api/middleware/ServiceRegistry';
import {UserByEmail, UserByUsername, Users} from '@app/api/Tables';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {UserIndexRepository} from '@app/api/user/repositories/account/crud/UserIndexRepository';
import {deleteAccount, setPendingDeletionAt} from '@app/api/user/tests/UserTestUtils';
import type {UsernameOwnershipService} from '@app/api/user/username/UsernameOwnershipService';
import {initializeWorkerDependencies} from '@app/api/worker/WorkerDependencies';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {processUserDeletion} from './UserDeletionService';

let harness: ApiTestHarness;
beforeEach(async () => {
	harness = await createApiTestHarness();
});
afterEach(async () => {
	vi.restoreAllMocks();
	setInjectedUsernameOwnershipService(undefined);
	await harness.shutdown();
});
test.each(['preparing', 'selecting'] as const)(
	'deletion %s ownership precedes anonymization and retries both crash windows',
	async (state) => {
		const account = await createTestAccount(harness);
		const id = createUserID(BigInt(account.userId));
		await deleteAccount(harness, account.token, account.password);
		const schedule = new Date(Date.now() - 60000);
		await setPendingDeletionAt(harness, account.userId, schedule);
		const deps = await initializeWorkerDependencies(getSnowflakeService());
		const original = await deps.userRepository.findUniqueAssert(id);
		const events: Array<string> = [];
		let phase = 'before';
		vi.spyOn(InstanceConfigRepository.prototype, 'readUsernameMigrationConfig').mockResolvedValue({
			state,
			epoch: 1,
			started_at: null,
			forced_at: null,
		});
		setInjectedUsernameOwnershipService({
			deleteAccount: vi.fn(async (userId, identity) => {
				events.push('owner');
				if (phase === 'before') throw new Error('crash-before');
				await upsertOne(
					Users.patchByPk(
						{user_id: userId},
						{username: Db.set(identity.username), discriminator: Db.set(identity.discriminator)},
					),
				);
				await upsertOne(
					UserByUsername.deleteByPk({
						username: original.username.toLowerCase(),
						discriminator: original.discriminator,
						user_id: id,
					}),
				);
			}),
		} as unknown as UsernameOwnershipService);
		const anonymize = vi.spyOn(deps.userRepository, 'anonymizeForDeletion');
		const remove = vi.spyOn(UserIndexRepository.prototype, 'deleteIndices').mockImplementationOnce(async (...args) => {
			// The dedicated deleted-user placeholder is cleaned first.
			const method = remove.getMockImplementation();
			void method;
			void args;
		});
		await expect(processUserDeletion(id, schedule, 0, deps)).rejects.toThrow('crash-before');
		expect(anonymize).not.toHaveBeenCalled();
		phase = 'after';
		remove.mockRestore();
		const indexOriginal = UserIndexRepository.prototype.deleteIndices;
		const indexSpy = vi.spyOn(UserIndexRepository.prototype, 'deleteIndices').mockImplementation(async (...args) => {
			if (args[0] === id) {
				events.push('indices');
				expect(anonymize).toHaveBeenCalled();
				if (phase === 'after') throw new Error('crash-after');
			}
			return indexOriginal.apply(new UserIndexRepository(), args);
		});
		await expect(processUserDeletion(id, schedule, 0, deps)).rejects.toThrow('crash-after');
		const staged = await deps.userRepository.findUniqueAssert(id);
		expect(staged.email).toBe(original.email);
		expect(staged.deletionStartedAt).not.toBeNull();
		expect((await createBuilder(harness, account.token).get('/users/@me').executeRaw()).response.status).toBe(401);
		phase = 'finish';
		await processUserDeletion(id, schedule, 0, deps);
		const deleted = await deps.userRepository.findUniqueAssert(id);
		expect(deleted.email).toBeNull();
		expect(deleted.pendingDeletionAt).toBeNull();
		expect((await fetchMany(UserByEmail.select().bind({}))).filter((r: any) => r.user_id === id)).toHaveLength(0);
		expect(indexSpy).toHaveBeenCalled();
		expect(events.indexOf('owner')).toBeLessThan(events.indexOf('indices'));
	},
);

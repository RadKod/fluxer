// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import type {UserRow} from '@app/api/database/types/UserTypes';
import {setCachedAccountIdentity} from '@app/api/instance/AccountIdentityModeCache';
import * as registry from '@app/api/middleware/ServiceRegistry';
import {User} from '@app/api/models/User';
import {setInjectedSearchProvider} from '@app/api/SearchFactory';
import type {ISearchProvider} from '@app/api/search/ISearchProvider';
import {UsernameOwnershipService} from '@app/api/user/username/UsernameOwnershipService';
import reindexUserGuildMembers, {enqueueUsernameReindex} from '@app/api/worker/tasks/ReindexUserGuildMembers';
import {
	createUsernameOwnershipRuntime,
	propagateUsernameOwnership,
} from '@app/api/worker/tasks/UsernameRuntimeAdapters';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {AccountIdentityModes, TagStyles} from '@fluxer/constants/src/AccountIdentityConstants';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterEach, describe, expect, it, vi} from 'vitest';

const userId = createUserID(700n);
const makeUser = (state: UserRow['username_state'] = null) =>
	new User({user_id: userId, username: 'current', discriminator: 0, username_state: state, flags: 0n} as UserRow);
const helpers = {jobId: 1n} as WorkerTaskHelpers;
afterEach(() => {
	vi.restoreAllMocks();
	clearWorkerDependencies();
	setInjectedSearchProvider(undefined);
	registry.resetServiceRegistryForTesting();
	registry.setInjectedWorkerService(undefined);
	registry.setInjectedKVProvider(undefined);
	setCachedAccountIdentity(null);
});

describe('username runtime adapters', () => {
	it('constructs a real ownership service only when runtime dependencies exist', () => {
		expect(() => createUsernameOwnershipRuntime({} as never)).toThrow('unavailable');
		const service = createUsernameOwnershipRuntime({
			kv: {evalScript: async () => [0, 100, 500]},
			worker: {addJob: vi.fn()} as unknown as IWorkerService,
		});
		expect(service).toBeInstanceOf(UsernameOwnershipService);
		registry.setInjectedKVProvider({evalScript: async () => [0, 100, 500]} as never);
		registry.setInjectedWorkerService({addJob: vi.fn()} as never);
		expect(registry.getUsernameOwnershipService()).toBeInstanceOf(UsernameOwnershipService);
		expect(registry.getUsernameOwnershipService()).toBe(registry.getUsernameOwnershipService());
	});
	it('rereads projection and awaits private USER_UPDATE, guild propagation and durable reindex', async () => {
		const user = new User({...makeUser('selected').toRow(), identity_version: 4n});
		const dispatchUserUpdate = vi.fn();
		const propagatePartialUserChange = vi.fn();
		const enqueue = vi.fn();
		await propagateUsernameOwnership(
			{readUser: async () => user, dispatchUserUpdate, propagatePartialUserChange, enqueue},
			userId,
		);
		expect(dispatchUserUpdate).toHaveBeenCalledWith(user);
		expect(propagatePartialUserChange).toHaveBeenCalledWith(user);
		expect(enqueue).toHaveBeenCalledWith(userId, 4n);
		enqueue.mockRejectedValue(new Error('queue unavailable'));
		await expect(
			propagateUsernameOwnership(
				{
					readUser: async () => user,
					dispatchUserUpdate,
					propagatePartialUserChange,
					enqueue,
				},
				userId,
			),
		).rejects.toThrow('queue unavailable');
	});
	it('uses the dispatched projection generation when another rename occurs during propagation', async () => {
		const user = new User({...makeUser('selected').toRow(), identity_version: 3n});
		let ownerGeneration = 3n;
		const enqueue = vi.fn();
		await propagateUsernameOwnership(
			{
				readUser: async () => user,
				dispatchUserUpdate: async () => {
					ownerGeneration = 4n;
				},
				propagatePartialUserChange: async () => {},
				enqueue,
			},
			userId,
		);
		expect(ownerGeneration).toBe(4n);
		expect(enqueue).toHaveBeenCalledWith(userId, 3n);
	});
	it('registry gate enforces cached forced migration and current projection', () => {
		const wasSelfHosted = Config.instance.selfHosted;
		Config.instance.selfHosted = true;
		try {
			setCachedAccountIdentity({
				mode: AccountIdentityModes.EMAIL,
				tagStyle: TagStyles.NONE,
				usernameMigration: {
					state: 'selecting',
					epoch: 2,
					preparing_at: new Date(0).toISOString(),
					started_at: new Date(0).toISOString(),
					forced_at: new Date(1).toISOString(),
				},
			});
			expect(() => registry.getUsernameSelectionGate().assertMayAct(makeUser(), 'message')).toThrow();
			expect(() => registry.getUsernameSelectionGate().assertMayAct(makeUser('selected'), 'message')).not.toThrow();
		} finally {
			Config.instance.selfHosted = wasSelfHosted;
		}
	});
});

describe('username guild reindex task', () => {
	it('queues durable retries with a per-user generation job key and timestamp', async () => {
		const addJob = vi.fn().mockResolvedValue(1n);
		await enqueueUsernameReindex({addJob} as unknown as IWorkerService, userId, 7n, () => 1000);
		expect(addJob).toHaveBeenCalledWith(
			'reindexUserGuildMembers',
			{user_id: '700', enqueued_at_ms: 1000},
			{jobKey: 'username-reindex:700:7', requireLedger: true, maxAttempts: 25},
		);
	});
	it('rereads the latest identity and propagates search failures to durable retry', async () => {
		const user = makeUser('selected');
		const updateMember = vi.fn().mockRejectedValue(new Error('search unavailable'));
		setInjectedSearchProvider({getGuildMemberSearchService: () => ({updateMember})} as unknown as ISearchProvider);
		setWorkerDependenciesForTest({
			userRepository: {findUnique: async () => user, getUserGuildIds: async () => [8n]} as never,
			guildRepository: {
				listGuilds: async () => [{id: 8n, membersIndexedAt: new Date()}],
				getMember: async () => ({userId}),
			} as never,
		});
		await expect(reindexUserGuildMembers({user_id: '700', enqueued_at_ms: 1000}, helpers)).rejects.toThrow(
			'search unavailable',
		);
		expect(updateMember.mock.calls[0]?.[1]).toBe(user);
		updateMember.mockResolvedValue(undefined);
		await reindexUserGuildMembers({user_id: '700', enqueued_at_ms: 1000}, helpers);
	});
});

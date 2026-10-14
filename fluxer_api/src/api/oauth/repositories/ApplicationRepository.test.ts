// SPDX-License-Identifier: AGPL-3.0-or-later

import {createApplicationID, createUserID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import type {ApplicationRow} from '@app/api/database/types/OAuth2Types';
import {INSTANCE_CONFIG_REFRESH_CHANNEL} from '@app/api/instance/InstanceConfigRepository';
import {ApplicationRepository} from '@app/api/oauth/repositories/ApplicationRepository';
import {Applications, InstanceConfiguration} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

describe('application eligibility mutation notifications', () => {
	let executor: InMemoryCassandraQueryExecutor;
	let provider: MockKVProvider;
	let repository: ApplicationRepository;
	const row: ApplicationRow = {
		application_id: createApplicationID(123n),
		owner_user_id: createUserID(1n),
		name: 'Test',
		bot_user_id: createUserID(123n),
		bot_is_public: true,
		bot_require_code_grant: false,
		oauth2_redirect_uris: new Set(),
		client_secret_hash: null,
		bot_token_hash: null,
		bot_token_preview: null,
		bot_token_created_at: null,
		client_secret_created_at: null,
		version: 1,
	};
	beforeEach(async () => {
		vi.useFakeTimers();
		executor = new InMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		provider = new MockKVProvider();
		repository = new ApplicationRepository(provider);
		await executor.executeQuery(Applications.upsertAll(row));
		await executor.executeQuery(
			InstanceConfiguration.upsertAll({
				key: 'instance_policy_config',
				value: JSON.stringify({official_apps: [{application_id: '123', invite_permissions: '0'}]}),
				updated_at: new Date(),
			}),
		);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});
	it('waits for all previously issued public eligibility leases before persisting a private bot', async () => {
		vi.useFakeTimers();
		const write = repository.upsertApplication({...row, bot_is_public: false}, row);
		await vi.advanceTimersByTimeAsync(35000);
		expect((await repository.getApplication(row.application_id))?.botIsPublic).toBe(true);
		await vi.advanceTimersByTimeAsync(100);
		await write;
		expect((await repository.getApplication(row.application_id))?.botIsPublic).toBe(false);
	});
	it.each(['private', 'delete'])(
		'does not delay a restrictive mutation for an unlisted public bot: %s',
		async (operation) => {
			await executor.executeQuery(
				InstanceConfiguration.upsertAll({key: 'instance_policy_config', value: '{}', updated_at: new Date()}),
			);
			let finished = false;
			const write =
				operation === 'private'
					? repository.upsertApplication({...row, bot_is_public: false}, row)
					: repository.deleteApplication(row.application_id);
			void write.then(() => {
				finished = true;
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(finished).toBe(true);
			await write;
		},
	);
	it('waits for a remote public lease after the application was removed from the canonical policy', async () => {
		await executor.executeQuery(
			InstanceConfiguration.upsertAll({key: 'instance_policy_config', value: '{}', updated_at: new Date()}),
		);
		await provider.setex('official-app-eligibility-lease:123', 35, '1');
		const write = repository.upsertApplication({...row, bot_is_public: false}, row);
		await vi.advanceTimersByTimeAsync(35000);
		expect((await repository.getApplication(row.application_id))?.botIsPublic).toBe(true);
		await vi.advanceTimersByTimeAsync(100);
		await write;
		expect((await repository.getApplication(row.application_id))?.botIsPublic).toBe(false);
	});
	it('publishes invalidation before writing and refreshes even if the owner index batch fails', async () => {
		const failure = new Error('owner index failed');
		vi.spyOn(executor, 'executeBatch').mockRejectedValueOnce(failure);
		const rejection = expect(repository.upsertApplication({...row, bot_is_public: false}, row)).rejects.toThrow(
			failure,
		);
		await vi.advanceTimersByTimeAsync(35100);
		await rejection;
		expect((await repository.getApplication(row.application_id))?.botIsPublic).toBe(false);
		const messages = provider.publishSpy.mock.calls
			.filter(([channel]) => channel === INSTANCE_CONFIG_REFRESH_CHANNEL)
			.map(([, body]) => JSON.parse(body));
		expect(messages.map((message) => message.type)).toEqual(['application_invalidate', 'application_refresh']);
		expect(messages[0].mutation_id).toBe(messages[1].mutation_id);
	});
	it('leaves the application unchanged if pre-invalidation publish fails', async () => {
		vi.spyOn(provider, 'publish').mockRejectedValueOnce(new Error('pubsub unavailable'));
		await expect(repository.upsertApplication({...row, bot_is_public: false}, row)).rejects.toThrow(
			'pubsub unavailable',
		);
		expect((await repository.getApplication(row.application_id))?.botIsPublic).toBe(true);
	});
	it('keeps the write error when final refresh publishing also fails', async () => {
		vi.spyOn(executor, 'executeBatch').mockRejectedValueOnce(new Error('owner index failed'));
		vi.spyOn(provider, 'publish').mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('pubsub unavailable'));
		const rejection = expect(repository.upsertApplication({...row, bot_is_public: false}, row)).rejects.toMatchObject({
			errors: [
				expect.objectContaining({message: 'owner index failed'}),
				expect.objectContaining({message: 'pubsub unavailable'}),
			],
		});
		await vi.advanceTimersByTimeAsync(35100);
		await rejection;
	});
	it('publishes around deletion', async () => {
		const deletion = repository.deleteApplication(row.application_id);
		await vi.advanceTimersByTimeAsync(35100);
		await deletion;
		expect(await repository.getApplication(row.application_id)).toBeNull();
		expect(
			provider.publishSpy.mock.calls
				.filter(([channel]) => channel === INSTANCE_CONFIG_REFRESH_CHANNEL)
				.map(([, body]) => JSON.parse(body).type),
		).toEqual(['application_invalidate', 'application_refresh']);
	});
	it('refuses a delayed write after its lease expires and preserves the newer holder marker', async () => {
		const publish = provider.publish.bind(provider);
		let finishPublish!: () => void;
		vi.spyOn(provider, 'publish').mockImplementationOnce(async (channel, message) => {
			await publish(channel, message);
			await new Promise<void>((resolve) => {
				finishPublish = resolve;
			});
			return 1;
		});
		const rejection = expect(repository.upsertApplication({...row, bot_is_public: false}, row)).rejects.toMatchObject({
			status: 409,
		});
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(300001);
		await provider.acquireLock('official-app-mutation:123', 'new-holder', 300);
		finishPublish();
		await vi.advanceTimersByTimeAsync(35100);
		await rejection;
		expect((await repository.getApplication(row.application_id))?.botIsPublic).toBe(true);
		expect(await provider.get('official-app-mutation:123')).toBe('new-holder');
	});
});

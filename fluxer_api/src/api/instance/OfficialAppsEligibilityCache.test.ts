// SPDX-License-Identifier: AGPL-3.0-or-later

import {createApplicationID, createUserID} from '@app/api/BrandedTypes';
import {INSTANCE_CONFIG_REFRESH_CHANNEL} from '@app/api/instance/InstanceConfigRepository';
import {OfficialAppsEligibilityCache} from '@app/api/instance/OfficialAppsEligibilityCache';
import {Application} from '@app/api/models/Application';
import {ApplicationRepository, officialAppMutationKey} from '@app/api/oauth/repositories/ApplicationRepository';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterEach, describe, expect, it, vi} from 'vitest';

const application = new Application({
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
});

describe('official app eligibility refresh races', () => {
	const caches: Array<OfficialAppsEligibilityCache> = [];
	afterEach(async () => {
		await Promise.all(caches.map((cache) => cache.shutdown()));
		caches.length = 0;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});
	function cache(provider: MockKVProvider | null, candidates = async () => ['123']) {
		const result = new OfficialAppsEligibilityCache(provider, INSTANCE_CONFIG_REFRESH_CHANNEL, candidates);
		caches.push(result);
		return result;
	}
	it('ignores a stale public load invalidated while the database read is pending', async () => {
		const provider = new MockKVProvider();
		const read = vi.spyOn(ApplicationRepository.prototype, 'getApplication').mockResolvedValue(application);
		const current = cache(provider);
		expect(await current.getEligible()).toEqual(new Set(['123']));
		let finish!: (value: Application) => void;
		read.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		await provider.publish(INSTANCE_CONFIG_REFRESH_CHANNEL, '{}');
		await vi.waitFor(() => expect(finish).toBeDefined());
		await provider.acquireLock(officialAppMutationKey('123'), 'mutation', 300);
		await provider.publish(
			INSTANCE_CONFIG_REFRESH_CHANNEL,
			JSON.stringify({type: 'application_invalidate', application_id: '123', mutation_id: 'mutation'}),
		);
		finish(application);
		expect(await current.getEligible()).toEqual(new Set());
		await provider.releaseLock(officialAppMutationKey('123'), 'mutation');
		read.mockResolvedValue(new Application({...application.toRow(), bot_is_public: false}));
		await provider.publish(
			INSTANCE_CONFIG_REFRESH_CHANNEL,
			JSON.stringify({type: 'application_refresh', application_id: '123', mutation_id: 'mutation'}),
		);
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
		expect(await current.getEligible()).toEqual(new Set());
	});
	it('checks markers for newly selected policy candidates whose invalidation preceded the subscription', async () => {
		const provider = new MockKVProvider();
		const read = vi.spyOn(ApplicationRepository.prototype, 'getApplication').mockResolvedValue(application);
		await provider.acquireLock(officialAppMutationKey('123'), 'other-process', 300);
		expect(await cache(provider).getEligible()).toEqual(new Set());
		expect(read).not.toHaveBeenCalled();
	});
	it('removes old eligibility on refresh failures', async () => {
		const provider = new MockKVProvider();
		const read = vi.spyOn(ApplicationRepository.prototype, 'getApplication').mockResolvedValue(application);
		const current = cache(provider);
		expect(await current.getEligible()).toEqual(new Set(['123']));
		read.mockRejectedValue(new Error('database unavailable'));
		await provider.publish(INSTANCE_CONFIG_REFRESH_CHANNEL, '{}');
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
		expect(await current.getEligible()).toEqual(new Set());
	});
	it('never reads applications per request after a failed initial subscription', async () => {
		const provider = new MockKVProvider({subscriptionOptions: {shouldFailSubscribe: true}});
		const read = vi.spyOn(ApplicationRepository.prototype, 'getApplication');
		const current = cache(provider);
		expect(await current.getEligible()).toEqual(new Set());
		expect(await current.getEligible()).toEqual(new Set());
		expect(read).not.toHaveBeenCalled();
	});
	it('bounds rebuilds to 22 candidates and skips application queries for an empty list', async () => {
		const provider = new MockKVProvider();
		const read = vi.spyOn(ApplicationRepository.prototype, 'getApplication').mockResolvedValue(null);
		await cache(provider, async () => Array.from({length: 30}, (_, index) => String(index))).getEligible();
		expect(read).toHaveBeenCalledTimes(22);
		read.mockClear();
		await cache(provider, async () => []).getEligible();
		expect(read).not.toHaveBeenCalled();
	});
	it('recovers an abandoned marker after its lease expires on periodic refresh', async () => {
		vi.useFakeTimers();
		const provider = new MockKVProvider();
		vi.spyOn(ApplicationRepository.prototype, 'getApplication').mockResolvedValue(application);
		await provider.acquireLock(officialAppMutationKey('123'), 'crashed-process', 300);
		const current = cache(provider);
		expect(await current.getEligible()).toEqual(new Set());
		await vi.advanceTimersByTimeAsync(330000);
		expect(await current.getEligible()).toEqual(new Set(['123']));
	});
	it('recovers a transient subscription failure in the background without request retries', async () => {
		vi.useFakeTimers();
		const options = {shouldFailSubscribe: true};
		const provider = new MockKVProvider({subscriptionOptions: options});
		const read = vi.spyOn(ApplicationRepository.prototype, 'getApplication').mockResolvedValue(application);
		const current = cache(provider);
		expect(await current.getEligible()).toEqual(new Set());
		options.shouldFailSubscribe = false;
		expect(await current.getEligible()).toEqual(new Set());
		expect(read).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(30000);
		expect(await current.getEligible()).toEqual(new Set(['123']));
	});
	it('does not rebuild eligibility for unrelated application mutations', async () => {
		const provider = new MockKVProvider();
		const read = vi.spyOn(ApplicationRepository.prototype, 'getApplication').mockResolvedValue(application);
		const current = cache(provider);
		await current.getEligible();
		await provider.publish(
			INSTANCE_CONFIG_REFRESH_CHANNEL,
			JSON.stringify({type: 'application_invalidate', application_id: '456', mutation_id: 'other'}),
		);
		await new Promise((resolve) => setImmediate(resolve));
		expect(read).toHaveBeenCalledTimes(1);
		expect(await current.getEligible()).toEqual(new Set(['123']));
	});
	it('synchronously expires public identities when delivery of invalidation notifications is delayed', async () => {
		vi.spyOn(performance, 'now').mockReturnValue(0);
		vi.spyOn(ApplicationRepository.prototype, 'getApplication').mockResolvedValue(application);
		const current = cache(new MockKVProvider());
		expect(await current.getEligible()).toEqual(new Set(['123']));
		vi.mocked(performance.now).mockReturnValue(35000);
		expect(await current.getEligible()).toEqual(new Set());
	});
	it('measures the public lease from refresh start, including a delayed database read', async () => {
		let time = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => time);
		vi.spyOn(ApplicationRepository.prototype, 'getApplication').mockImplementation(async () => {
			time = 35000;
			return application;
		});
		expect(await cache(new MockKVProvider()).getEligible()).toEqual(new Set());
	});
	it('recovers socket errors in the background while requests remain closed', async () => {
		vi.useFakeTimers();
		const provider = new MockKVProvider();
		vi.spyOn(ApplicationRepository.prototype, 'getApplication').mockResolvedValue(application);
		const current = cache(provider);
		expect(await current.getEligible()).toEqual(new Set(['123']));
		(provider.duplicate() as unknown as {simulateError(error: Error): void}).simulateError(new Error('socket closed'));
		expect(await current.getEligible()).toEqual(new Set());
		await vi.advanceTimersByTimeAsync(30000);
		expect(await current.getEligible()).toEqual(new Set(['123']));
	});
	it('recovers from a lost final publish through periodic refresh without reopening a private application', async () => {
		vi.useFakeTimers();
		const provider = new MockKVProvider();
		const read = vi.spyOn(ApplicationRepository.prototype, 'getApplication').mockResolvedValue(application);
		const current = cache(provider);
		expect(await current.getEligible()).toEqual(new Set(['123']));
		await provider.acquireLock(officialAppMutationKey('123'), 'mutation', 300);
		await provider.publish(
			INSTANCE_CONFIG_REFRESH_CHANNEL,
			JSON.stringify({type: 'application_invalidate', application_id: '123', mutation_id: 'mutation'}),
		);
		read.mockResolvedValue(new Application({...application.toRow(), bot_is_public: false}));
		await provider.releaseLock(officialAppMutationKey('123'), 'mutation');
		vi.spyOn(provider, 'publish').mockRejectedValue(new Error('final publish failed'));
		await expect(provider.publish(INSTANCE_CONFIG_REFRESH_CHANNEL, '{}')).rejects.toThrow('final publish failed');
		await vi.advanceTimersByTimeAsync(0);
		const beforePeriodicRefresh = read.mock.calls.length;
		await vi.advanceTimersByTimeAsync(30000);
		expect(read.mock.calls.length).toBeGreaterThan(beforePeriodicRefresh);
		expect(await current.getEligible()).toEqual(new Set());
	});
});

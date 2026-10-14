// SPDX-License-Identifier: AGPL-3.0-or-later

import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
import type {CassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import type {PreparedQuery} from '@app/api/database/CassandraTypes';
import {ensurePostgresKvSchema, PostgresKvQueryExecutor} from '@app/api/database/PostgresKvQueryExecutor';
import {
	INSTANCE_CONFIG_REFRESH_CHANNEL,
	INSTANCE_CONFIG_WRITE_ATTEMPTS,
	InstanceConfigRepository,
	InstanceConfigWriteConflictError,
	type InstanceRegistrationConfig,
} from '@app/api/instance/InstanceConfigRepository';
import {InstanceConfigWriteRaceExecutor} from '@app/api/instance/tests/InstanceConfigWriteRaceExecutor';
import {startDockerContainer} from '@app/api/test/DockerTestContainer';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import {
	DEFAULT_DOMAIN_MIGRATION_CONFIG,
	type DomainMigrationConfig,
} from '@fluxer/schema/src/domains/admin/DomainMigrationSchemas';
import {
	DEFAULT_VOICE_NOISE_SUPPRESSION_CONFIG,
	type VoiceNoiseSuppressionConfig,
} from '@fluxer/schema/src/domains/admin/VoiceNoiseSuppressionSchemas';
import {
	DEFAULT_EXPERIMENT_DELIVERY_CONFIG,
	type ExperimentDeliveryConfig,
} from '@fluxer/schema/src/domains/experiment/ExperimentSchemas';
import {
	getDefaultPostgresClient,
	type IPostgresClient,
	initPostgres,
	shutdownPostgres,
} from '@pkgs/postgres/src/Client';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const VOICE_NOISE_SUPPRESSION_CONFIG_KEY = 'voice_noise_suppression_config';
const DOMAIN_MIGRATION_CONFIG_KEY = 'domain_migration_config';
const EXPERIMENT_DELIVERY_CONFIG_KEY = 'experiment_delivery_config';
const APP_PUBLIC_CONFIG_KEY = 'app_public_config';
const INSTANCE_POLICY_CONFIG_KEY = 'instance_policy_config';
const INSTANCE_INTEGRATIONS_CONFIG_KEY = 'instance_integrations_config';
const LEGACY_ALTCHA_CAPTCHA_CONFIG_KEY = 'altcha_captcha_config';
const REGISTRATION_CONFIG_KEY = 'registration_config';
const REGISTRATION_URLS_KEY = 'registration_urls';
const REGISTRATION_PENDING_APPROVALS_KEY = 'registration_pending_approvals';
const POSTGRES_KV_TABLE = 'kv_instance_config_races';
const POSTGRES_CONTAINER = `fluxer-instance-config-races-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const dockerAvailable = spawnSync('docker', ['version'], {stdio: 'ignore'}).status === 0;

class CountingInMemoryCassandraQueryExecutor extends InMemoryCassandraQueryExecutor {
	instanceConfigSelects = 0;

	override async executeQuery<T = Record<string, unknown>>(query: PreparedQuery): Promise<Array<T>> {
		if (query.kvMeta?.action === 'select' && query.kvMeta.table.name === 'instance_configuration') {
			this.instanceConfigSelects++;
		}
		return super.executeQuery<T>(query);
	}
}

describe('InstanceConfigRepository', () => {
	const repositories: Array<InstanceConfigRepository> = [];

	afterEach(() => {
		for (const repository of repositories) {
			repository.shutdown();
		}
		repositories.length = 0;
	});

	function createRepository(kvProvider: MockKVProvider): InstanceConfigRepository {
		const repository = new InstanceConfigRepository(kvProvider);
		repositories.push(repository);
		return repository;
	}

	it('stores and reads the connection cap through the gateway rollout config', async () => {
		setCassandraQueryExecutorForTesting(new CountingInMemoryCassandraQueryExecutor());
		const repository = createRepository(new MockKVProvider());
		expect((await repository.getGatewayRolloutConfig()).max_connections).toBe(0);
		await repository.updateGatewayRolloutConfig((current) => ({...current, max_connections: 18000}));
		expect((await repository.getGatewayRolloutConfig()).max_connections).toBe(18000);
	});
	it('connection cap updates preserve the server-owned game activity epoch', async () => {
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
		const repository = createRepository(new MockKVProvider());
		expect(
			await repository.updateGatewayRolloutConfig((current) => ({
				...current,
				max_connections: 18000,
				game_activity_enabled: true,
				game_activity_epoch: 99,
			})),
		).toMatchObject({max_connections: 18000, game_activity_enabled: true, game_activity_epoch: 1});
		expect(
			await repository.updateGatewayRolloutConfig((current) => ({...current, max_connections: 200000})),
		).toMatchObject({max_connections: 200000, game_activity_enabled: true, game_activity_epoch: 1});
		expect(
			await repository.updateGatewayRolloutConfig((current) => ({...current, game_activity_enabled: false})),
		).toMatchObject({max_connections: 200000, game_activity_enabled: false, game_activity_epoch: 2});
	});

	it('retains persisted noise strength and guild overrides across config cache refreshes', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const writer = createRepository(kvProvider);
		expect(writer.updateVoiceNoiseSuppressionConfig).toBeTypeOf('function');
		const expected = await writer.updateVoiceNoiseSuppressionConfig((current) => ({
			...current,
			enabled: true,
			config_version: 1,
			suppression_strength: 57,
			guild_overrides: [{guild_id: '123', backend: 'rnnoise'}],
		}));
		const reader = createRepository(kvProvider);
		expect(await reader.getVoiceNoiseSuppressionConfig()).toEqual(expected);
	});

	it('serves repeated config reads from the hydrated in-memory cache', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		await repository.setRegistrationConfig({mode: 'closed'});
		executor.instanceConfigSelects = 0;

		expect(await repository.getRegistrationConfig()).toEqual({
			mode: 'closed',
			admin_registration_urls_enabled: true,
		} satisfies InstanceRegistrationConfig);
		expect(await repository.getRegistrationConfig()).toEqual({
			mode: 'closed',
			admin_registration_urls_enabled: true,
		} satisfies InstanceRegistrationConfig);
		expect(executor.instanceConfigSelects).toBe(0);
		expect(kvProvider.getSubscription().subscribedChannels).toContain(INSTANCE_CONFIG_REFRESH_CHANNEL);
	});

	it('reads current gateway rollout config even when its cache missed the refresh', async () => {
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
		const writer = createRepository(new MockKVProvider());
		const reader = createRepository(new MockKVProvider());
		const previous = await writer.updateGatewayRolloutConfig((config) => ({...config, max_connections: 200000}));
		expect(await reader.getConfig('gateway_rollout_config')).toBe(JSON.stringify(previous));

		const current = await writer.updateGatewayRolloutConfig((config) => ({
			...config,
			max_connections: 1,
			session_rollout_percentage: 42,
		}));

		expect(await reader.getConfig('gateway_rollout_config')).toBe(JSON.stringify(previous));
		expect(await reader.getGatewayRolloutConfig()).toEqual(current);
	});

	it('refreshes a hydrated cache after another repository publishes a config update', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const reader = createRepository(kvProvider);
		const writer = createRepository(kvProvider);

		expect(await reader.getRegistrationConfig()).toEqual({
			mode: 'open',
			admin_registration_urls_enabled: true,
		} satisfies InstanceRegistrationConfig);

		await writer.setRegistrationConfig({mode: 'approval'});

		await vi.waitFor(async () => {
			expect(await reader.getRegistrationConfig()).toEqual({
				mode: 'approval',
				admin_registration_urls_enabled: true,
			} satisfies InstanceRegistrationConfig);
		});
	});

	it('reuses the memoized effective bluesky config until the integrations blob changes', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		const first = await repository.getEffectiveBlueskyConfig();
		expect(await repository.getEffectiveBlueskyConfig()).toBe(first);

		await repository.setInstanceIntegrationsConfig({bluesky: {client_name: 'Memoized Instance'}});

		const updated = await repository.getEffectiveBlueskyConfig();
		expect(updated).not.toBe(first);
		expect(updated.client_name).toBe('Memoized Instance');
		expect(await repository.getEffectiveBlueskyConfig()).toBe(updated);
	});

	it('recomputes the effective bluesky config after another repository publishes an integrations update', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const reader = createRepository(kvProvider);
		const writer = createRepository(kvProvider);

		const before = await reader.getEffectiveBlueskyConfig();
		expect(await reader.getEffectiveBlueskyConfig()).toBe(before);

		await writer.setInstanceIntegrationsConfig({bluesky: {client_name: 'Refreshed Instance'}});

		await vi.waitFor(async () => {
			expect((await reader.getEffectiveBlueskyConfig()).client_name).toBe('Refreshed Instance');
		});
	});

	it('turns the captcha on at the default difficulty when no row is stored', async () => {
		setCassandraQueryExecutorForTesting(new CountingInMemoryCassandraQueryExecutor());
		const repository = createRepository(new MockKVProvider());

		await expect(repository.getCaptchaConfig()).resolves.toEqual({enabled: true, cost: 5000, max_counter: 1000});
	});

	it('ignores a legacy altcha captcha row that turned the experiment off', async () => {
		setCassandraQueryExecutorForTesting(new CountingInMemoryCassandraQueryExecutor());
		const repository = createRepository(new MockKVProvider());

		await repository.setConfig(
			LEGACY_ALTCHA_CAPTCHA_CONFIG_KEY,
			JSON.stringify({enabled: false, config_version: 4, cost: 5000, max_counter: 10000}),
		);

		await expect(repository.getCaptchaConfig()).resolves.toEqual({enabled: true, cost: 5000, max_counter: 1000});
	});

	it('merges a partial captcha update onto the stored config', async () => {
		setCassandraQueryExecutorForTesting(new CountingInMemoryCassandraQueryExecutor());
		const repository = createRepository(new MockKVProvider());

		await repository.updateCaptchaConfig({cost: 2000});
		await repository.updateCaptchaConfig({enabled: false});

		await expect(repository.getCaptchaConfig()).resolves.toEqual({enabled: false, cost: 2000, max_counter: 1000});
	});

	describe('Turnstile captcha integration', () => {
		const storedTurnstile = {
			provider: 'turnstile',
			hcaptcha_site_key: null,
			hcaptcha_secret_key: null,
			turnstile_site_key: '0x4AAAAAAA-site',
			turnstile_secret_key: '0x4AAAAAAA-secret',
		};

		it('reads the stored Turnstile integration unchanged and keeps it, secrets included, on the next integrations write', async () => {
			setCassandraQueryExecutorForTesting(new CountingInMemoryCassandraQueryExecutor());
			const repository = createRepository(new MockKVProvider());

			await repository.setConfig(
				INSTANCE_INTEGRATIONS_CONFIG_KEY,
				JSON.stringify({gif: {klipy_api_key: null}, youtube: {api_key: 'youtube-key'}, captcha: storedTurnstile}),
			);
			expect((await repository.getInstanceIntegrationsConfig()).captcha).toEqual(storedTurnstile);

			await repository.setInstanceIntegrationsConfig({gif: {klipy_api_key: 'klipy-key'}});

			const stored = JSON.parse((await repository.getConfig(INSTANCE_INTEGRATIONS_CONFIG_KEY)) ?? '{}');
			expect(stored.captcha).toEqual(storedTurnstile);
			expect(stored.youtube.api_key).toBe('youtube-key');
			expect(stored.gif.klipy_api_key).toBe('klipy-key');
		});

		it('resolves Turnstile only while both keys are stored and the captcha switch is on', async () => {
			setCassandraQueryExecutorForTesting(new CountingInMemoryCassandraQueryExecutor());
			const repository = createRepository(new MockKVProvider());

			await expect(repository.getEffectiveCaptchaConfig()).resolves.toMatchObject({
				provider: 'altcha',
				turnstile_site_key: null,
				turnstile_secret_key: null,
			});

			await repository.setConfig(INSTANCE_INTEGRATIONS_CONFIG_KEY, JSON.stringify({captcha: storedTurnstile}));
			await expect(repository.getEffectiveCaptchaConfig()).resolves.toEqual({
				enabled: true,
				cost: 5000,
				max_counter: 1000,
				provider: 'turnstile',
				turnstile_site_key: '0x4AAAAAAA-site',
				turnstile_secret_key: '0x4AAAAAAA-secret',
			});

			await repository.setInstanceIntegrationsConfig({captcha: {turnstile_secret_key: null}});
			await expect(repository.getEffectiveCaptchaConfig()).resolves.toMatchObject({provider: 'altcha'});

			await repository.setInstanceIntegrationsConfig({captcha: {turnstile_secret_key: '0x4AAAAAAA-secret'}});
			await repository.updateCaptchaConfig({enabled: false});
			await expect(repository.getEffectiveCaptchaConfig()).resolves.toMatchObject({
				provider: 'none',
				turnstile_secret_key: null,
			});
		});

		it('shows whether the Turnstile secret is set without returning it', async () => {
			setCassandraQueryExecutorForTesting(new CountingInMemoryCassandraQueryExecutor());
			const repository = createRepository(new MockKVProvider());
			await repository.setConfig(INSTANCE_INTEGRATIONS_CONFIG_KEY, JSON.stringify({captcha: storedTurnstile}));

			const admin = await repository.getInstanceIntegrationsAdminConfig();

			expect(admin.captcha).toEqual({
				provider: 'turnstile',
				effective_provider: 'turnstile',
				turnstile_site_key: '0x4AAAAAAA-site',
				turnstile_secret_key_set: true,
				effective_enabled: true,
			});
			expect(JSON.stringify(admin)).not.toContain('0x4AAAAAAA-secret');
		});
	});

	it('keeps the stored setup state when a branding field is invalid', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		await repository.setConfig(
			APP_PUBLIC_CONFIG_KEY,
			JSON.stringify({branding: {product_name: 'Kept', icon_url: 42}, setup: {configured: false}}),
		);

		const config = await repository.getAppPublicConfig();
		expect(config.setup.configured).toBe(false);
		expect(config.branding.product_name).toBe('Kept');
	});

	it('reads a stored legal config written before source_url existed', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		await repository.setConfig(
			APP_PUBLIC_CONFIG_KEY,
			JSON.stringify({legal: {terms_url: 'https://x/t', privacy_url: 'https://x/p'}}),
		);

		expect((await repository.getAppPublicConfig()).legal).toEqual({
			terms_url: 'https://x/t',
			privacy_url: 'https://x/p',
			source_url: null,
		});
	});

	it('keeps valid stored instance policy flags when one field is invalid', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		await repository.setConfig(
			INSTANCE_POLICY_CONFIG_KEY,
			JSON.stringify({direct_messages_disabled: true, single_community_enabled: true, premium_mode: 'nonsense'}),
		);

		const policy = await repository.getInstancePolicyConfig();
		expect(policy.direct_messages_disabled).toBe(true);
		expect(policy.single_community_enabled).toBe(true);
		expect(policy.premium_mode).toBe('everyone');
	});

	it('keeps valid stored integration settings when one field is invalid', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		await repository.setConfig(
			INSTANCE_INTEGRATIONS_CONFIG_KEY,
			JSON.stringify({bluesky: {client_name: 'Kept Instance', enabled: 'yes'}}),
		);

		expect((await repository.getEffectiveBlueskyConfig()).client_name).toBe('Kept Instance');
		expect((await repository.getInstanceIntegrationsConfig()).bluesky.enabled).toBeNull();
	});

	it('drops invalid stored SSO allowed domains and keeps the valid ones', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		await repository.setConfig('sso_allowed_domains', JSON.stringify(['example.com', 'nope@example.com', 'Kept.ORG']));

		expect((await repository.getSsoConfig()).allowedEmailDomains).toEqual(['example.com', 'kept.org']);
	});

	it('falls back to the default SSO flags when a stored flag is not a boolean', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		await repository.setConfig('sso_enabled', 'yes');
		await repository.setConfig('sso_enforced', 'sometimes');
		await repository.setConfig('sso_auto_provision', 'maybe');

		const config = await repository.getSsoConfig();
		expect(config.enabled).toBe(false);
		expect(config.enforced).toBe(false);
		expect(config.autoProvision).toBe(true);
	});

	it('clears an invalid allowed domain list only while SSO is disabled', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		const cleared = await repository.setSsoConfig({enabled: false, allowedEmailDomains: ['nope@example.com']});
		expect(cleared.allowedEmailDomains).toEqual([]);

		await expect(repository.setSsoConfig({enabled: true, allowedEmailDomains: ['nope@example.com']})).rejects.toThrow();
	});

	it('keeps an all-invalid stored allowed domain list non-empty so SSO still rejects every domain', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		await repository.setConfig('sso_allowed_domains', JSON.stringify(['nope@example.com', 'bad/domain']));

		const domains = (await repository.getSsoConfig()).allowedEmailDomains;
		expect(domains.length).toBeGreaterThan(0);
		expect(domains).not.toContain('example.com');
	});

	it('returns the default voice noise suppression config when the key is absent', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		await expect(repository.getVoiceNoiseSuppressionConfig()).resolves.toEqual(DEFAULT_VOICE_NOISE_SUPPRESSION_CONFIG);
	});

	it.each([
		{name: 'unparseable text', stored: 'not-json'},
		{name: 'a json array', stored: '[]'},
		{name: 'out-of-range values', stored: '{"rollout_basis_points":99999}'},
		{name: 'an unknown backend', stored: '{"default_backend":"magic"}'},
	])('falls back to the default voice noise suppression config for $name', async ({stored}) => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		await repository.setConfig(VOICE_NOISE_SUPPRESSION_CONFIG_KEY, stored);

		await expect(repository.getVoiceNoiseSuppressionConfig()).resolves.toEqual(DEFAULT_VOICE_NOISE_SUPPRESSION_CONFIG);
	});

	it('round-trips a stored voice noise suppression config', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		const config: VoiceNoiseSuppressionConfig = {
			...DEFAULT_VOICE_NOISE_SUPPRESSION_CONFIG,
			enabled: true,
			config_version: 3,
			default_backend: 'rnnoise',
			enabled_backends: ['none', 'standard', 'rnnoise'],
			allow_user_override: false,
			rollout_basis_points: 2500,
			rollout_salt: 'voice-ns-v2',
			included_user_ids: ['1400000000000000001'],
			excluded_user_ids: ['1400000000000000002'],
			guild_overrides: [{guild_id: '2400000000000000001', backend: 'rnnoise'}],
			suppression_strength: 55,
		};
		await repository.setVoiceNoiseSuppressionConfig(config);

		await expect(repository.getVoiceNoiseSuppressionConfig()).resolves.toEqual(config);
	});

	it('fills newly added voice noise suppression fields from the schema defaults', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		await repository.setConfig(
			VOICE_NOISE_SUPPRESSION_CONFIG_KEY,
			JSON.stringify({enabled: true, config_version: 2, rollout_basis_points: 1000}),
		);

		await expect(repository.getVoiceNoiseSuppressionConfig()).resolves.toEqual({
			...DEFAULT_VOICE_NOISE_SUPPRESSION_CONFIG,
			enabled: true,
			config_version: 2,
			rollout_basis_points: 1000,
		});
	});

	describe('keeps the stored Micup config rows through a read and a rewrite', () => {
		const LIVE_VOICE_NOISE_SUPPRESSION_ROW = {
			enabled: true,
			pipeline_v2_enabled: true,
			pipeline_v2_all: true,
			pipeline_v2_gate_open_probability: 0.6,
			pipeline_v2_gate_refresh_probability: 0.35,
			pipeline_v2_gate_hangover_ms: 400,
			pipeline_v2_gain_target_dbfs: -26,
			pipeline_v2_gain_max_db: 20,
			config_version: 9,
			default_backend: 'deep_filter',
			enabled_backends: ['deep_filter'],
			allow_user_override: false,
			rollout_basis_points: 10000,
			rollout_salt: 'voice-ns-v1',
			included_user_ids: [],
			excluded_user_ids: [],
			guild_overrides: [],
			suppression_strength: 80,
		};
		const TUNED_VOICE_NOISE_SUPPRESSION_ROW = {
			...LIVE_VOICE_NOISE_SUPPRESSION_ROW,
			pipeline_v2_all: false,
			pipeline_v2_gate_open_probability: 0.7,
			pipeline_v2_gate_refresh_probability: 0.4,
			pipeline_v2_gate_hangover_ms: 600,
			pipeline_v2_gain_target_dbfs: -24,
			pipeline_v2_gain_max_db: 12,
			config_version: 12,
			enabled_backends: ['rnnoise', 'deep_filter'],
			allow_user_override: true,
			rollout_basis_points: 2500,
			rollout_salt: 'voice-ns-v3',
			included_user_ids: ['1400000000000000001'],
			excluded_user_ids: ['1400000000000000002'],
			guild_overrides: [{guild_id: '2400000000000000001', backend: 'deep_filter', pipeline_v2: true}],
			suppression_strength: 65,
		};

		async function storedRow(repository: InstanceConfigRepository, key: string): Promise<unknown> {
			return JSON.parse((await repository.getConfig(key)) ?? 'null');
		}

		it.each([
			{name: 'the live config version 9 row', row: LIVE_VOICE_NOISE_SUPPRESSION_ROW},
			{name: 'a row with every pipeline v2 tuning field set', row: TUNED_VOICE_NOISE_SUPPRESSION_ROW},
		])('voice noise suppression: $name', async ({row}) => {
			setCassandraQueryExecutorForTesting(new CountingInMemoryCassandraQueryExecutor());
			const repository = createRepository(new MockKVProvider());
			await repository.setConfig(VOICE_NOISE_SUPPRESSION_CONFIG_KEY, JSON.stringify(row));

			await expect(repository.getVoiceNoiseSuppressionConfig()).resolves.toEqual(row);
			await repository.updateVoiceNoiseSuppressionConfig((current) => current);
			expect(await storedRow(repository, VOICE_NOISE_SUPPRESSION_CONFIG_KEY)).toEqual(row);
		});

		it('voice room: the live row', async () => {
			setCassandraQueryExecutorForTesting(new CountingInMemoryCassandraQueryExecutor());
			const repository = createRepository(new MockKVProvider());
			const row = {
				rooms_enabled: true,
				games_enabled: true,
				room_cameras_enabled: true,
				default_room_theme: 'gece-lounge',
			};
			await repository.setConfig('voice_room_config', JSON.stringify(row));

			await expect(repository.getVoiceRoomConfig()).resolves.toEqual(row);
			await repository.updateVoiceRoomConfig((current) => current);
			expect(await storedRow(repository, 'voice_room_config')).toEqual(row);
		});

		it('shop: a row with every setting away from its default', async () => {
			setCassandraQueryExecutorForTesting(new CountingInMemoryCassandraQueryExecutor());
			const repository = createRepository(new MockKVProvider());
			const row = {
				try_to_azn_rate_micro: 41_250,
				try_rate_date: '2026-10-10',
				try_rate_fetched_at: '2026-10-10T06:00:00.000Z',
				try_to_azn_rate_override_micro: 40_500,
				try_rate_override_at: '2026-10-09T12:00:00.000Z',
				premium_sales_open: true,
				item_sales_open: true,
				usd_to_azn_rate_micro: 1_699_500,
				premium_discount_percent: 10,
				visionary_on_sale: true,
				visionary_reward_item_ids: ['1420000000000000001'],
			};
			await repository.setConfig('shop_config', JSON.stringify(row));

			await expect(repository.getShopConfig()).resolves.toEqual(row);
			await repository.updateShopConfig((current) => ({premium_discount_percent: current.premium_discount_percent}));
			expect(await storedRow(repository, 'shop_config')).toEqual(row);
		});

		it('referral: a row with settings and tiers', async () => {
			setCassandraQueryExecutorForTesting(new CountingInMemoryCassandraQueryExecutor());
			const repository = createRepository(new MockKVProvider());
			const row = {
				enabled: true,
				min_active_days: 5,
				daily_valid_cap: 20,
				ip_registration_limit: 2,
				tiers: [
					{
						id: '1420000000000000101',
						threshold: 3,
						reward: {type: 'cosmetic', item_id: '1420000000000000102'},
						enabled: true,
						created_at: '2026-10-02T04:45:00.000Z',
					},
					{
						id: '1420000000000000103',
						threshold: 10,
						reward: {type: 'premium_days', days: 30},
						enabled: false,
						created_at: '2026-10-02T04:46:00.000Z',
					},
				],
			};
			await repository.setConfig('referral_config', JSON.stringify(row));

			await expect(repository.getReferralConfig()).resolves.toEqual(row);
			await repository.updateReferralConfig((current) => ({enabled: current.enabled}));
			expect(await storedRow(repository, 'referral_config')).toEqual(row);
		});

		it('instance policy: the live row keeps the trial, premium mode and official apps', async () => {
			setCassandraQueryExecutorForTesting(new CountingInMemoryCassandraQueryExecutor());
			const repository = createRepository(new MockKVProvider());
			const micupFields = {
				single_community_enabled: false,
				single_community_guild_id: null,
				direct_messages_disabled: false,
				direct_messages_locked: false,
				premium_mode: 'mirror',
				premium_trial_days: 7,
				official_apps: [
					{application_id: '1420000000000000201', invite_permissions: '1099914357910'},
					{application_id: '1420000000000000202', invite_permissions: '268504128'},
				],
				gif_enabled: null,
				youtube_enabled: null,
				bluesky_enabled: null,
				deferred_phone_gate_enabled: false,
			};
			await repository.setConfig(
				INSTANCE_POLICY_CONFIG_KEY,
				JSON.stringify({
					...micupFields,
					deferred_phone_gate_window_hours: 6,
					deferred_phone_gate_member_threshold: 50,
				}),
			);
			const expected = {...micupFields, guild_create_access: true};

			await expect(repository.getInstancePolicyConfig()).resolves.toEqual(expected);
			await repository.updateInstancePolicyConfig((current) => ({premium_trial_days: current.premium_trial_days}));
			expect(await storedRow(repository, INSTANCE_POLICY_CONFIG_KEY)).toEqual(expected);
		});

		it('app public: the live branding, legal links and a default locale', async () => {
			setCassandraQueryExecutorForTesting(new CountingInMemoryCassandraQueryExecutor());
			const repository = createRepository(new MockKVProvider());
			const row = {
				branding: {
					product_name: 'Micup',
					icon_url: 'https://media.micup.gg/branding/0/14a74a1a.png',
					symbol_url: 'https://media.micup.gg/branding/0/2502f636.png',
					logo_url: 'https://media.micup.gg/branding/0/2502f636.png',
					wordmark_url: 'https://media.micup.gg/branding/0/c6741cf1.png',
					favicon_url: 'https://media.micup.gg/branding/0/14a74a1a.png',
					theme_color: '#0B0B0C',
					status_page_url: null,
					status_page_incident_history_url: null,
				},
				setup: {configured: true},
				legal: {
					terms_url: 'https://micup.gg/yasal/kullanim-sartlari.html',
					privacy_url: 'https://micup.gg/yasal/gizlilik.html',
					source_url: 'https://micup.gg/yasal/kaynak',
				},
				registration: {collect_date_of_birth: true},
				localization: {default_locale: 'tr', default_locale_time_zones: ['Europe/Istanbul']},
			};
			await repository.setConfig(APP_PUBLIC_CONFIG_KEY, JSON.stringify(row));

			await expect(repository.getAppPublicConfig()).resolves.toMatchObject(row);
			await repository.setAppPublicConfig({legal: row.legal});
			expect(await storedRow(repository, APP_PUBLIC_CONFIG_KEY)).toMatchObject(row);
		});
	});

	it('returns the default domain migration config when the key is absent', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		await expect(repository.getDomainMigrationConfig()).resolves.toEqual(DEFAULT_DOMAIN_MIGRATION_CONFIG);
	});

	it.each([
		{name: 'unparseable text', stored: 'not-json'},
		{name: 'a json array', stored: '[]'},
		{name: 'out-of-range values', stored: '{"rollout_basis_points":99999}'},
		{name: 'a non-boolean enabled flag', stored: '{"enabled":"yes"}'},
	])('falls back to the default domain migration config for $name', async ({stored}) => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		await repository.setConfig(DOMAIN_MIGRATION_CONFIG_KEY, stored);

		await expect(repository.getDomainMigrationConfig()).resolves.toEqual(DEFAULT_DOMAIN_MIGRATION_CONFIG);
	});

	it('round-trips a stored domain migration config', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		const config: DomainMigrationConfig = {
			...DEFAULT_DOMAIN_MIGRATION_CONFIG,
			enabled: true,
			config_version: 5,
			rollout_basis_points: 2500,
			rollout_salt: 'domain-migration-v2',
			included_user_ids: ['1400000000000000001'],
			excluded_user_ids: ['1400000000000000002'],
			anonymous_rollout_basis_points: 300,
			standalone_forwarding: true,
		};
		await repository.setDomainMigrationConfig(config);

		await expect(repository.getDomainMigrationConfig()).resolves.toEqual(config);
	});

	it('fills newly added domain migration fields from the schema defaults', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		await repository.setConfig(
			DOMAIN_MIGRATION_CONFIG_KEY,
			JSON.stringify({enabled: true, config_version: 2, rollout_basis_points: 1000}),
		);

		await expect(repository.getDomainMigrationConfig()).resolves.toEqual({
			...DEFAULT_DOMAIN_MIGRATION_CONFIG,
			enabled: true,
			config_version: 2,
			rollout_basis_points: 1000,
		});
	});

	it('publishes a refresh so another repository observes the domain migration config', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const reader = createRepository(kvProvider);
		const writer = createRepository(kvProvider);

		await expect(reader.getDomainMigrationConfig()).resolves.toEqual(DEFAULT_DOMAIN_MIGRATION_CONFIG);

		await writer.setDomainMigrationConfig({
			...DEFAULT_DOMAIN_MIGRATION_CONFIG,
			enabled: true,
			config_version: 1,
		});

		await vi.waitFor(async () => {
			expect(await reader.getDomainMigrationConfig()).toMatchObject({enabled: true, config_version: 1});
		});
	});

	it('publishes a refresh so another repository observes the voice noise suppression config', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const reader = createRepository(kvProvider);
		const writer = createRepository(kvProvider);

		await expect(reader.getVoiceNoiseSuppressionConfig()).resolves.toEqual(DEFAULT_VOICE_NOISE_SUPPRESSION_CONFIG);

		await writer.setVoiceNoiseSuppressionConfig({
			...DEFAULT_VOICE_NOISE_SUPPRESSION_CONFIG,
			enabled: true,
			config_version: 1,
		});

		await vi.waitFor(async () => {
			expect(await reader.getVoiceNoiseSuppressionConfig()).toMatchObject({enabled: true, config_version: 1});
		});
	});

	it('returns the default experiment delivery config when the key is absent', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		await expect(repository.getExperimentDeliveryConfig()).resolves.toEqual(DEFAULT_EXPERIMENT_DELIVERY_CONFIG);
	});

	it.each([
		{name: 'unparseable text', stored: 'not-json'},
		{name: 'a json array', stored: '[]'},
		{name: 'an out-of-range poll interval', stored: '{"poll_interval_seconds":1}'},
		{name: 'an out-of-range jitter', stored: '{"poll_jitter_percent":99}'},
		{name: 'a non-numeric poll interval', stored: '{"poll_interval_seconds":"often"}'},
	])('falls back to the default experiment delivery config for $name', async ({stored}) => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		await repository.setConfig(EXPERIMENT_DELIVERY_CONFIG_KEY, stored);

		await expect(repository.getExperimentDeliveryConfig()).resolves.toEqual(DEFAULT_EXPERIMENT_DELIVERY_CONFIG);
	});

	it('round-trips a stored experiment delivery config', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		const config: ExperimentDeliveryConfig = {poll_interval_seconds: 900, poll_jitter_percent: 0};
		await repository.setExperimentDeliveryConfig(config);

		await expect(repository.getExperimentDeliveryConfig()).resolves.toEqual(config);
	});

	it('fills missing experiment delivery fields from the schema defaults', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		await repository.setConfig(EXPERIMENT_DELIVERY_CONFIG_KEY, JSON.stringify({poll_interval_seconds: 3600}));

		await expect(repository.getExperimentDeliveryConfig()).resolves.toEqual({
			...DEFAULT_EXPERIMENT_DELIVERY_CONFIG,
			poll_interval_seconds: 3600,
		});
	});

	it('uses the registration URL id as the admin-visible registration code', async () => {
		const executor = new CountingInMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		const kvProvider = new MockKVProvider();
		const repository = createRepository(kvProvider);

		const created = await repository.createRegistrationUrl({
			label: 'Support invite',
			createdByUserId: '1500000000000000000',
			expiresAt: null,
			maxUses: null,
			approvalRequired: false,
		});

		expect(created.code).toBe(created.registrationUrl.id);
		expect(created.registrationUrl).not.toHaveProperty('code_hash');
		await expect(repository.resolveRegistrationUrlCode(created.registrationUrl.id)).resolves.toMatchObject({
			id: created.registrationUrl.id,
		});
	});
});

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (typeof address === 'string' || address === null) {
				reject(new Error('no port'));
				return;
			}
			server.close(() => resolve(address.port));
		});
	});
}

function describeConcurrentInstanceConfigWrites(prepareBase: () => Promise<CassandraQueryExecutorForTesting>): void {
	const pods: Array<InstanceConfigRepository> = [];
	let executor: InstanceConfigWriteRaceExecutor;

	beforeEach(async () => {
		executor = new InstanceConfigWriteRaceExecutor(await prepareBase());
		setCassandraQueryExecutorForTesting(executor);
	});

	afterEach(async () => {
		await Promise.all(pods.map((pod) => pod.shutdown()));
		pods.length = 0;
	});

	function createPod(): InstanceConfigRepository {
		const pod = new InstanceConfigRepository(new MockKVProvider());
		pods.push(pod);
		return pod;
	}

	async function readStoredRegistrationConfig(): Promise<unknown> {
		const raw = await executor.readDirectly(REGISTRATION_CONFIG_KEY);
		return raw === null ? null : JSON.parse(raw);
	}

	it('applies two concurrent patches on top of each other instead of dropping one', async () => {
		const first = createPod();
		const second = createPod();
		await first.setRegistrationConfig({mode: 'open', admin_registration_urls_enabled: true});
		await second.getRegistrationConfig();
		executor.watch(REGISTRATION_CONFIG_KEY);
		executor.pauseWritesUntil(2);

		await Promise.all([
			first.setRegistrationConfig({mode: 'closed'}),
			second.setRegistrationConfig({admin_registration_urls_enabled: false}),
		]);

		expect(executor.events.filter((event) => event === 'write rejected')).toHaveLength(1);
		expect(executor.events.filter((event) => event === 'write')).toHaveLength(2);
		expect(await readStoredRegistrationConfig()).toEqual({mode: 'closed', admin_registration_urls_enabled: false});
	});

	it('lets one of two concurrent first writes create the config and applies the other on top', async () => {
		const first = createPod();
		const second = createPod();
		await first.getRegistrationConfig();
		await second.getRegistrationConfig();
		executor.watch(REGISTRATION_CONFIG_KEY);
		executor.pauseWritesUntil(2);

		await Promise.all([
			first.setRegistrationConfig({mode: 'closed'}),
			second.setRegistrationConfig({admin_registration_urls_enabled: false}),
		]);

		expect(executor.events.filter((event) => event === 'write rejected')).toHaveLength(1);
		expect(executor.events.filter((event) => event === 'write')).toHaveLength(2);
		expect(await readStoredRegistrationConfig()).toEqual({mode: 'closed', admin_registration_urls_enabled: false});
	});

	it('re-reads the database, not its stale cache, when a concurrent write lands between its read and its write', async () => {
		const stale = createPod();
		const other = createPod();
		await stale.setRegistrationConfig({mode: 'open', admin_registration_urls_enabled: true});
		await stale.getRegistrationConfig();
		await other.setRegistrationConfig({mode: 'approval'});
		expect(await stale.getRegistrationConfig()).toEqual({mode: 'open', admin_registration_urls_enabled: true});
		executor.watch(REGISTRATION_CONFIG_KEY);
		let competed = false;
		executor.competeBeforeEachWrite(async () => {
			if (competed) return;
			competed = true;
			await executor.writeDirectly(
				REGISTRATION_CONFIG_KEY,
				JSON.stringify({mode: 'approval', admin_registration_urls_enabled: false}),
			);
		});

		await stale.setRegistrationConfig({mode: 'closed'});

		expect(executor.events).toEqual(['read', 'write rejected', 'read', 'write']);
		expect(await readStoredRegistrationConfig()).toEqual({mode: 'closed', admin_registration_urls_enabled: false});
	});

	it('fails loudly and writes nothing once every attempt has lost the race', async () => {
		const pod = createPod();
		await pod.setRegistrationConfig({mode: 'open', admin_registration_urls_enabled: true});
		executor.watch(REGISTRATION_CONFIG_KEY);
		let competingWrites = 0;
		executor.competeBeforeEachWrite(async () => {
			competingWrites++;
			await executor.writeDirectly(
				REGISTRATION_CONFIG_KEY,
				JSON.stringify({mode: 'approval', admin_registration_urls_enabled: competingWrites % 2 === 0}),
			);
		});

		const write = pod.setRegistrationConfig({mode: 'closed'});

		await expect(write).rejects.toBeInstanceOf(InstanceConfigWriteConflictError);
		await expect(write).rejects.toMatchObject({
			status: 409,
			code: 'CONFLICT',
			message: expect.stringContaining(REGISTRATION_CONFIG_KEY),
		});
		expect(executor.events.filter((event) => event === 'write rejected')).toHaveLength(INSTANCE_CONFIG_WRITE_ATTEMPTS);
		expect(executor.events).not.toContain('write');
		expect(await readStoredRegistrationConfig()).toEqual({
			mode: 'approval',
			admin_registration_urls_enabled: INSTANCE_CONFIG_WRITE_ATTEMPTS % 2 === 0,
		});
	});

	it('keeps a pending registration another pod added while this pod held a stale list', async () => {
		const first = createPod();
		const second = createPod();
		await first.getPendingRegistrations();
		await second.getPendingRegistrations();

		await first.addPendingRegistration(pendingRegistration('1400000000000000011'));
		await second.addPendingRegistration(pendingRegistration('1400000000000000012'));

		const listed = await createPod().getPendingRegistrations();
		expect(listed.map((entry) => entry.user_id)).toEqual(['1400000000000000011', '1400000000000000012']);
	});

	it('keeps a pending registration another pod stored and removes it once decided', async () => {
		const pod = createPod();
		await executor.writeDirectly(
			REGISTRATION_PENDING_APPROVALS_KEY,
			JSON.stringify([pendingRegistration('1400000000000000021')]),
		);
		await pod.addPendingRegistration(pendingRegistration('1400000000000000022'));

		expect((await createPod().getPendingRegistrations()).map((entry) => entry.user_id)).toEqual([
			'1400000000000000021',
			'1400000000000000022',
		]);

		await pod.removePendingRegistration('1400000000000000021');
		await pod.removePendingRegistration('1400000000000000022');

		expect(await createPod().getPendingRegistrations()).toEqual([]);
		expect(await executor.readDirectly(REGISTRATION_PENDING_APPROVALS_KEY)).toBe('[]');
	});

	it('keeps a registration URL another pod created while this pod held a stale list', async () => {
		const first = createPod();
		const second = createPod();
		await first.getRegistrationUrls();
		await second.getRegistrationUrls();

		const created = [
			await first.createRegistrationUrl(registrationUrlParams(null)),
			await second.createRegistrationUrl(registrationUrlParams(null)),
		];

		const listed = await createPod().getRegistrationUrlsForAdmin();
		expect(listed.map((url) => url.id).toSorted()).toEqual(created.map((entry) => entry.registrationUrl.id).toSorted());
	});

	it('refuses a registration URL another pod revoked while this pod held a stale list', async () => {
		const admin = createPod();
		const signup = createPod();
		const {code, registrationUrl} = await admin.createRegistrationUrl(registrationUrlParams(null));
		expect(await signup.resolveRegistrationUrlCode(code)).not.toBeNull();

		await admin.revokeRegistrationUrl(registrationUrl.id);

		await expect(signup.resolveRegistrationUrlCode(code)).resolves.toBeNull();
		await expect(signup.claimRegistrationUrlUse(registrationUrl.id, '1400000000000000501')).resolves.toBeNull();
		const [listed] = await createPod().getRegistrationUrlsForAdmin();
		expect(listed?.use_count).toBe(0);
	});

	it('admits a registration URL another pod created while this pod held a stale list', async () => {
		const admin = createPod();
		const signup = createPod();
		await signup.getRegistrationUrls();

		const {code, registrationUrl} = await admin.createRegistrationUrl(registrationUrlParams(1));

		await expect(signup.resolveRegistrationUrlCode(code)).resolves.toMatchObject({
			id: registrationUrl.id,
			approval_required: false,
		});
		await expect(signup.claimRegistrationUrlUse(registrationUrl.id, '1400000000000000601')).resolves.not.toBeNull();
		const [listed] = await createPod().getRegistrationUrlsForAdmin();
		expect(listed?.use_count).toBe(1);
	});

	it('never seats more signups than max_uses when pods claim the same registration URL at once', async () => {
		const pods = [createPod(), createPod(), createPod()];
		const {code} = await pods[0]!.createRegistrationUrl(registrationUrlParams(2));
		const registrationUrl = await pods[0]!.resolveRegistrationUrlCode(code);
		if (registrationUrl === null) throw new Error('registration URL did not resolve');

		const claims = await Promise.all(
			Array.from({length: 6}, (_, index) =>
				pods[index % pods.length]!.claimRegistrationUrlUse(registrationUrl.id, `14000000000000001${index}0`),
			),
		);

		expect(claims.filter((claim) => claim !== null)).toHaveLength(2);
		const [listed] = await createPod().getRegistrationUrlsForAdmin();
		expect(listed?.use_count).toBe(2);
		await expect(createPod().resolveRegistrationUrlCode(code)).resolves.toBeNull();
	});

	it('refuses a claim whose retry finds the registration URL exhausted, rather than reporting the lost attempt', async () => {
		const pod = createPod();
		const {code, registrationUrl} = await pod.createRegistrationUrl(registrationUrlParams(1));
		expect(await pod.resolveRegistrationUrlCode(code)).not.toBeNull();
		executor.watch(REGISTRATION_URLS_KEY);
		let competed = false;
		executor.competeBeforeEachWrite(async () => {
			if (competed) return;
			competed = true;
			const stored = JSON.parse((await executor.readDirectly(REGISTRATION_URLS_KEY)) ?? 'null') as Array<
				Record<string, unknown>
			>;
			await executor.writeDirectly(
				REGISTRATION_URLS_KEY,
				JSON.stringify(
					stored.map((entry) => ({
						...entry,
						use_count: 1,
						last_used_at: '2026-09-20T00:00:00.000Z',
						last_used_by_user_id: '1400000000000000901',
					})),
				),
			);
		});

		await expect(pod.claimRegistrationUrlUse(registrationUrl.id, '1400000000000000902')).resolves.toBeNull();

		expect(executor.events).toEqual(['read', 'write rejected', 'read']);
		const [listed] = await createPod().getRegistrationUrlsForAdmin();
		expect(listed).toMatchObject({use_count: 1, last_used_by_user_id: '1400000000000000901'});
	});

	it('counts concurrent uses of an uncapped registration URL without ever refusing one', async () => {
		const pods = [createPod(), createPod()];
		const {code} = await pods[0]!.createRegistrationUrl(registrationUrlParams(null));
		const registrationUrl = await pods[0]!.resolveRegistrationUrlCode(code);
		if (registrationUrl === null) throw new Error('registration URL did not resolve');

		const claims = await Promise.all(
			Array.from({length: 5}, (_, index) =>
				pods[index % pods.length]!.claimRegistrationUrlUse(registrationUrl.id, `14000000000000002${index}0`),
			),
		);

		expect(claims.every((claim) => claim !== null)).toBe(true);
		const [listed] = await createPod().getRegistrationUrlsForAdmin();
		expect(listed?.use_count).toBe(5);
	});

	it('frees a released seat for the next signup', async () => {
		const pod = createPod();
		const {code} = await pod.createRegistrationUrl(registrationUrlParams(1));
		const registrationUrl = await pod.resolveRegistrationUrlCode(code);
		if (registrationUrl === null) throw new Error('registration URL did not resolve');

		const failedSignup = await pod.claimRegistrationUrlUse(registrationUrl.id, '1400000000000000301');
		if (failedSignup === null) throw new Error('the first claim was refused');
		await expect(pod.claimRegistrationUrlUse(registrationUrl.id, '1400000000000000302')).resolves.toBeNull();
		await pod.releaseRegistrationUrlUse(failedSignup);

		await expect(pod.claimRegistrationUrlUse(registrationUrl.id, '1400000000000000303')).resolves.not.toBeNull();
		const [listed] = await createPod().getRegistrationUrlsForAdmin();
		expect(listed).toMatchObject({use_count: 1, last_used_by_user_id: '1400000000000000303'});
	});

	it('enforces max_uses against the use count already stored in the blob', async () => {
		const pod = createPod();
		const id = 'b3c4f0b2-8a6e-4c41-9f55-3f0c2a7d1e91';
		await executor.writeDirectly(
			REGISTRATION_URLS_KEY,
			JSON.stringify([
				{
					id,
					label: 'Issued earlier',
					code_hash: createHash('sha256').update(id).digest('hex'),
					created_by_user_id: '1400000000000000001',
					created_at: '2026-09-01T00:00:00.000Z',
					expires_at: null,
					max_uses: 3,
					use_count: 2,
					revoked_at: null,
					approval_required: true,
					last_used_at: '2026-09-02T00:00:00.000Z',
					last_used_by_user_id: '1400000000000000002',
				},
			]),
		);

		expect(await pod.getRegistrationUrlsForAdmin()).toEqual([
			expect.objectContaining({
				id,
				use_count: 2,
				max_uses: 3,
				approval_required: true,
				last_used_at: '2026-09-02T00:00:00.000Z',
				last_used_by_user_id: '1400000000000000002',
			}),
		]);
		const registrationUrl = await pod.resolveRegistrationUrlCode(id);
		if (registrationUrl === null) throw new Error('stored registration URL did not resolve');
		expect(registrationUrl).toMatchObject({id, approval_required: true});

		await expect(pod.claimRegistrationUrlUse(registrationUrl.id, '1400000000000000401')).resolves.not.toBeNull();
		await expect(pod.claimRegistrationUrlUse(registrationUrl.id, '1400000000000000402')).resolves.toBeNull();

		const [listed] = await createPod().getRegistrationUrlsForAdmin();
		expect(listed).toMatchObject({use_count: 3, max_uses: 3, last_used_by_user_id: '1400000000000000401'});
		await expect(pod.resolveRegistrationUrlCode(id)).resolves.toBeNull();
		expect(JSON.parse((await executor.readDirectly(REGISTRATION_URLS_KEY)) ?? 'null')[0]).toMatchObject({
			use_count: 3,
			max_uses: 3,
		});
	});

	it('keeps an SSO field another pod changed while this pod held a stale snapshot', async () => {
		const first = createPod();
		const second = createPod();
		await first.getSsoConfig();
		await second.getSsoConfig();

		await first.setSsoConfig({displayName: 'Set by the first pod'});
		await second.setSsoConfig({clientId: 'set-by-the-second-pod'});

		expect(await createPod().getSsoConfig()).toMatchObject({
			displayName: 'Set by the first pod',
			clientId: 'set-by-the-second-pod',
		});
	});

	it('leaves an SSO row alone when another pod wrote it between this pod reading and writing it', async () => {
		const pod = createPod();
		await pod.getSsoConfig();
		executor.watch('sso_enforced');
		let competed = false;
		executor.competeBeforeEachWrite(async () => {
			if (competed) return;
			competed = true;
			await executor.writeDirectly('sso_enforced', 'true');
		});

		await pod.setSsoConfig({displayName: 'Only the display name'});

		expect(await executor.readDirectly('sso_enforced')).toBe('true');
		expect(await executor.readDirectly('sso_display_name')).toBe('Only the display name');
	});
}

function pendingRegistration(userId: string) {
	return {
		user_id: userId,
		username: `pending_${userId.slice(-3)}`,
		discriminator: 1,
		global_name: null,
		email: `${userId}@example.com`,
		requested_at: `2026-09-01T00:00:${userId.slice(-2)}.000Z`,
		registration_url_id: null,
		client_ip: '127.0.0.1',
	};
}

function registrationUrlParams(maxUses: number | null) {
	return {
		label: maxUses === null ? 'Uncapped' : `Capped at ${maxUses}`,
		createdByUserId: '1400000000000000001',
		expiresAt: null,
		maxUses,
		approvalRequired: false,
	};
}

describe('InstanceConfigRepository concurrent writes', () => {
	describe('in memory', () => {
		describeConcurrentInstanceConfigWrites(async () => new InMemoryCassandraQueryExecutor());
	});

	describe.skipIf(!dockerAvailable)('on postgres', () => {
		let client: IPostgresClient;

		beforeAll(async () => {
			const port = await freePort();
			startDockerContainer([
				'run',
				'-d',
				'--name',
				POSTGRES_CONTAINER,
				'-e',
				'POSTGRES_USER=fluxer',
				'-e',
				'POSTGRES_PASSWORD=fluxer',
				'-e',
				'POSTGRES_DB=fluxer',
				'-p',
				`127.0.0.1:${port}:5432`,
				'postgres:16-alpine',
				'-c',
				'fsync=off',
			]);
			let ready = false;
			for (let attempt = 0; attempt < 180 && !ready; attempt += 1) {
				await sleep(500);
				const probe = spawnSync('docker', ['exec', POSTGRES_CONTAINER, 'pg_isready', '-U', 'fluxer', '-d', 'fluxer'], {
					stdio: 'ignore',
				});
				if (probe.status !== 0) continue;
				try {
					await initPostgres({
						url: `postgres://fluxer:fluxer@127.0.0.1:${port}/fluxer`,
						maxConnections: 4,
						kvTable: POSTGRES_KV_TABLE,
					});
					await getDefaultPostgresClient().query('SELECT 1');
					ready = true;
				} catch {
					await shutdownPostgres().catch(() => {});
				}
			}
			if (!ready) throw new Error('postgres never came up');
			client = getDefaultPostgresClient();
			await ensurePostgresKvSchema(client);
		}, 900_000);

		afterAll(async () => {
			setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
			await shutdownPostgres().catch(() => {});
			spawnSync('docker', ['rm', '-f', POSTGRES_CONTAINER], {stdio: 'ignore'});
		});

		describeConcurrentInstanceConfigWrites(async () => {
			await client.query(`DELETE FROM ${POSTGRES_KV_TABLE}`);
			return new PostgresKvQueryExecutor(client);
		});
	});
});

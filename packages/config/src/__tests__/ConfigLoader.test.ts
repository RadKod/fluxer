// SPDX-License-Identifier: AGPL-3.0-or-later

import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig, resetConfig} from '@fluxer/config/src/ConfigLoader';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const MINIMAL_ENV: Record<string, string> = {
	FLUXER_ENV: 'test',
	FLUXER_BASE_DOMAIN: 'localhost',
	FLUXER_PUBLIC_SCHEME: 'http',
	FLUXER_PUBLIC_PORT: '8088',
	FLUXER_CASSANDRA_HOSTS: '127.0.0.1',
	FLUXER_CASSANDRA_PORT: '9042',
	FLUXER_CASSANDRA_KEYSPACE: 'fluxer_test',
	FLUXER_CASSANDRA_LOCAL_DC: 'datacenter1',
	FLUXER_CASSANDRA_USERNAME: 'test-user',
	FLUXER_CASSANDRA_PASSWORD: 'test-password',
	FLUXER_S3_ENDPOINT: 'http://127.0.0.1:3900',
	FLUXER_S3_ACCESS_KEY_ID: 'test-key',
	FLUXER_S3_SECRET_ACCESS_KEY: 'test-secret',
	FLUXER_MEDIA_PROXY_SECRET_KEY: 'test-media-secret',
	FLUXER_MEDIA_PROXY_UPLOAD_RELAY_SECRET_BASE64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
	FLUXER_ADMIN_SECRET_KEY_BASE: 'test-admin-secret',
	FLUXER_ADMIN_OAUTH_CLIENT_SECRET: 'test-admin-oauth-secret',
	FLUXER_GATEWAY_RPC_AUTH_TOKEN: 'test-gateway-token',
	FLUXER_SUDO_MODE_SECRET: 'test-sudo-secret',
	FLUXER_CONNECTION_INITIATION_SECRET: 'test-connection-secret',
	FLUXER_PROFILE_PSEUDONYM_SECRET: 'test-profile-pseudonym-secret',
	FLUXER_VAPID_PUBLIC_KEY: 'BB76bTFIuoqmxJtTfZX0yGTn1f_qu9H03B_nkj8OyExJFkN7Y-HBZZzShnHZoEhXKc5ZRy3jFu7OkBbnaQG-4aw',
	FLUXER_VAPID_PRIVATE_KEY: 'Xgi-3P8J-I3Q6U1HlCcXMuc_tKLGAM9nIfznX3Hz68o',
};

function generateVapidPair(): {publicKey: string; privateKey: string} {
	const {privateKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
	const jwk = privateKey.export({format: 'jwk'});
	const x = Buffer.from(jwk.x ?? '', 'base64url');
	const y = Buffer.from(jwk.y ?? '', 'base64url');
	const d = Buffer.from(jwk.d ?? '', 'base64url');
	return {
		publicKey: Buffer.concat([Buffer.from([0x04]), x, y]).toString('base64url'),
		privateKey: d.toString('base64url'),
	};
}

function stubMinimalEnv(overrides: Record<string, string> = {}): void {
	for (const [key, value] of Object.entries({...MINIMAL_ENV, ...overrides})) {
		vi.stubEnv(key, value);
	}
}

function clearFluxerEnv(): void {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith('FLUXER_')) {
			vi.stubEnv(key, undefined);
		}
	}
}

describe('ConfigLoader', () => {
	beforeEach(() => {
		resetConfig();
		clearFluxerEnv();
	});

	afterEach(() => {
		resetConfig();
		vi.unstubAllEnvs();
	});

	test('a self-hosted instance without FLUXER_ENV runs in production', async () => {
		stubMinimalEnv({
			FLUXER_SELF_HOSTED: 'true',
			FLUXER_PROFILE_PSEUDONYM_SECRET: 'self-hosted-secret',
			FLUXER_POSTGRES_HOST: 'postgres',
			FLUXER_POSTGRES_DATABASE: 'fluxer',
			FLUXER_POSTGRES_PASSWORD: 'self-hosted-password',
		});
		vi.stubEnv('FLUXER_ENV', undefined);
		expect((await loadConfig()).env).toBe('production');
	});

	test('limits default passkey origins to the deployment app origin', async () => {
		stubMinimalEnv();
		const config = await loadConfig();
		expect(config.auth.passkeys.additional_allowed_origins).toEqual(['http://localhost:8088']);
	});

	test('a blank origin list uses only the deployment app origin', async () => {
		stubMinimalEnv({
			FLUXER_BASE_DOMAIN: 'chat.example.com',
			FLUXER_PUBLIC_SCHEME: 'https',
			FLUXER_PUBLIC_PORT: '443',
			FLUXER_PASSKEY_ADDITIONAL_ALLOWED_ORIGINS: ' ',
		});

		const config = await loadConfig();

		expect(config.auth.passkeys.additional_allowed_origins).toEqual(['https://chat.example.com']);
	});

	test('accepts the feed worker lane', async () => {
		stubMinimalEnv({FLUXER_API_WORKER_MODE: 'single_lane', FLUXER_API_WORKER_LANE: 'feed'});
		const config = await loadConfig();
		expect(config.services.api.worker?.lane).toBe('feed');
	});

	test('accepts the video worker lane', async () => {
		stubMinimalEnv({
			FLUXER_API_WORKER_MODE: 'single_lane',
			FLUXER_API_WORKER_LANE: 'video',
			FLUXER_API_WORKER_LANE_CONCURRENCY_OVERRIDES: '{"video": 2}',
		});
		const config = await loadConfig();
		expect(config.services.api.worker?.lane).toBe('video');
		expect(config.services.api.worker?.lane_concurrency_overrides?.video).toBe(2);
	});

	test('accepts the views worker lane', async () => {
		stubMinimalEnv({
			FLUXER_API_WORKER_MODE: 'single_lane',
			FLUXER_API_WORKER_LANE: 'views',
			FLUXER_API_WORKER_LANE_CONCURRENCY_OVERRIDES: '{"views": 2}',
		});
		const config = await loadConfig();
		expect(config.services.api.worker?.lane).toBe('views');
		expect(config.services.api.worker?.lane_concurrency_overrides?.views).toBe(2);
	});

	test('accepts the micupbot lanes', async () => {
		for (const lane of ['micupbot_live', 'micupbot_roles', 'micupbot']) {
			resetConfig();
			stubMinimalEnv({
				FLUXER_API_WORKER_MODE: 'single_lane',
				FLUXER_API_WORKER_LANE: lane,
				FLUXER_API_WORKER_LANE_CONCURRENCY_OVERRIDES: '{"micupbot_live":2,"micupbot_roles":3,"micupbot":4}',
			});
			const config = await loadConfig();
			expect(config.services.api.worker?.lane).toBe(lane);
			expect(config.services.api.worker?.lane_concurrency_overrides).toEqual({
				micupbot_live: 2,
				micupbot_roles: 3,
				micupbot: 4,
			});
		}
	});

	test('reads FLUXER_MICUPBOT_APPLICATION_ID', async () => {
		stubMinimalEnv({FLUXER_MICUPBOT_APPLICATION_ID: '1490000000000000001'});
		expect((await loadConfig()).instance.micupbot_application_id).toBe('1490000000000000001');
	});

	test('accepts the roster worker lane', async () => {
		stubMinimalEnv({
			FLUXER_API_WORKER_MODE: 'single_lane',
			FLUXER_API_WORKER_LANE: 'roster',
			FLUXER_API_WORKER_LANE_CONCURRENCY_OVERRIDES: '{"roster": 2}',
		});
		const config = await loadConfig();
		expect(config.services.api.worker?.lane).toBe('roster');
		expect(config.services.api.worker?.lane_concurrency_overrides?.roster).toBe(2);
	});

	test('accepts the roster_live worker lane', async () => {
		stubMinimalEnv({
			FLUXER_API_WORKER_MODE: 'single_lane',
			FLUXER_API_WORKER_LANE: 'roster_live',
			FLUXER_API_WORKER_LANE_CONCURRENCY_OVERRIDES: '{"roster": 2, "roster_live": 4}',
		});
		const config = await loadConfig();
		expect(config.services.api.worker?.lane).toBe('roster_live');
		expect(config.services.api.worker?.lane_concurrency_overrides).toEqual({roster: 2, roster_live: 4});
	});

	test('reads FLUXER_ROSTER_BOT_APPLICATION_ID', async () => {
		stubMinimalEnv({FLUXER_ROSTER_BOT_APPLICATION_ID: '1490000000000000001'});
		expect((await loadConfig()).instance.roster_bot_application_id).toBe('1490000000000000001');
	});

	test('accepts the referral worker lane', async () => {
		stubMinimalEnv({
			FLUXER_API_WORKER_MODE: 'single_lane',
			FLUXER_API_WORKER_LANE: 'referral',
			FLUXER_API_WORKER_LANE_CONCURRENCY_OVERRIDES: '{"referral": 2}',
		});
		const config = await loadConfig();
		expect(config.services.api.worker?.lane).toBe('referral');
		expect(config.services.api.worker?.lane_concurrency_overrides?.referral).toBe(2);
	});

	test('reads the feed view flush partition concurrency and refuses 0 or 9', async () => {
		stubMinimalEnv({FLUXER_API_WORKER_FEED_VIEW_FLUSH_PARTITION_CONCURRENCY: '4'});
		expect((await loadConfig()).services.api.worker?.feed_view_flush_partition_concurrency).toBe(4);
		resetConfig();
		for (const value of ['0', '9']) {
			stubMinimalEnv({FLUXER_API_WORKER_FEED_VIEW_FLUSH_PARTITION_CONCURRENCY: value});
			await expect(loadConfig()).rejects.toThrow(
				'FLUXER_API_WORKER_FEED_VIEW_FLUSH_PARTITION_CONCURRENCY must be an integer between 1 and 8',
			);
		}
	});

	test('reads the profile pseudonym secret and requires it in production', async () => {
		stubMinimalEnv();
		expect((await loadConfig()).auth.profile_pseudonym_secret).toBe('test-profile-pseudonym-secret');
		resetConfig();
		stubMinimalEnv({FLUXER_PROFILE_PSEUDONYM_SECRET: ''});
		expect((await loadConfig()).auth.profile_pseudonym_secret).toBe('fluxer-dev-profile-pseudonym-secret');
		resetConfig();
		stubMinimalEnv({
			FLUXER_ENV: 'production',
			FLUXER_POSTGRES_HOST: 'postgres.internal',
			FLUXER_POSTGRES_DATABASE: 'fluxer_prod',
			FLUXER_POSTGRES_USERNAME: 'fluxer_app',
			FLUXER_POSTGRES_PASSWORD: 'prod-postgres-secret',
			FLUXER_POSTGRES_SSL: 'true',
			FLUXER_PROFILE_PSEUDONYM_SECRET: '',
		});
		await expect(loadConfig()).rejects.toThrow('FLUXER_PROFILE_PSEUDONYM_SECRET is required');
	});

	test('retains the legacy account contact policy settings', async () => {
		const policy = {version: 1, profiles: {capabilities: {allow_users_without_email: true}}};
		stubMinimalEnv({
			FLUXER_ACCOUNT_POLICY_DSL: JSON.stringify(policy),
			FLUXER_ABUSE_POLICY_PHONE_FLAGGING_ENABLED: 'false',
		});
		const config = await loadConfig();
		expect(config.integrations.risk_integration.account_policy_dsl).toEqual(policy);
		expect(config.instance.abuse_policy.phone_flagging.enabled).toBe(false);
	});

	test('reads the pseudonym secret file without changing its shared bytes', async () => {
		const directory = mkdtempSync(join(tmpdir(), 'profile-pseudonym-'));
		const secretFile = join(directory, 'secret');
		try {
			writeFileSync(secretFile, ' shared-secret-bytes \r\n');
			stubMinimalEnv({FLUXER_PROFILE_PSEUDONYM_SECRET: '', FLUXER_PROFILE_PSEUDONYM_SECRET_FILE: secretFile});
			expect((await loadConfig()).auth.profile_pseudonym_secret).toBe(' shared-secret-bytes ');
		} finally {
			rmSync(directory, {recursive: true, force: true});
		}
	});

	test('retains the default legacy phone flagging setting', async () => {
		stubMinimalEnv();
		expect((await loadConfig()).instance.abuse_policy.phone_flagging.enabled).toBe(true);
	});

	test.each(['disabled', 'true', '12', '1.5'])('preserves legacy raw account policy value %s', async (raw) => {
		stubMinimalEnv({FLUXER_ACCOUNT_POLICY_DSL: raw});
		expect((await loadConfig()).integrations.risk_integration.account_policy_dsl).toEqual(
			raw === 'disabled' ? raw : JSON.parse(raw),
		);
	});

	test('rejects unsafe production Postgres defaults', async () => {
		stubMinimalEnv({FLUXER_ENV: 'production'});
		await expect(loadConfig()).rejects.toThrow('FLUXER_POSTGRES_HOST');
	});

	test('allows self-hosted production Postgres without TLS', async () => {
		stubMinimalEnv({
			FLUXER_ENV: 'production',
			FLUXER_SELF_HOSTED: 'true',
			FLUXER_POSTGRES_HOST: 'postgres',
			FLUXER_POSTGRES_DATABASE: 'fluxer',
			FLUXER_POSTGRES_USERNAME: 'fluxer',
			FLUXER_POSTGRES_PASSWORD: 'self-hosted-postgres-secret',
			FLUXER_POSTGRES_SSL: 'false',
		});

		const config = await loadConfig();

		expect(config.instance.self_hosted).toBe(true);
		expect(config.database.postgres.ssl).toBe(false);
	});

	test('still requires TLS for non-self-hosted production Postgres', async () => {
		stubMinimalEnv({
			FLUXER_ENV: 'production',
			FLUXER_POSTGRES_HOST: 'postgres.internal',
			FLUXER_POSTGRES_DATABASE: 'fluxer_prod',
			FLUXER_POSTGRES_USERNAME: 'fluxer_app',
			FLUXER_POSTGRES_PASSWORD: 'prod-postgres-secret',
			FLUXER_POSTGRES_SSL: 'false',
		});

		await expect(loadConfig()).rejects.toThrow('FLUXER_POSTGRES_SSL must be true');
	});

	test('refuses production Cassandra without a quorum consistency', async () => {
		stubMinimalEnv({FLUXER_ENV: 'production', FLUXER_DATABASE_BACKEND: 'cassandra'});
		await expect(loadConfig()).rejects.toThrow('FLUXER_CASSANDRA_CONSISTENCY must be local_quorum');
		resetConfig();
		vi.stubEnv('FLUXER_CASSANDRA_CONSISTENCY', 'local_one');
		await expect(loadConfig()).rejects.toThrow('FLUXER_CASSANDRA_CONSISTENCY must be local_quorum');
	});

	test('accepts production Cassandra with local_quorum or quorum', async () => {
		for (const consistency of ['local_quorum', 'quorum']) {
			resetConfig();
			stubMinimalEnv({
				FLUXER_ENV: 'production',
				FLUXER_DATABASE_BACKEND: 'cassandra',
				FLUXER_CASSANDRA_CONSISTENCY: consistency,
			});
			expect((await loadConfig()).database.cassandra.consistency).toBe(consistency);
		}
	});

	test('leaves the Cassandra consistency optional outside production', async () => {
		for (const env of ['test', 'development']) {
			resetConfig();
			stubMinimalEnv({FLUXER_ENV: env, FLUXER_DATABASE_BACKEND: 'cassandra'});
			expect((await loadConfig()).database.cassandra.consistency).toBeUndefined();
		}
	});

	test('rejects an explicitly blank Cassandra consistency', async () => {
		stubMinimalEnv({FLUXER_CASSANDRA_CONSISTENCY: ''});
		await expect(loadConfig()).rejects.toThrow('Invalid FLUXER_CASSANDRA_CONSISTENCY: ');
	});

	test('preserves the IPInfo key used by shared-network ban classification', async () => {
		stubMinimalEnv({FLUXER_RISK_IPINFO_API_KEY: 'test-ipinfo-key'});
		const config = await loadConfig();
		expect(Reflect.get(config.integrations, 'risk_integration')).toEqual({ipinfo_api_key: 'test-ipinfo-key'});
	});

	test('rejects an App Store product mapped to an unknown slot', async () => {
		stubMinimalEnv({FLUXER_APP_STORE_PRODUCTS: '{"com.fluxer.visionary":"visionary"}'});
		await expect(loadConfig()).rejects.toThrow(
			'Invalid FLUXER_APP_STORE_PRODUCTS slot for com.fluxer.visionary: visionary',
		);
	});

	test('rejects a Google Play product mapped to an unknown slot', async () => {
		stubMinimalEnv({FLUXER_GOOGLE_PLAY_PRODUCTS: '{"plutonium:weekly":"weekly"}'});
		await expect(loadConfig()).rejects.toThrow('Invalid FLUXER_GOOGLE_PLAY_PRODUCTS slot for plutonium:weekly: weekly');
	});

	test('rejects a Google Play product key that does not fit its slot kind', async () => {
		stubMinimalEnv({FLUXER_GOOGLE_PLAY_PRODUCTS: '{"plutonium":"monthly"}'});
		await expect(loadConfig()).rejects.toThrow(
			'FLUXER_GOOGLE_PLAY_PRODUCTS key plutonium does not match its monthly slot',
		);
		resetConfig();
		stubMinimalEnv({FLUXER_GOOGLE_PLAY_PRODUCTS: '{"gift:one":"gift_1_month"}'});
		await expect(loadConfig()).rejects.toThrow(
			'FLUXER_GOOGLE_PLAY_PRODUCTS key gift:one does not match its gift_1_month slot',
		);
	});

	test('rejects a cache purge endpoint that contains credentials', async () => {
		stubMinimalEnv({
			FLUXER_CACHE_PURGE_ADAPTER: 'http',
			FLUXER_CACHE_PURGE_HTTP_ENDPOINT: 'https://purger:secret@purge.internal/purge',
		});
		await expect(loadConfig()).rejects.toThrow(
			'FLUXER_CACHE_PURGE_HTTP_ENDPOINT must be an absolute http or https URL without credentials',
		);
	});

	test('refuses a plain http Payriff base URL at startup, which would send the secret key in clear text', async () => {
		stubMinimalEnv({FLUXER_PAYRIFF_BASE_URL: 'http://api.payriff.com/api/v3'});
		await expect(loadConfig()).rejects.toThrow('FLUXER_PAYRIFF_BASE_URL must be an https URL');

		resetConfig();
		stubMinimalEnv({FLUXER_PAYRIFF_BASE_URL: 'https://api.payriff.com/api/v3'});
		expect((await loadConfig()).integrations.payriff.base_url).toBe('https://api.payriff.com/api/v3');
	});

	test('refuses a plain http Bunny API base, which would send the account key in clear text', async () => {
		stubMinimalEnv({
			FLUXER_CACHE_PURGE_ADAPTER: 'bunny',
			FLUXER_CACHE_PURGE_BUNNY_API_BASE: 'http://api.bunny.net',
			FLUXER_CACHE_PURGE_BUNNY_API_KEY: 'bunny-key',
		});
		await expect(loadConfig()).rejects.toThrow('FLUXER_CACHE_PURGE_BUNNY_API_BASE must be an https URL');

		stubMinimalEnv({
			FLUXER_CACHE_PURGE_ADAPTER: 'http',
			FLUXER_CACHE_PURGE_HTTP_ENDPOINT: 'http://purge.internal/purge',
			FLUXER_CACHE_PURGE_HTTP_TOKEN: 'purge-token',
		});
		expect((await loadConfig()).integrations.cache_purge.http.endpoint).toBe('http://purge.internal/purge');
	});

	test('rejects a cache purge token with spaces or control characters without echoing it', async () => {
		for (const token of ['secret\nvalue', 'secret\rvalue', 'secret value', 'secret-value\n']) {
			stubMinimalEnv({
				FLUXER_CACHE_PURGE_ADAPTER: 'http',
				FLUXER_CACHE_PURGE_HTTP_ENDPOINT: 'https://purge.internal/purge',
				FLUXER_CACHE_PURGE_HTTP_TOKEN: token,
			});
			await expect(loadConfig()).rejects.toThrow(
				/^FLUXER_CACHE_PURGE_HTTP_TOKEN must contain only visible ASCII characters$/,
			);
		}
	});

	test('rejects a controller cache purge endpoint that is not https', async () => {
		stubMinimalEnv({
			FLUXER_CACHE_PURGE_ADAPTER: 'controller',
			FLUXER_CACHE_PURGE_CONTROLLER_ENDPOINT: 'http://controller.test/v1/orgs/a/sites/b/purge',
			FLUXER_CACHE_PURGE_CONTROLLER_TOKEN: 'pak_test',
		});
		await expect(loadConfig()).rejects.toThrow(
			'FLUXER_CACHE_PURGE_CONTROLLER_ENDPOINT must be an absolute https URL without credentials',
		);
	});

	test('loads the queue_only cache purge adapter without an endpoint or a provider key', async () => {
		stubMinimalEnv({FLUXER_CACHE_PURGE_ADAPTER: 'queue_only'});
		const cachePurge = (await loadConfig()).integrations.cache_purge;
		expect(cachePurge.adapter).toBe('queue_only');
		expect(cachePurge.http.token).toBe('');
		expect(cachePurge.bunny.api_key).toBe('');
	});

	test.each([
		['FLUXER_CACHE_PURGE_BUNNY_API_KEY', 'bunny-account-key'],
		['FLUXER_CACHE_PURGE_HTTP_TOKEN', 'purge-token'],
		['FLUXER_CACHE_PURGE_CONTROLLER_TOKEN', 'pak_test'],
	])('refuses %s in a queue_only process without echoing it', async (envName, value) => {
		stubMinimalEnv({FLUXER_CACHE_PURGE_ADAPTER: 'queue_only', [envName]: value});
		const error: unknown = await loadConfig().catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(`${envName} must be empty when FLUXER_CACHE_PURGE_ADAPTER is queue_only`);
	});

	const BUNNY_STREAM_ENV: Record<string, string> = {
		FLUXER_BUNNY_STREAM_LIBRARY_ID: '761025',
		FLUXER_BUNNY_STREAM_API_KEY: 'stream-library-key',
		FLUXER_BUNNY_STREAM_READ_ONLY_API_KEY: 'stream-read-only-key',
		FLUXER_BUNNY_STREAM_CDN_HOSTNAME: 'vz-example.b-cdn.net',
		FLUXER_BUNNY_STREAM_TOKEN_KEY: 'stream-token-key',
		FLUXER_BUNNY_STREAM_STORAGE_ZONE: 'vz-example-zone',
		FLUXER_BUNNY_STREAM_STORAGE_PASSWORD: 'storage-read-only-password',
	};

	function withoutEnv(envName: string): Record<string, string> {
		return Object.fromEntries(Object.entries(BUNNY_STREAM_ENV).filter(([key]) => key !== envName));
	}

	test('maps FLUXER_BUNNY_STREAM_* into integrations.bunny_stream', async () => {
		stubMinimalEnv({
			...BUNNY_STREAM_ENV,
			FLUXER_BUNNY_STREAM_STORAGE_HOST: 'de.storage.bunnycdn.com',
			FLUXER_BUNNY_STREAM_API_BASE: 'https://video.example.net',
			FLUXER_BUNNY_STREAM_TUS_ENDPOINT: 'https://video.example.net/tusupload',
			FLUXER_BUNNY_STREAM_TIMEOUT_MS: '5000',
		});
		expect((await loadConfig()).integrations.bunny_stream).toEqual({
			enabled: true,
			library_id: 761025,
			api_key: 'stream-library-key',
			read_only_api_key: 'stream-read-only-key',
			cdn_hostname: 'vz-example.b-cdn.net',
			token_key: 'stream-token-key',
			storage_zone: 'vz-example-zone',
			storage_password: 'storage-read-only-password',
			storage_host: 'de.storage.bunnycdn.com',
			api_base: 'https://video.example.net',
			tus_endpoint: 'https://video.example.net/tusupload',
			timeout_ms: 5000,
		});
	});

	test('defaults the Bunny Stream hosts and timeout', async () => {
		stubMinimalEnv(BUNNY_STREAM_ENV);
		expect((await loadConfig()).integrations.bunny_stream).toMatchObject({
			enabled: true,
			storage_host: 'storage.bunnycdn.com',
			api_base: 'https://video.bunnycdn.com',
			tus_endpoint: 'https://video.bunnycdn.com/tusupload',
			timeout_ms: 10_000,
		});
	});

	test.each(Object.keys(BUNNY_STREAM_ENV))('refuses a partial Bunny Stream config without %s', async (envName) => {
		stubMinimalEnv(withoutEnv(envName));
		await expect(loadConfig()).rejects.toThrow(`${envName} is required`);
	});

	test('leaves Bunny Stream disabled without a token key or storage password', async () => {
		stubMinimalEnv();
		expect((await loadConfig()).integrations.bunny_stream).toMatchObject({
			enabled: false,
			token_key: '',
			storage_password: '',
		});
		resetConfig();
		// Hosts and the timeout alone configure nothing, so they are not checked either.
		stubMinimalEnv({FLUXER_BUNNY_STREAM_API_BASE: 'http://video.example.net', FLUXER_BUNNY_STREAM_TIMEOUT_MS: '1'});
		expect((await loadConfig()).integrations.bunny_stream.enabled).toBe(false);
		for (const envName of ['FLUXER_BUNNY_STREAM_TOKEN_KEY', 'FLUXER_BUNNY_STREAM_STORAGE_PASSWORD']) {
			resetConfig();
			clearFluxerEnv();
			stubMinimalEnv(withoutEnv(envName));
			await expect(loadConfig()).rejects.toThrow(`${envName} is required`);
		}
	});

	test.each([
		['FLUXER_BUNNY_STREAM_API_BASE', 'http://video.bunnycdn.com'],
		['FLUXER_BUNNY_STREAM_API_BASE', 'https://user:secret@video.bunnycdn.com'],
		['FLUXER_BUNNY_STREAM_TUS_ENDPOINT', 'http://video.bunnycdn.com/tusupload'],
	])('refuses an http api base: %s=%s', async (envName, value) => {
		stubMinimalEnv({...BUNNY_STREAM_ENV, [envName]: value});
		await expect(loadConfig()).rejects.toThrow(`${envName} must be an https URL without credentials`);
	});

	test.each(['VZ-Zone', 'zone_1', 'zone/1', 'zone 1'])(
		'refuses a storage zone name outside [a-z0-9-]: %s',
		async (zone) => {
			stubMinimalEnv({...BUNNY_STREAM_ENV, FLUXER_BUNNY_STREAM_STORAGE_ZONE: zone});
			await expect(loadConfig()).rejects.toThrow('FLUXER_BUNNY_STREAM_STORAGE_ZONE must be lowercase letters');
		},
	);

	test.each([
		['FLUXER_BUNNY_STREAM_CDN_HOSTNAME', 'https://vz-example.b-cdn.net'],
		['FLUXER_BUNNY_STREAM_STORAGE_HOST', 'storage.bunnycdn.com/zone'],
	])('refuses a Bunny Stream host with a scheme or path: %s', async (envName, value) => {
		stubMinimalEnv({...BUNNY_STREAM_ENV, [envName]: value});
		await expect(loadConfig()).rejects.toThrow(`${envName} must be a hostname`);
	});

	test.each([
		'FLUXER_BUNNY_STREAM_API_KEY',
		'FLUXER_BUNNY_STREAM_READ_ONLY_API_KEY',
		'FLUXER_BUNNY_STREAM_TOKEN_KEY',
		'FLUXER_BUNNY_STREAM_STORAGE_PASSWORD',
	])('refuses %s with invisible characters without echoing it', async (envName) => {
		stubMinimalEnv({...BUNNY_STREAM_ENV, [envName]: 'secret with space'});
		const error: unknown = await loadConfig().catch((caught: unknown) => caught);
		expect((error as Error).message).toBe(`${envName} must contain only visible ASCII characters`);
	});

	test.each([
		['FLUXER_BUNNY_STREAM_LIBRARY_ID', '-1'],
		['FLUXER_BUNNY_STREAM_TIMEOUT_MS', '999'],
		['FLUXER_BUNNY_STREAM_TIMEOUT_MS', '30001'],
	])('refuses %s=%s', async (envName, value) => {
		stubMinimalEnv({...BUNNY_STREAM_ENV, [envName]: value});
		await expect(loadConfig()).rejects.toThrow(envName);
	});

	test('rejects a missing upload relay secret', async () => {
		stubMinimalEnv();
		vi.stubEnv('FLUXER_MEDIA_PROXY_UPLOAD_RELAY_SECRET_BASE64', '');

		await expect(loadConfig()).rejects.toThrow('FLUXER_MEDIA_PROXY_UPLOAD_RELAY_SECRET_BASE64 is required');
	});

	test('rejects a non-base64 upload relay secret', async () => {
		stubMinimalEnv({FLUXER_MEDIA_PROXY_UPLOAD_RELAY_SECRET_BASE64: 'not base64!'});
		await expect(loadConfig()).rejects.toThrow('FLUXER_MEDIA_PROXY_UPLOAD_RELAY_SECRET_BASE64 must be base64');
	});

	test('rejects an upload relay secret shorter than 32 bytes', async () => {
		stubMinimalEnv({FLUXER_MEDIA_PROXY_UPLOAD_RELAY_SECRET_BASE64: Buffer.alloc(16, 7).toString('base64')});
		await expect(loadConfig()).rejects.toThrow(
			'FLUXER_MEDIA_PROXY_UPLOAD_RELAY_SECRET_BASE64 must decode to at least 32 bytes',
		);
	});

	test('rejects a VAPID public key that is not a 65-byte uncompressed point', async () => {
		const {privateKey} = generateVapidPair();
		stubMinimalEnv({
			FLUXER_VAPID_PUBLIC_KEY: Buffer.alloc(64, 4).toString('base64url'),
			FLUXER_VAPID_PRIVATE_KEY: privateKey,
		});
		await expect(loadConfig()).rejects.toThrow(
			/^FLUXER_VAPID_PUBLIC_KEY must be the base64url 65-byte uncompressed P-256 point\. Run rexctl doctor --fix/u,
		);
	});

	test('rejects a VAPID private key that is not a 32-byte scalar', async () => {
		const {publicKey} = generateVapidPair();
		stubMinimalEnv({
			FLUXER_VAPID_PUBLIC_KEY: publicKey,
			FLUXER_VAPID_PRIVATE_KEY: Buffer.alloc(31, 9).toString('base64url'),
		});
		await expect(loadConfig()).rejects.toThrow(
			/^FLUXER_VAPID_PRIVATE_KEY must be the base64url 32-byte P-256 scalar\. Run rexctl doctor --fix/u,
		);
	});

	test('rejects a well formed VAPID scalar that does not derive the public point', async () => {
		const {publicKey} = generateVapidPair();
		const other = generateVapidPair();
		stubMinimalEnv({
			FLUXER_VAPID_PUBLIC_KEY: publicKey,
			FLUXER_VAPID_PRIVATE_KEY: other.privateKey,
		});
		await expect(loadConfig()).rejects.toThrow('FLUXER_VAPID_PRIVATE_KEY does not match FLUXER_VAPID_PUBLIC_KEY');
	});

	test('accepts a generated VAPID pair', async () => {
		const pair = generateVapidPair();
		stubMinimalEnv({
			FLUXER_VAPID_PUBLIC_KEY: pair.publicKey,
			FLUXER_VAPID_PRIVATE_KEY: pair.privateKey,
		});

		const config = await loadConfig();

		expect(config.auth.vapid.public_key).toBe(pair.publicKey);
		expect(config.auth.vapid.private_key).toBe(pair.privateKey);
	});

	test('inserts the public port into every other public url the config contains', async () => {
		stubMinimalEnv({
			FLUXER_S3_PUBLIC_ENDPOINT: 'http://localhost/s3',
			FLUXER_EMAIL_APP_BASE_URL: 'http://localhost',
			FLUXER_AUTH_BLUESKY_CLIENT_URI: 'http://localhost',
			FLUXER_AUTH_BLUESKY_TOS_URI: 'http://localhost/terms',
			FLUXER_APP_ICON_URL: 'http://localhost/icon.png',
			FLUXER_LIVEKIT_INTERNAL_URL: 'http://livekit:7880',
		});

		const config = await loadConfig();

		expect(config.s3?.presigned_url_base).toBe('http://localhost:8088/s3');
		expect(config.integrations.email.app_base_url).toBe('http://localhost:8088');
		expect(config.auth.bluesky.client_uri).toBe('http://localhost:8088');
		expect(config.auth.bluesky.tos_uri).toBe('http://localhost:8088/terms');
		expect(config.instance.branding.icon_url).toBe('http://localhost:8088/icon.png');
		expect(config.integrations.voice.internal_url).toBe('http://livekit:7880');
	});
});

describe('FLUXER_PUBLIC_ORIGIN', () => {
	beforeEach(() => {
		resetConfig();
		clearFluxerEnv();
	});

	afterEach(() => {
		resetConfig();
		vi.unstubAllEnvs();
	});

	test('a ported origin ports every derived endpoint and every compose override', async () => {
		stubMinimalEnv({
			FLUXER_BASE_DOMAIN: 'chat.example.com',
			FLUXER_PUBLIC_SCHEME: 'https',
			FLUXER_PUBLIC_PORT: '',
			FLUXER_PUBLIC_ORIGIN: 'https://chat.example.com:29080',
			FLUXER_MARKETING_ENDPOINT: 'https://chat.example.com:29080',
			FLUXER_MEDIA_ENDPOINT: 'https://chat.example.com:29080/media',
			FLUXER_MEDIA_PROXY_UPLOAD_RELAY_ENDPOINT: 'https://chat.example.com:29080/media',
			FLUXER_LIVEKIT_URL: 'https://chat.example.com:29080/livekit',
			FLUXER_PASSKEY_ADDITIONAL_ALLOWED_ORIGINS: 'https://chat.example.com:29080',
		});

		const config = await loadConfig();

		expect(config.domain.public_port).toBe(29080);
		expect(config.domain.public_origin).toBe('https://chat.example.com:29080');
		expect(config.endpoints.api_client).toBe('https://chat.example.com:29080/api');
		expect(config.endpoints.app).toBe('https://chat.example.com:29080');
		expect(config.endpoints.gateway).toBe('wss://chat.example.com:29080/gateway');
		expect(config.endpoints.admin).toBe('https://chat.example.com:29080/admin');
		expect(config.endpoints.marketing).toBe('https://chat.example.com:29080');
		expect(config.endpoints.media).toBe('https://chat.example.com:29080/media');
		expect(config.services.media_proxy.upload_relay.endpoint).toBe('https://chat.example.com:29080/media');
		expect(config.integrations.voice.url).toBe('https://chat.example.com:29080/livekit');
		expect(config.auth.passkeys.additional_allowed_origins).toEqual([
			'https://chat.example.com:29080',
			'android:apk-key-hash:keSY4bimyLqZQV7bKXgpa2xYuqXi0qZJzsYtp6gpx7w',
			'android:apk-key-hash:Ld4qnT0TfBeHMT3Yu2H0WTwqlxgFs-32uDmwqtLndsk',
		]);
	});

	test('the origin port wins over a FLUXER_PUBLIC_PORT that disagrees', async () => {
		stubMinimalEnv({
			FLUXER_BASE_DOMAIN: 'chat.example.com',
			FLUXER_PUBLIC_SCHEME: 'https',
			FLUXER_PUBLIC_PORT: '443',
			FLUXER_PUBLIC_ORIGIN: 'https://chat.example.com:29080',
		});

		const config = await loadConfig();

		expect(config.domain.public_port).toBe(29080);
		expect(config.endpoints.app).toBe('https://chat.example.com:29080');
		expect(config.endpoints.api_client).toBe('https://chat.example.com:29080/api');
		expect(config.endpoints.gateway).toBe('wss://chat.example.com:29080/gateway');
		expect(config.endpoints.admin).toBe('https://chat.example.com:29080/admin');
	});

	test('accepts an origin whose port matches FLUXER_PUBLIC_PORT', async () => {
		stubMinimalEnv({
			FLUXER_BASE_DOMAIN: 'chat.example.com',
			FLUXER_PUBLIC_SCHEME: 'https',
			FLUXER_PUBLIC_PORT: '29080',
			FLUXER_PUBLIC_ORIGIN: 'https://chat.example.com:29080',
		});

		expect((await loadConfig()).endpoints.gateway).toBe('wss://chat.example.com:29080/gateway');
	});

	test('normalizes an origin written with an explicit default port', async () => {
		stubMinimalEnv({
			FLUXER_BASE_DOMAIN: 'chat.example.com',
			FLUXER_PUBLIC_SCHEME: 'https',
			FLUXER_PUBLIC_PORT: '443',
			FLUXER_PUBLIC_ORIGIN: 'https://chat.example.com:443',
			FLUXER_ADMIN_ENDPOINT: 'https://chat.example.com/admin',
		});

		const config = await loadConfig();

		expect(config.domain.public_port).toBe(443);
		expect(config.domain.public_origin).toBe('https://chat.example.com');
		expect(config.endpoints.admin).toBe('https://chat.example.com/admin');
		expect(config.endpoints.app).toBe('https://chat.example.com');
		expect(config.endpoints.gateway).toBe('wss://chat.example.com/gateway');
	});

	test('takes the scheme and the domain from the origin when neither is set', async () => {
		stubMinimalEnv({
			FLUXER_BASE_DOMAIN: '',
			FLUXER_PUBLIC_SCHEME: '',
			FLUXER_PUBLIC_PORT: '',
			FLUXER_PUBLIC_ORIGIN: 'https://chat.example.com:29080',
		});

		const config = await loadConfig();

		expect(config.domain.base_domain).toBe('chat.example.com');
		expect(config.domain.public_scheme).toBe('https');
		expect(config.domain.public_port).toBe(29080);
	});

	test('the origin scheme wins over a FLUXER_PUBLIC_SCHEME that disagrees', async () => {
		stubMinimalEnv({
			FLUXER_BASE_DOMAIN: 'chat.example.com',
			FLUXER_PUBLIC_SCHEME: 'http',
			FLUXER_PUBLIC_PORT: '',
			FLUXER_PUBLIC_ORIGIN: 'https://chat.example.com',
		});

		const config = await loadConfig();

		expect(config.domain.public_scheme).toBe('https');
		expect(config.endpoints.app).toBe('https://chat.example.com');
		expect(config.endpoints.gateway).toBe('wss://chat.example.com/gateway');
	});

	test('the origin host wins over a FLUXER_BASE_DOMAIN that disagrees', async () => {
		stubMinimalEnv({
			FLUXER_BASE_DOMAIN: 'chat.example.com',
			FLUXER_PUBLIC_SCHEME: 'https',
			FLUXER_PUBLIC_PORT: '',
			FLUXER_PUBLIC_ORIGIN: 'https://other.example.com',
		});

		const config = await loadConfig();

		expect(config.domain.base_domain).toBe('other.example.com');
		expect(config.endpoints.app).toBe('https://other.example.com');
	});

	test('refuses to boot on an origin that is not a bare origin', async () => {
		stubMinimalEnv({FLUXER_PUBLIC_ORIGIN: 'https://chat.example.com/app'});
		await expect(loadConfig()).rejects.toThrow(
			'FLUXER_PUBLIC_ORIGIN must be a scheme, host and optional port such as https://chat.example.com:8443',
		);
	});

	test('leaves the derived origin canonical when nothing is set', async () => {
		stubMinimalEnv();
		expect((await loadConfig()).domain.public_origin).toBe('http://localhost:8088');
	});
});

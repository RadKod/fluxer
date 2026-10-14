// SPDX-License-Identifier: AGPL-3.0-or-later

import type {SsoService} from '@app/api/auth/services/SsoService';
import {createApplicationID, createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {MICUPBOT_BOT_INVITE_PERMISSIONS} from '@app/api/guild/micupbot/MicupBotConstants';
import {ROSTER_BOT_INVITE_PERMISSIONS} from '@app/api/guild/roster/GuildRosterConstants';
import {INSTANCE_CONFIG_REFRESH_CHANNEL, InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {InstanceController} from '@app/api/instance/InstanceController';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {ApplicationRepository} from '@app/api/oauth/repositories/ApplicationRepository';
import {PremiumTrialService} from '@app/api/premium/trial/PremiumTrialService';
import {Applications} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {DEFAULT_DOMAIN_MIGRATION_CONFIG} from '@fluxer/schema/src/domains/admin/DomainMigrationSchemas';
import {Hono} from 'hono';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface DiscoveryCaptcha {
	provider: string;
}

describe('InstanceController discovery captcha', () => {
	const repositories: Array<InstanceConfigRepository> = [];
	let provider: MockKVProvider;
	let executor: InMemoryCassandraQueryExecutor;

	afterEach(() => {
		for (const repository of repositories) {
			repository.shutdown();
		}
		repositories.length = 0;
		vi.useRealTimers();
	});

	function createRepository(): InstanceConfigRepository {
		executor = new InMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		provider = new MockKVProvider();
		for (const id of ['123456789012345678', '223456789012345678', '323456789012345678', '423456789012345678']) {
			void executor.executeQuery(
				Applications.upsertAll({
					application_id: createApplicationID(BigInt(id)),
					owner_user_id: createUserID(1n),
					name: 'Official test bot',
					bot_user_id: createUserID(BigInt(id)),
					bot_is_public: true,
					bot_require_code_grant: false,
					oauth2_redirect_uris: new Set(),
					client_secret_hash: null,
					bot_token_hash: null,
					bot_token_preview: null,
					bot_token_created_at: null,
					client_secret_created_at: null,
					version: 1,
				}),
			);
		}
		const repository = new InstanceConfigRepository(provider);
		repositories.push(repository);
		return repository;
	}

	function createApp(repository: InstanceConfigRepository): Hono<HonoEnv> {
		const app = new Hono<HonoEnv>({strict: true});
		app.use('*', async (ctx, next) => {
			ctx.set('instanceConfigRepository', repository);
			ctx.set('limitConfigService', {
				getConfigWireFormat: () => ({version: 2, traitDefinitions: [], rules: [], defaultsHash: 'test'}),
			} as unknown as LimitConfigService);
			ctx.set('ssoService', {
				getPublicStatus: async () => ({
					enabled: false,
					enforced: false,
					display_name: null,
					redirect_uri: '',
				}),
			} as unknown as SsoService);
			ctx.set(
				'premiumTrialService',
				new PremiumTrialService({instanceConfigRepository: repository} as unknown as ConstructorParameters<
					typeof PremiumTrialService
				>[0]),
			);
			await next();
		});
		InstanceController(app);
		return app;
	}

	async function readCaptcha(repository: InstanceConfigRepository): Promise<DiscoveryCaptcha> {
		const response = await createApp(repository).request('http://localhost/.well-known/fluxer');
		expect(response.status).toBe(200);
		return ((await response.json()) as {captcha: DiscoveryCaptcha}).captcha;
	}

	describe('official apps', () => {
		let previous: {micupBotApplicationId?: string; rosterBotApplicationId?: string};
		beforeEach(() => {
			previous = {
				micupBotApplicationId: Config.instance.micupBotApplicationId,
				rosterBotApplicationId: Config.instance.rosterBotApplicationId,
			};
			overrideLimits({feature_micupbot: 1, feature_guild_roster: 1});
		});
		afterEach(() => {
			Object.assign(Config.instance, previous);
			vi.restoreAllMocks();
		});
		async function readApps(repository = createRepository()) {
			const response = await createApp(repository).request('http://localhost/.well-known/fluxer');
			expect(response.status).toBe(200);
			return ((await response.json()) as {features: {official_apps: unknown}}).features.official_apps;
		}
		it('omits missing, private, non-bot and deleted candidates from a warmed discovery cache', async () => {
			vi.useFakeTimers();
			Config.instance.micupBotApplicationId = undefined;
			Config.instance.rosterBotApplicationId = undefined;
			const repository = createRepository();
			const applications = new ApplicationRepository(provider);
			const ids = ['123456789012345678', '223456789012345678', '323456789012345678', '523456789012345678'];
			await repository.setInstancePolicyConfig({
				official_apps: ids.map((application_id) => ({application_id, invite_permissions: '0'})),
			});
			await readApps(repository);
			for (const [index, changes] of [
				[0, {bot_is_public: false}],
				[1, {bot_user_id: null}],
			] as const) {
				const application = (await applications.getApplication(createApplicationID(BigInt(ids[index]!))))!;
				const write = applications.upsertApplication({...application.toRow(), ...changes}, application.toRow());
				await vi.advanceTimersByTimeAsync(35100);
				await write;
			}
			const deletion = applications.deleteApplication(createApplicationID(BigInt(ids[2]!)));
			await vi.advanceTimersByTimeAsync(35100);
			await deletion;
			await vi.waitFor(async () => expect(await readApps(repository)).toEqual([]));
		});
		it('does not query applications for repeated or conditional discovery requests', async () => {
			const repository = createRepository();
			await repository.setInstancePolicyConfig({
				official_apps: [{application_id: '323456789012345678', invite_permissions: '0'}],
			});
			const app = createApp(repository);
			const first = await app.request('http://localhost/.well-known/fluxer');
			const queries = vi.spyOn(executor, 'executeQuery');
			await app.request('http://localhost/.well-known/fluxer');
			const conditional = await app.request('http://localhost/.well-known/fluxer', {
				headers: {'If-None-Match': first.headers.get('ETag')!},
			});
			expect(conditional.status).toBe(304);
			expect(queries.mock.calls.filter(([query]) => /FROM applications\b/i.test(query.cql))).toEqual([]);
		});
		it('does not refresh the instance config snapshot for unrelated application writes', async () => {
			const repository = createRepository();
			await readApps(repository);
			const queries = vi.spyOn(executor, 'executeQuery');
			await provider.publish(
				INSTANCE_CONFIG_REFRESH_CHANNEL,
				JSON.stringify({type: 'application_refresh', application_id: '523456789012345678', mutation_id: 'other'}),
			);
			await new Promise((resolve) => setImmediate(resolve));
			expect(queries).not.toHaveBeenCalled();
		});
		it('rechecks the lease after other asynchronous discovery work completes', async () => {
			let time = 0;
			vi.spyOn(performance, 'now').mockImplementation(() => time);
			const repository = createRepository();
			await repository.setInstancePolicyConfig({
				official_apps: [{application_id: '323456789012345678', invite_permissions: '0'}],
			});
			expect(await readApps(repository)).not.toEqual([]);
			const getPublic = repository.getAppPublicConfig.bind(repository);
			vi.spyOn(repository, 'getAppPublicConfig').mockImplementation(async () => {
				const result = await getPublic();
				time = 35000;
				return result;
			});
			expect(await readApps(repository)).toEqual([]);
		});
		it('fails closed on subscriber errors and never falls back to application reads per request', async () => {
			const repository = createRepository();
			await repository.setInstancePolicyConfig({
				official_apps: [{application_id: '323456789012345678', invite_permissions: '0'}],
			});
			expect(await readApps(repository)).not.toEqual([]);
			(provider.duplicate() as unknown as {simulateError(error: Error): void}).simulateError(new Error('disconnected'));
			const queries = vi.spyOn(executor, 'executeQuery');
			expect(await readApps(repository)).toEqual([]);
			expect(await readApps(repository)).toEqual([]);
			expect(queries.mock.calls.filter(([query]) => /FROM applications\b/i.test(query.cql))).toEqual([]);
		});
		it('refreshes another process after policy changes and application writes', async () => {
			vi.useFakeTimers();
			const first = createRepository();
			const second = new InstanceConfigRepository(provider);
			repositories.push(second);
			await readApps(second);
			const entry = {application_id: '323456789012345678', invite_permissions: '0'};
			await first.setInstancePolicyConfig({official_apps: [entry]});
			await vi.waitFor(async () => expect(await readApps(second)).toContainEqual(entry));
			const applications = new ApplicationRepository(provider);
			const application = (await applications.getApplication(createApplicationID(BigInt(entry.application_id))))!;
			const write = applications.upsertApplication({...application.toRow(), bot_is_public: false}, application.toRow());
			await vi.advanceTimersByTimeAsync(35100);
			await write;
			await vi.waitFor(async () => expect(await readApps(second)).not.toContainEqual(entry));
			expect(provider.publishSpy).toHaveBeenCalledWith(INSTANCE_CONFIG_REFRESH_CHANNEL, expect.any(String));
		});
		it('appends policy apps in order and keeps the first permissions when fixed apps collide', async () => {
			Config.instance.micupBotApplicationId = '123456789012345678';
			Config.instance.rosterBotApplicationId = '123456789012345678';
			const repository = createRepository();
			const official_apps = [
				{application_id: '323456789012345678', invite_permissions: '0'},
				{application_id: '123456789012345678', invite_permissions: '0'},
				{application_id: '423456789012345678', invite_permissions: '1024'},
			];
			await repository.setInstancePolicyConfig({official_apps});
			expect(await readApps(repository)).toEqual([
				{application_id: '123456789012345678', invite_permissions: MICUPBOT_BOT_INVITE_PERMISSIONS.toString()},
				official_apps[0],
				official_apps[2],
			]);
		});
		it('keeps policy apps while both fixed bot feature flags are disabled', async () => {
			Config.instance.micupBotApplicationId = '123456789012345678';
			Config.instance.rosterBotApplicationId = '223456789012345678';
			overrideLimits({feature_micupbot: 0, feature_guild_roster: 0});
			const repository = createRepository();
			const official_apps = [{application_id: '123456789012345678', invite_permissions: '0'}];
			await repository.setInstancePolicyConfig({official_apps});
			expect(await readApps(repository)).toEqual(official_apps);
		});
		it('well-known lists the configured official apps in order MicupBOT, Roster with their invite permissions', async () => {
			Config.instance.micupBotApplicationId = '123456789012345678';
			Config.instance.rosterBotApplicationId = '223456789012345678';
			expect(await readApps()).toEqual([
				{application_id: '123456789012345678', invite_permissions: MICUPBOT_BOT_INVITE_PERMISSIONS.toString()},
				{application_id: '223456789012345678', invite_permissions: ROSTER_BOT_INVITE_PERMISSIONS.toString()},
			]);
		});
		it('an unconfigured app is left out', async () => {
			Config.instance.micupBotApplicationId = undefined;
			Config.instance.rosterBotApplicationId = '223456789012345678';
			expect(await readApps()).toEqual([
				{application_id: '223456789012345678', invite_permissions: ROSTER_BOT_INVITE_PERMISSIONS.toString()},
			]);
			Config.instance.rosterBotApplicationId = undefined;
			expect(await readApps()).toEqual([]);
		});
		it.each([
			[0, 0],
			[0, 1],
			[1, 0],
		])('only lists live official apps with MicupBOT=%s and Roster=%s', async (micupbot, roster) => {
			Config.instance.micupBotApplicationId = '123456789012345678';
			Config.instance.rosterBotApplicationId = '223456789012345678';
			overrideLimits({feature_micupbot: micupbot, feature_guild_roster: roster});
			expect(await readApps()).toEqual([
				...(micupbot
					? [{application_id: '123456789012345678', invite_permissions: MICUPBOT_BOT_INVITE_PERMISSIONS.toString()}]
					: []),
				...(roster
					? [{application_id: '223456789012345678', invite_permissions: ROSTER_BOT_INVITE_PERMISSIONS.toString()}]
					: []),
			]);
		});
	});

	it('advertises altcha by default', async () => {
		await expect(readCaptcha(createRepository())).resolves.toEqual({provider: 'altcha'});
	});

	it('advertises no provider once an admin turns the captcha off', async () => {
		const repository = createRepository();
		await repository.updateCaptchaConfig({enabled: false});

		await expect(readCaptcha(repository)).resolves.toEqual({provider: 'none'});
	});

	it('publishes the domain migration kill switch and anonymous rollout without the targeting lists', async () => {
		const repository = createRepository();
		const app = createApp(repository);

		const initial = await app.request('http://localhost/.well-known/fluxer');
		expect(((await initial.json()) as {domain_migration: unknown}).domain_migration).toEqual({
			enabled: false,
			anonymous_rollout_basis_points: 0,
			rollout_salt: 'domain-migration-v1',
			standalone_forwarding: false,
		});

		await repository.setDomainMigrationConfig({
			...DEFAULT_DOMAIN_MIGRATION_CONFIG,
			enabled: true,
			config_version: 2,
			rollout_basis_points: 100,
			anonymous_rollout_basis_points: 1500,
			included_user_ids: ['1400000000000000001'],
			standalone_forwarding: true,
		});

		const updated = await app.request('http://localhost/.well-known/fluxer');
		expect(updated.headers.get('etag')).not.toBe(initial.headers.get('etag'));
		expect(((await updated.json()) as {domain_migration: unknown}).domain_migration).toEqual({
			enabled: true,
			anonymous_rollout_basis_points: 1500,
			rollout_salt: 'domain-migration-v1',
			standalone_forwarding: true,
		});
	});

	describe('sanalyer premium features', () => {
		let previous: {selfHosted: boolean; key: string};

		beforeEach(() => {
			previous = {selfHosted: Config.instance.selfHosted, key: Config.premiumTrial.emailHashKey};
		});
		afterEach(() => {
			Config.instance.selfHosted = previous.selfHosted;
			Config.premiumTrial.emailHashKey = previous.key;
		});

		async function readFeatures(repository: InstanceConfigRepository): Promise<Record<string, unknown>> {
			const response = await createApp(repository).request('http://localhost/.well-known/fluxer');
			expect(response.status).toBe(200);
			return ((await response.json()) as {features: Record<string, unknown>}).features;
		}

		async function createMirrorRepository(premiumTrialDays: number): Promise<InstanceConfigRepository> {
			const repository = createRepository();
			await repository.setInstancePolicyConfig({premium_mode: 'mirror', premium_trial_days: premiumTrialDays});
			await repository.updateCaptchaConfig({enabled: true});
			return repository;
		}

		it('advertises the trial length the trial service would grant and opens gift codes in mirror mode', async () => {
			Config.instance.selfHosted = true;
			Config.premiumTrial.emailHashKey = 'discovery-test-hash-key';

			const features = await readFeatures(await createMirrorRepository(7));
			expect([features.premium_trial_days, features.gift_codes_enabled]).toEqual([7, true]);
		});

		it('advertises no trial while the trial email hash key is missing', async () => {
			Config.instance.selfHosted = true;
			Config.premiumTrial.emailHashKey = '';

			const features = await readFeatures(await createMirrorRepository(7));
			expect([features.premium_trial_days, features.gift_codes_enabled]).toEqual([0, true]);
		});

		it('closes gift codes and the trial on a self-hosted instance that gives premium to everyone', async () => {
			Config.instance.selfHosted = true;
			Config.premiumTrial.emailHashKey = 'discovery-test-hash-key';
			const repository = createRepository();
			await repository.setInstancePolicyConfig({premium_mode: 'everyone', premium_trial_days: 7});

			const features = await readFeatures(repository);
			expect([features.premium_trial_days, features.gift_codes_enabled]).toEqual([0, false]);
		});

		it('keeps gift codes open on a hosted instance', async () => {
			Config.instance.selfHosted = false;

			const features = await readFeatures(createRepository());
			expect([features.premium_trial_days, features.gift_codes_enabled]).toEqual([0, true]);
		});
	});
});

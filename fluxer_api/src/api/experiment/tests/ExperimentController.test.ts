// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs} from '@app/api/auth/tests/AuthTestUtils';
import {acceptInvite, createChannelInvite, createGuild, getChannel} from '@app/api/guild/tests/GuildTestUtils';
import {getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder, createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {grantPremium} from '@app/api/user/tests/UserTestUtils';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {VOICE_ROOM_THEME_IDS} from '@fluxer/constants/src/VoiceRoomThemes';
import {
	DEFAULT_DOMAIN_MIGRATION_CONFIG,
	INERT_DOMAIN_MIGRATION_ASSIGNMENT,
} from '@fluxer/schema/src/domains/admin/DomainMigrationSchemas';
import {
	DEFAULT_VOICE_NOISE_SUPPRESSION_CONFIG,
	INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT,
	type VoiceNoiseSuppressionConfigResponse,
} from '@fluxer/schema/src/domains/admin/VoiceNoiseSuppressionSchemas';
import {DEFAULT_VOICE_P2P_CONFIG, INERT_VOICE_P2P_ASSIGNMENT} from '@fluxer/schema/src/domains/admin/VoiceP2pSchemas';
import {
	INERT_VOICE_ROOM_ASSIGNMENT,
	type VoiceRoomConfigResponse,
} from '@fluxer/schema/src/domains/admin/VoiceRoomConfigSchemas';
import {
	DEFAULT_EXPERIMENT_POLL_INTERVAL_SECONDS,
	DEFAULT_EXPERIMENT_POLL_JITTER_PERCENT,
	type ExperimentAssignmentsResponse,
	type ExperimentDeliveryConfigResponse,
	readVoiceNoiseSuppressionAssignment,
	readVoiceRoomAssignment,
} from '@fluxer/schema/src/domains/experiment/ExperimentSchemas';
import type {GeoipResult} from '@pkgs/geoip/src/GeoipLookup';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const {lookupGeoipMock} = vi.hoisted(() => ({
	lookupGeoipMock: vi.fn(),
}));

vi.mock('@app/api/utils/IpUtils', async (importOriginal) => ({
	...(await importOriginal<typeof import('@app/api/utils/IpUtils')>()),
	lookupGeoip: lookupGeoipMock,
}));

function geoipCountry(countryCode: string | null): GeoipResult {
	return {
		countryCode,
		normalizedIp: '203.0.113.10',
		city: null,
		region: null,
		countryName: null,
	};
}

const NOT_MODIFIED = 304;
const ENDPOINT = '/experiments';

describe('GET /experiments', () => {
	let harness: ApiTestHarness;

	it('publishes the inert noise suppression assignment for authenticated users', async () => {
		const account = await createTestAccount(harness);
		const response = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token).get(ENDPOINT).execute();
		expect(response.assignments.voice_noise_suppression).toMatchObject({enabled: false, suppression_strength: 80});
	});

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		lookupGeoipMock.mockReset();
		lookupGeoipMock.mockResolvedValue(geoipCountry(null));
	});

	afterAll(async () => {
		await harness.shutdown();
	});

	it('rejects an unauthenticated caller', async () => {
		await createBuilderWithoutAuth(harness).get(ENDPOINT).expect(HTTP_STATUS.UNAUTHORIZED).execute();
	});

	it('carries pipeline switches and guild scope from admin PATCH and disables only the pipeline on rollback', async () => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
		]);
		const excluded = await createTestAccount(harness);
		const guildOverrides = [{guild_id: '2000000000000000001', backend: 'deep_filter', pipeline_v2: true}];
		const patch = (voice: Record<string, unknown>) =>
			createBuilder<{voice_noise_suppression: VoiceNoiseSuppressionConfigResponse}>(harness, admin.token)
				.patch('/admin/instance/config')
				.body({voice_noise_suppression: voice})
				.execute();
		const configured = await patch({
			enabled: true,
			pipeline_v2_enabled: true,
			pipeline_v2_all: true,
			default_backend: 'deep_filter',
			rollout_basis_points: 10000,
			excluded_user_ids: [excluded.userId],
			guild_overrides: guildOverrides,
		});
		expect(configured.voice_noise_suppression).toMatchObject({
			pipeline_v2_enabled: true,
			pipeline_v2_all: true,
			guild_overrides: guildOverrides,
		});
		const get = (token: string) =>
			createBuilder<ExperimentAssignmentsResponse>(harness, token).get(ENDPOINT).executeWithResponse();
		const assigned = await get(admin.token);
		expect(assigned.json?.assignments.voice_noise_suppression).toMatchObject({
			pipeline_v2_enabled: true,
			pipeline_v2_all: true,
			guild_overrides: guildOverrides,
		});
		expect((await get(excluded.token)).json?.assignments.voice_noise_suppression).toMatchObject({
			pipeline_v2_enabled: false,
			pipeline_v2_all: false,
			guild_overrides: [],
		});
		const rollback = await patch({pipeline_v2_enabled: false});
		expect(rollback.voice_noise_suppression).toEqual({
			...configured.voice_noise_suppression,
			pipeline_v2_enabled: false,
			config_version: configured.voice_noise_suppression.config_version + 1,
		});
		const refreshed = await createBuilder<ExperimentAssignmentsResponse>(harness, admin.token)
			.get(ENDPOINT)
			.header('If-None-Match', assigned.response.headers.get('etag') as string)
			.executeWithResponse();
		expect(refreshed.response.status).toBe(HTTP_STATUS.OK);
		expect(refreshed.response.headers.get('etag')).not.toBe(assigned.response.headers.get('etag'));
		expect(refreshed.json?.assignments.voice_noise_suppression).toMatchObject({
			pipeline_v2_enabled: false,
			pipeline_v2_all: true,
		});
	});

	it('carries pipeline tuning from admin PATCH into assignments and refreshes them on change', async () => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
		]);
		const tuning = {
			pipeline_v2_gate_open_probability: 0.8,
			pipeline_v2_gate_refresh_probability: 0.2,
			pipeline_v2_gate_hangover_ms: 900,
			pipeline_v2_gain_target_dbfs: -30,
			pipeline_v2_gain_max_db: 12,
		};
		const patch = (voice: Record<string, unknown>) =>
			createBuilder<{voice_noise_suppression: VoiceNoiseSuppressionConfigResponse}>(harness, admin.token)
				.patch('/admin/instance/config')
				.body({voice_noise_suppression: voice})
				.execute();
		const configured = await patch({enabled: true, pipeline_v2_enabled: true, pipeline_v2_all: true, ...tuning});
		expect(configured.voice_noise_suppression).toMatchObject(tuning);
		const assigned = await createBuilder<ExperimentAssignmentsResponse>(harness, admin.token)
			.get(ENDPOINT)
			.executeWithResponse();
		expect(assigned.json?.assignments.voice_noise_suppression).toMatchObject(tuning);
		const updated = await patch({pipeline_v2_gate_hangover_ms: 1500});
		expect(updated.voice_noise_suppression).toEqual({
			...configured.voice_noise_suppression,
			pipeline_v2_gate_hangover_ms: 1500,
			config_version: configured.voice_noise_suppression.config_version + 1,
		});
		const refreshed = await createBuilder<ExperimentAssignmentsResponse>(harness, admin.token)
			.get(ENDPOINT)
			.header('If-None-Match', assigned.response.headers.get('etag') as string)
			.executeWithResponse();
		expect(refreshed.response.status).toBe(HTTP_STATUS.OK);
		expect(refreshed.json?.assignments.voice_noise_suppression).toMatchObject({
			...tuning,
			pipeline_v2_gate_hangover_ms: 1500,
			config_version: updated.voice_noise_suppression.config_version,
		});
	});

	it.each([
		{pipeline_v2_enabled: 'true'},
		{pipeline_v2_all: 1},
		{guild_overrides: [{guild_id: '2000000000000000001', backend: 'deep_filter', pipeline_v2: 'true'}]},
		{pipeline_v2_gate_open_probability: 0.96},
		{pipeline_v2_gate_refresh_probability: 0.09},
		{pipeline_v2_gate_hangover_ms: 1501},
		{pipeline_v2_gate_hangover_ms: 400.5},
		{pipeline_v2_gain_target_dbfs: -13},
		{pipeline_v2_gain_max_db: 31},
	])('rejects invalid pipeline PATCH values: %j', async (patch) => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
		]);
		await createBuilder(harness, admin.token)
			.patch('/admin/instance/config')
			.body({voice_noise_suppression: patch})
			.expect(HTTP_STATUS.BAD_REQUEST)
			.execute();
	});

	it('returns the default delivery cadence and the default assignments', async () => {
		const account = await createTestAccount(harness);

		const body = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token).get(ENDPOINT).execute();

		expect(body).toEqual({
			poll_interval_seconds: DEFAULT_EXPERIMENT_POLL_INTERVAL_SECONDS,
			poll_jitter_percent: DEFAULT_EXPERIMENT_POLL_JITTER_PERCENT,
			assignments: {
				voice_noise_suppression: INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT,
				voice_room: INERT_VOICE_ROOM_ASSIGNMENT,
				domain_migration: INERT_DOMAIN_MIGRATION_ASSIGNMENT,
				channel_threads: {active: true, config_version: 0},
				plutonium_page: {enabled: true},
				voice_p2p: INERT_VOICE_P2P_ASSIGNMENT,
			},
		});
	});

	it('voice_room assignment off by default', async () => {
		const account = await createTestAccount(harness);

		const body = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token).get(ENDPOINT).execute();

		expect(body.assignments.voice_room).toEqual({rooms: false, games: false, cameras: false, default_room_theme: null});
		expect(readVoiceRoomAssignment(body)).toEqual(INERT_VOICE_ROOM_ASSIGNMENT);
		expect(readVoiceRoomAssignment({...body, assignments: {}})).toEqual(INERT_VOICE_ROOM_ASSIGNMENT);
	});

	it('publishes operator strength and guild overrides after an authorized admin update', async () => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
		]);
		const settings = {
			enabled: true,
			rollout_basis_points: 10_000,
			default_backend: 'rnnoise',
			suppression_strength: 57,
			guild_overrides: [{guild_id: '123', backend: 'gate'}],
		};
		const updated = await createBuilder<{voice_noise_suppression: typeof settings}>(harness, admin.token)
			.patch('/admin/instance/config')
			.body({voice_noise_suppression: settings})
			.execute();
		expect(updated.voice_noise_suppression).toMatchObject(settings);
		const body = await createBuilder<ExperimentAssignmentsResponse>(harness, admin.token).get(ENDPOINT).execute();
		expect(body.assignments.voice_noise_suppression).toMatchObject({
			enabled: true,
			backend: 'rnnoise',
			suppression_strength: 57,
			guild_overrides: settings.guild_overrides,
			config_version: 1,
		});
	});

	it('games false while rooms off', async () => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
		]);

		const gamesOnly = await createBuilder<{voice_room: {rooms_enabled: boolean; games_enabled: boolean}}>(
			harness,
			admin.token,
		)
			.patch('/admin/instance/config')
			.body({voice_room: {games_enabled: true}})
			.execute();
		expect(gamesOnly.voice_room).toEqual({
			rooms_enabled: false,
			games_enabled: true,
			room_cameras_enabled: false,
			default_room_theme: null,
		});
		const offBody = await createBuilder<ExperimentAssignmentsResponse>(harness, admin.token).get(ENDPOINT).execute();
		expect(offBody.assignments.voice_room).toEqual({
			rooms: false,
			games: false,
			cameras: false,
			default_room_theme: null,
		});

		await createBuilder(harness, admin.token)
			.patch('/admin/instance/config')
			.body({voice_room: {rooms_enabled: true}})
			.execute();
		const onBody = await createBuilder<ExperimentAssignmentsResponse>(harness, admin.token).get(ENDPOINT).execute();
		expect(onBody.assignments.voice_room).toEqual({rooms: true, games: true, cameras: false, default_room_theme: null});
	});

	it('admin default theme patch persists and refreshes the assignment ETag', async () => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
		]);
		const first = await createBuilder<ExperimentAssignmentsResponse>(harness, admin.token)
			.get(ENDPOINT)
			.executeWithResponse();
		const oldTag = first.response.headers.get('etag')!;
		const patched = await createBuilder<{voice_room: VoiceRoomConfigResponse}>(harness, admin.token)
			.patch('/admin/instance/config')
			.body({voice_room: {default_room_theme: VOICE_ROOM_THEME_IDS[0]}})
			.execute();
		expect(patched.voice_room).toMatchObject({default_room_theme: VOICE_ROOM_THEME_IDS[0]});
		const refreshed = await createBuilder<ExperimentAssignmentsResponse>(harness, admin.token)
			.get(ENDPOINT)
			.header('If-None-Match', oldTag)
			.executeWithResponse();
		expect(refreshed.response.status).toBe(HTTP_STATUS.OK);
		expect(refreshed.response.headers.get('etag')).not.toBe(oldTag);
		expect(readVoiceRoomAssignment(refreshed.json!)).toMatchObject({default_room_theme: VOICE_ROOM_THEME_IDS[0]});
		const reset = await createBuilder<{voice_room: VoiceRoomConfigResponse}>(harness, admin.token)
			.patch('/admin/instance/config')
			.body({voice_room: {default_room_theme: null}})
			.execute();
		expect(reset.voice_room).toMatchObject({default_room_theme: null});
		const cleared = await createBuilder<ExperimentAssignmentsResponse>(harness, admin.token)
			.get(ENDPOINT)
			.header('If-None-Match', refreshed.response.headers.get('etag')!)
			.executeWithResponse();
		expect(cleared.response.status).toBe(HTTP_STATUS.OK);
		expect(cleared.response.headers.get('etag')).not.toBe(refreshed.response.headers.get('etag'));
		expect(readVoiceRoomAssignment(cleared.json!)).toMatchObject({default_room_theme: null});
	});

	it('ETag changes when the switch flips', async () => {
		const account = await createTestAccount(harness);
		const first = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token)
			.get(ENDPOINT)
			.executeWithResponse();
		const staleEtag = first.response.headers.get('etag') as string;

		await getInstanceConfigRepository().updateVoiceRoomConfig((current) => ({...current, rooms_enabled: true}));

		const refreshed = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token)
			.get(ENDPOINT)
			.header('If-None-Match', staleEtag)
			.executeWithResponse();
		expect(refreshed.response.status).toBe(HTTP_STATUS.OK);
		expect(refreshed.response.headers.get('etag')).not.toBe(staleEtag);
		expect(refreshed.json?.assignments.voice_room).toEqual({
			rooms: true,
			games: false,
			cameras: false,
			default_room_theme: null,
		});
	});

	it('cameras off by default; on only with rooms; ETag changes when it flips', async () => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
		]);
		const get = () => createBuilder<ExperimentAssignmentsResponse>(harness, admin.token).get(ENDPOINT);
		const patch = (voice_room: object) =>
			createBuilder<{voice_room: VoiceRoomConfigResponse}>(harness, admin.token)
				.patch('/admin/instance/config')
				.body({voice_room})
				.execute();

		const initial = await get().executeWithResponse();
		expect(readVoiceRoomAssignment(initial.json!).cameras).toBe(false);

		expect((await patch({room_cameras_enabled: true})).voice_room).toEqual({
			rooms_enabled: false,
			games_enabled: false,
			room_cameras_enabled: true,
			default_room_theme: null,
		});
		const camerasOnly = await get().executeWithResponse();
		expect(camerasOnly.json?.assignments.voice_room).toEqual({
			rooms: false,
			games: false,
			cameras: false,
			default_room_theme: null,
		});
		const camerasOnlyEtag = camerasOnly.response.headers.get('etag') as string;

		await patch({rooms_enabled: true});
		const on = await get().header('If-None-Match', camerasOnlyEtag).executeWithResponse();
		expect(on.response.status).toBe(HTTP_STATUS.OK);
		expect(on.json?.assignments.voice_room).toEqual({
			rooms: true,
			games: false,
			cameras: true,
			default_room_theme: null,
		});
		const onEtag = on.response.headers.get('etag') as string;

		await patch({room_cameras_enabled: false, default_room_theme: null});
		const off = await get().header('If-None-Match', onEtag).executeWithResponse();
		expect(off.response.status).toBe(HTTP_STATUS.OK);
		expect(off.response.headers.get('etag')).not.toBe(onEtag);
		expect(off.json?.assignments.voice_room).toEqual({
			rooms: true,
			games: false,
			cameras: false,
			default_room_theme: null,
		});
	});

	it('returns the inert assignment while the stored config is disabled but populated', async () => {
		const account = await createTestAccount(harness);
		await getInstanceConfigRepository().setVoiceNoiseSuppressionConfig({
			...DEFAULT_VOICE_NOISE_SUPPRESSION_CONFIG,
			enabled: false,
			config_version: 9,
			rollout_basis_points: 10000,
			included_user_ids: [account.userId],
		});

		const body = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token).get(ENDPOINT).execute();

		expect(body.assignments.voice_noise_suppression).toEqual({
			...INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT,
			config_version: 9,
		});
	});

	it('populates the voice assignment key even when the rollout is disabled', async () => {
		const account = await createTestAccount(harness);

		const body = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token).get(ENDPOINT).execute();

		expect(Object.hasOwn(body.assignments, 'voice_noise_suppression')).toBe(true);
		expect(readVoiceNoiseSuppressionAssignment(body).enabled).toBe(false);
	});

	it('serves the delivery cadence from the delivery config and not from the voice config', async () => {
		const account = await createTestAccount(harness);
		await getInstanceConfigRepository().setExperimentDeliveryConfig({
			poll_interval_seconds: 7200,
			poll_jitter_percent: 45,
		});
		await getInstanceConfigRepository().setVoiceNoiseSuppressionConfig({
			...DEFAULT_VOICE_NOISE_SUPPRESSION_CONFIG,
			enabled: true,
			config_version: 3,
			rollout_basis_points: 10000,
		});

		const body = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token).get(ENDPOINT).execute();

		expect(body.poll_interval_seconds).toBe(7200);
		expect(body.poll_jitter_percent).toBe(45);
		expect(body.assignments.voice_noise_suppression).toMatchObject({enabled: true, config_version: 3});
		expect(body.assignments.voice_noise_suppression).not.toHaveProperty('poll_interval_seconds');
		expect(body.assignments.voice_noise_suppression).not.toHaveProperty('poll_jitter_percent');
	});

	it('echoes the config version and resolves the caller through the allowlist', async () => {
		const targeted = await createTestAccount(harness);
		const untargeted = await createTestAccount(harness);
		await getInstanceConfigRepository().setVoiceNoiseSuppressionConfig({
			...DEFAULT_VOICE_NOISE_SUPPRESSION_CONFIG,
			enabled: true,
			config_version: 14,
			default_backend: 'rnnoise',
			rollout_basis_points: 0,
			included_user_ids: [targeted.userId],
		});

		const targetedBody = await createBuilder<ExperimentAssignmentsResponse>(harness, targeted.token)
			.get(ENDPOINT)
			.execute();
		expect(targetedBody.assignments.voice_noise_suppression).toMatchObject({
			enabled: true,
			config_version: 14,
			user_targeted: true,
			backend: 'rnnoise',
			source: 'user_rule',
		});

		const untargetedBody = await createBuilder<ExperimentAssignmentsResponse>(harness, untargeted.token)
			.get(ENDPOINT)
			.execute();
		expect(untargetedBody.assignments.voice_noise_suppression).toMatchObject({
			enabled: true,
			config_version: 14,
			user_targeted: false,
			backend: null,
			source: null,
		});
	});

	it('resolves the domain migration caller through the allowlist', async () => {
		const targeted = await createTestAccount(harness);
		const untargeted = await createTestAccount(harness);
		await getInstanceConfigRepository().setDomainMigrationConfig({
			...DEFAULT_DOMAIN_MIGRATION_CONFIG,
			enabled: true,
			config_version: 4,
			rollout_basis_points: 0,
			included_user_ids: [targeted.userId],
		});

		const targetedBody = await createBuilder<ExperimentAssignmentsResponse>(harness, targeted.token)
			.get(ENDPOINT)
			.execute();
		expect(targetedBody.assignments.domain_migration).toEqual({enabled: true});

		const untargetedBody = await createBuilder<ExperimentAssignmentsResponse>(harness, untargeted.token)
			.get(ENDPOINT)
			.execute();
		expect(untargetedBody.assignments.domain_migration).toEqual({enabled: false});
	});

	it('keeps the domain migration exclusion ahead of a full rollout', async () => {
		const excluded = await createTestAccount(harness);
		await getInstanceConfigRepository().setDomainMigrationConfig({
			...DEFAULT_DOMAIN_MIGRATION_CONFIG,
			enabled: true,
			rollout_basis_points: 10000,
			included_user_ids: [excluded.userId],
			excluded_user_ids: [excluded.userId],
		});

		const body = await createBuilder<ExperimentAssignmentsResponse>(harness, excluded.token).get(ENDPOINT).execute();

		expect(body.assignments.domain_migration).toEqual({enabled: false});
	});

	it('resolves the voice p2p caller through the allowlist and the exclusion list', async () => {
		const targeted = await createTestAccount(harness);
		const untargeted = await createTestAccount(harness);
		const excluded = await createTestAccount(harness);
		await getInstanceConfigRepository().setVoiceP2pConfig({
			...DEFAULT_VOICE_P2P_CONFIG,
			enabled: true,
			rollout_basis_points: 0,
			included_user_ids: [targeted.userId, excluded.userId],
			excluded_user_ids: [excluded.userId],
		});

		const targetedBody = await createBuilder<ExperimentAssignmentsResponse>(harness, targeted.token)
			.get(ENDPOINT)
			.execute();
		expect(targetedBody.assignments.voice_p2p).toEqual({enabled: true, max_participants: 2});

		const untargetedBody = await createBuilder<ExperimentAssignmentsResponse>(harness, untargeted.token)
			.get(ENDPOINT)
			.execute();
		expect(untargetedBody.assignments.voice_p2p).toEqual({enabled: false, max_participants: 2});

		const excludedBody = await createBuilder<ExperimentAssignmentsResponse>(harness, excluded.token)
			.get(ENDPOINT)
			.execute();
		expect(excludedBody.assignments.voice_p2p).toEqual({enabled: false, max_participants: 2});
	});

	it('limits the percentage rollout of every experiment to the listed request countries', async () => {
		const account = await createTestAccount(harness);
		const included = await createTestAccount(harness);
		const repository = getInstanceConfigRepository();
		const rollout = {enabled: true, rollout_basis_points: 10000, rollout_country_codes: ['SE', 'NO']};
		await repository.setDomainMigrationConfig({...DEFAULT_DOMAIN_MIGRATION_CONFIG, ...rollout});
		await repository.setVoiceP2pConfig({
			...DEFAULT_VOICE_P2P_CONFIG,
			...rollout,
			included_user_ids: [included.userId],
		});

		for (const [countryCode, expected] of [
			['SE', true],
			['BR', false],
			[null, false],
		] as const) {
			lookupGeoipMock.mockResolvedValue(geoipCountry(countryCode));
			const body = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token).get(ENDPOINT).execute();
			expect(body.assignments.domain_migration).toEqual({enabled: expected});
			expect(body.assignments.voice_p2p).toEqual({enabled: expected, max_participants: 2});
		}

		lookupGeoipMock.mockResolvedValue(geoipCountry('BR'));
		const includedBody = await createBuilder<ExperimentAssignmentsResponse>(harness, included.token)
			.get(ENDPOINT)
			.execute();
		expect(includedBody.assignments.voice_p2p).toEqual({enabled: true, max_participants: 2});
	});

	it('enrols members of an included guild in every experiment and leaves everyone else out', async () => {
		const owner = await createTestAccount(harness);
		const member = await createTestAccount(harness);
		const outsider = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, 'Experiment Guild');
		const systemChannel = await getChannel(harness, owner.token, guild.system_channel_id!);
		const invite = await createChannelInvite(harness, owner.token, systemChannel.id);
		await acceptInvite(harness, member.token, invite.code);
		const repository = getInstanceConfigRepository();
		await repository.setDomainMigrationConfig({
			...DEFAULT_DOMAIN_MIGRATION_CONFIG,
			enabled: true,
			included_guild_ids: [guild.id],
		});
		await repository.setVoiceP2pConfig({
			...DEFAULT_VOICE_P2P_CONFIG,
			enabled: true,
			included_guild_ids: [guild.id],
		});

		const memberBody = await createBuilder<ExperimentAssignmentsResponse>(harness, member.token)
			.get(ENDPOINT)
			.execute();
		expect(memberBody.assignments.domain_migration).toEqual({enabled: true});
		expect(memberBody.assignments.voice_p2p).toEqual({enabled: true, max_participants: 2});

		const outsiderBody = await createBuilder<ExperimentAssignmentsResponse>(harness, outsider.token)
			.get(ENDPOINT)
			.execute();
		expect(outsiderBody.assignments.domain_migration).toEqual({enabled: false});
		expect(outsiderBody.assignments.voice_p2p).toEqual({enabled: false, max_participants: 2});
	});

	it('enrols premium users, subscription and lifetime alike, when the switch is on', async () => {
		const subscriber = await createTestAccount(harness);
		const visionary = await createTestAccount(harness);
		const free = await createTestAccount(harness);
		await grantPremium(harness, subscriber.userId, UserPremiumTypes.SUBSCRIPTION);
		await grantPremium(harness, visionary.userId, UserPremiumTypes.LIFETIME);
		const repository = getInstanceConfigRepository();
		await repository.setDomainMigrationConfig({
			...DEFAULT_DOMAIN_MIGRATION_CONFIG,
			enabled: true,
			include_premium_users: true,
		});
		await repository.setVoiceP2pConfig({
			...DEFAULT_VOICE_P2P_CONFIG,
			enabled: true,
			include_premium_users: true,
		});
		for (const [account, expected] of [
			[subscriber, true],
			[visionary, true],
			[free, false],
		] as const) {
			const body = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token).get(ENDPOINT).execute();
			expect(body.assignments.domain_migration).toEqual({enabled: expected});
			expect(body.assignments.voice_p2p).toEqual({enabled: expected, max_participants: 2});
		}
	});

	it('stores the guild ids, countries and premium switch an admin sets for each experiment', async () => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
		]);
		const guildIds = ['1500000000000000001', '1500000000000000002'];
		const countryCodes = ['SE', 'NO'];
		const section = {included_guild_ids: guildIds, include_premium_users: true, rollout_country_codes: countryCodes};
		const body = await createBuilder<
			Record<
				'domain_migration' | 'voice_p2p',
				{included_guild_ids: Array<string>; include_premium_users: boolean; rollout_country_codes: Array<string>}
			>
		>(harness, admin.token)
			.patch('/admin/instance/config')
			.body({domain_migration: section, voice_p2p: section})
			.execute();
		for (const stored of [body.domain_migration, body.voice_p2p]) {
			expect(stored.included_guild_ids).toEqual(guildIds);
			expect(stored.include_premium_users).toBe(true);
			expect(stored.rollout_country_codes).toEqual(countryCodes);
		}
	});

	it('revalidates with a strong etag and answers 304 when nothing changed', async () => {
		const account = await createTestAccount(harness);

		const first = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token)
			.get(ENDPOINT)
			.executeWithResponse();
		const etag = first.response.headers.get('etag');
		expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
		expect(first.response.headers.get('cache-control')).toBe('private, no-cache');
		expect(first.response.headers.get('vary')).toBe('Authorization, Origin');

		const revalidated = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token)
			.get(ENDPOINT)
			.header('If-None-Match', etag as string)
			.expect(NOT_MODIFIED)
			.executeWithResponse();
		expect(revalidated.response.status).toBe(NOT_MODIFIED);
		expect(revalidated.json).toBeUndefined();
		expect(revalidated.response.headers.get('etag')).toBe(etag);
		expect(revalidated.response.headers.get('vary')).toBe('Authorization, Origin');
	});

	it('lets a cross-origin client send If-None-Match and read the etag back', async () => {
		const preflight = await harness.requestJson({path: ENDPOINT, method: 'OPTIONS'});

		expect(preflight.headers.get('access-control-allow-headers')).toContain('If-None-Match');
		expect(preflight.headers.get('access-control-expose-headers')).toContain('ETag');
	});

	it('serves a fresh body once the voice config changes', async () => {
		const account = await createTestAccount(harness);

		const first = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token)
			.get(ENDPOINT)
			.executeWithResponse();
		const staleEtag = first.response.headers.get('etag') as string;

		await getInstanceConfigRepository().setVoiceNoiseSuppressionConfig({
			...DEFAULT_VOICE_NOISE_SUPPRESSION_CONFIG,
			enabled: true,
			config_version: 1,
			rollout_basis_points: 10000,
		});

		const refreshed = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token)
			.get(ENDPOINT)
			.header('If-None-Match', staleEtag)
			.executeWithResponse();
		expect(refreshed.response.status).toBe(HTTP_STATUS.OK);
		expect(refreshed.response.headers.get('etag')).not.toBe(staleEtag);
		expect(refreshed.json?.assignments.voice_noise_suppression).toMatchObject({
			enabled: true,
			config_version: 1,
			user_targeted: true,
		});
	});

	it('serves a fresh body once the domain migration config changes', async () => {
		const account = await createTestAccount(harness);

		const first = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token)
			.get(ENDPOINT)
			.executeWithResponse();
		const staleEtag = first.response.headers.get('etag') as string;

		await getInstanceConfigRepository().setDomainMigrationConfig({
			...DEFAULT_DOMAIN_MIGRATION_CONFIG,
			enabled: true,
			config_version: 1,
			rollout_basis_points: 10000,
		});

		const refreshed = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token)
			.get(ENDPOINT)
			.header('If-None-Match', staleEtag)
			.executeWithResponse();
		expect(refreshed.response.status).toBe(HTTP_STATUS.OK);
		expect(refreshed.response.headers.get('etag')).not.toBe(staleEtag);
		expect(refreshed.json?.assignments.domain_migration).toEqual({enabled: true});
	});

	it('serves a fresh body once the delivery config changes', async () => {
		const account = await createTestAccount(harness);

		const first = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token)
			.get(ENDPOINT)
			.executeWithResponse();
		const staleEtag = first.response.headers.get('etag') as string;

		await getInstanceConfigRepository().setExperimentDeliveryConfig({
			poll_interval_seconds: 1800,
			poll_jitter_percent: 5,
		});

		const refreshed = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token)
			.get(ENDPOINT)
			.header('If-None-Match', staleEtag)
			.executeWithResponse();
		expect(refreshed.response.status).toBe(HTTP_STATUS.OK);
		expect(refreshed.response.headers.get('etag')).not.toBe(staleEtag);
		expect(refreshed.json?.poll_interval_seconds).toBe(1800);
		expect(refreshed.json?.poll_jitter_percent).toBe(5);
	});

	it('bumps the config version on every admin update without the client sending one', async () => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
		]);

		const afterFirst = await createBuilder<{voice_noise_suppression: {config_version: number; enabled: boolean}}>(
			harness,
			admin.token,
		)
			.patch('/admin/instance/config')
			.body({voice_noise_suppression: {enabled: true, rollout_basis_points: 10000}})
			.execute();
		expect(afterFirst.voice_noise_suppression).toMatchObject({config_version: 1, enabled: true});

		const afterSecond = await createBuilder<{voice_noise_suppression: {config_version: number; enabled: boolean}}>(
			harness,
			admin.token,
		)
			.patch('/admin/instance/config')
			.body({voice_noise_suppression: {suppression_strength: 42}})
			.execute();
		expect(afterSecond.voice_noise_suppression).toMatchObject({config_version: 2, enabled: true});

		const body = await createBuilder<ExperimentAssignmentsResponse>(harness, admin.token).get(ENDPOINT).execute();
		expect(body.assignments.voice_noise_suppression).toMatchObject({
			enabled: true,
			config_version: 2,
			suppression_strength: 42,
		});
	});

	it('leaves the config version alone for an admin update that sets no field', async () => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
		]);

		const afterFirst = await createBuilder<{voice_noise_suppression: {config_version: number; enabled: boolean}}>(
			harness,
			admin.token,
		)
			.patch('/admin/instance/config')
			.body({voice_noise_suppression: {enabled: true}})
			.execute();
		expect(afterFirst.voice_noise_suppression).toMatchObject({config_version: 1, enabled: true});

		const afterEmpty = await createBuilder<{voice_noise_suppression: {config_version: number; enabled: boolean}}>(
			harness,
			admin.token,
		)
			.patch('/admin/instance/config')
			.body({voice_noise_suppression: {}})
			.execute();
		expect(afterEmpty.voice_noise_suppression).toMatchObject({config_version: 1, enabled: true});

		const afterUndefined = await createBuilder<{voice_noise_suppression: {config_version: number; enabled: boolean}}>(
			harness,
			admin.token,
		)
			.patch('/admin/instance/config')
			.body({voice_noise_suppression: {enabled: undefined}})
			.execute();
		expect(afterUndefined.voice_noise_suppression).toMatchObject({config_version: 1, enabled: true});
	});

	it('bumps the domain migration config version on every admin update without the client sending one', async () => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
		]);

		const afterFirst = await createBuilder<{domain_migration: {config_version: number; enabled: boolean}}>(
			harness,
			admin.token,
		)
			.patch('/admin/instance/config')
			.body({domain_migration: {enabled: true, rollout_basis_points: 10000}})
			.execute();
		expect(afterFirst.domain_migration).toMatchObject({config_version: 1, enabled: true});

		const afterSecond = await createBuilder<{
			domain_migration: {config_version: number; enabled: boolean; anonymous_rollout_basis_points: number};
		}>(harness, admin.token)
			.patch('/admin/instance/config')
			.body({domain_migration: {anonymous_rollout_basis_points: 2500}})
			.execute();
		expect(afterSecond.domain_migration).toMatchObject({
			config_version: 2,
			enabled: true,
			anonymous_rollout_basis_points: 2500,
		});

		const afterEmpty = await createBuilder<{domain_migration: {config_version: number; enabled: boolean}}>(
			harness,
			admin.token,
		)
			.patch('/admin/instance/config')
			.body({domain_migration: {}})
			.execute();
		expect(afterEmpty.domain_migration).toMatchObject({config_version: 2, enabled: true});

		const body = await createBuilder<ExperimentAssignmentsResponse>(harness, admin.token).get(ENDPOINT).execute();
		expect(body.assignments.domain_migration).toEqual({enabled: true});
	});

	it('bumps the voice p2p config version on every admin update without the client sending one', async () => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
		]);

		const afterFirst = await createBuilder<{voice_p2p: {config_version: number; enabled: boolean}}>(
			harness,
			admin.token,
		)
			.patch('/admin/instance/config')
			.body({voice_p2p: {enabled: true, included_user_ids: [admin.userId]}})
			.execute();
		expect(afterFirst.voice_p2p).toMatchObject({config_version: 1, enabled: true});

		const afterSecond = await createBuilder<{
			voice_p2p: {config_version: number; rollout_basis_points: number};
		}>(harness, admin.token)
			.patch('/admin/instance/config')
			.body({voice_p2p: {rollout_basis_points: 2500, max_participants: 4}})
			.execute();
		expect(afterSecond.voice_p2p).toMatchObject({config_version: 2, rollout_basis_points: 2500, max_participants: 4});

		const afterEmpty = await createBuilder<{voice_p2p: {config_version: number}}>(harness, admin.token)
			.patch('/admin/instance/config')
			.body({voice_p2p: {}})
			.execute();
		expect(afterEmpty.voice_p2p).toMatchObject({config_version: 2});

		const body = await createBuilder<ExperimentAssignmentsResponse>(harness, admin.token).get(ENDPOINT).execute();
		expect(body.assignments.voice_p2p).toEqual({enabled: true, max_participants: 4});
	});

	it('serves the delivery cadence an admin set through the instance config', async () => {
		const admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.INSTANCE_CONFIG_VIEW,
			AdminACLs.INSTANCE_CONFIG_UPDATE,
		]);

		const updated = await createBuilder<{experiment_delivery: ExperimentDeliveryConfigResponse}>(harness, admin.token)
			.patch('/admin/instance/config')
			.body({experiment_delivery: {poll_interval_seconds: 3600}})
			.execute();
		expect(updated.experiment_delivery).toEqual({
			poll_interval_seconds: 3600,
			poll_jitter_percent: DEFAULT_EXPERIMENT_POLL_JITTER_PERCENT,
		});

		const body = await createBuilder<ExperimentAssignmentsResponse>(harness, admin.token).get(ENDPOINT).execute();
		expect(body.poll_interval_seconds).toBe(3600);
		expect(body.poll_jitter_percent).toBe(DEFAULT_EXPERIMENT_POLL_JITTER_PERCENT);
	});

	it('returns an inert voice noise suppression assignment until configured', async () => {
		const account = await createTestAccount(harness);

		const body = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token).get(ENDPOINT).execute();

		expect(body.assignments.voice_noise_suppression).toEqual(INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT);
	});

	it('serves the delivery cadence independently of the voice room config', async () => {
		const account = await createTestAccount(harness);
		await getInstanceConfigRepository().setExperimentDeliveryConfig({
			poll_interval_seconds: 7200,
			poll_jitter_percent: 45,
		});
		await getInstanceConfigRepository().updateVoiceRoomConfig((current) => ({...current, rooms_enabled: true}));

		const body = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token).get(ENDPOINT).execute();

		expect(body.poll_interval_seconds).toBe(7200);
		expect(body.poll_jitter_percent).toBe(45);
		expect(body.assignments.voice_room).toMatchObject({rooms: true});
		expect(body.assignments.voice_room).not.toHaveProperty('poll_interval_seconds');
		expect(body.assignments.voice_room).not.toHaveProperty('poll_jitter_percent');
	});
});

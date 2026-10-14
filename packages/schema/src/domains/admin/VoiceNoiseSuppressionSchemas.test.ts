// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	VoiceNoiseSuppressionAssignmentResponse as AssignmentSchema,
	DEFAULT_VOICE_NOISE_SUPPRESSION_CONFIG,
	INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT,
	isVoicePipelineV2Active,
	resolveVoiceNoiseSuppressionAssignment,
	resolveVoiceNoiseSuppressionForCall,
	VOICE_NOISE_SUPPRESSION_BACKENDS,
	VOICE_PIPELINE_V2_TUNING_LIMITS,
	type VoiceNoiseSuppressionAssignmentResponse,
	type VoiceNoiseSuppressionConfig,
	VoiceNoiseSuppressionConfigSchema,
	VoiceNoiseSuppressionConfigUpdateRequest,
} from '@fluxer/schema/src/domains/admin/VoiceNoiseSuppressionSchemas';
import {VoiceRoomAssignmentResponse} from '@fluxer/schema/src/domains/admin/VoiceRoomConfigSchemas';
import {experimentBucket} from '@fluxer/schema/src/domains/experiment/ExperimentBucket';
import {ExperimentAssignmentsResponse} from '@fluxer/schema/src/domains/experiment/ExperimentSchemas';
import {describe, expect, test} from 'vitest';
import {z} from 'zod';

const TARGETED_USER_ID = '1000000000000000001';
const OTHER_USER_ID = '1000000000000000002';
const GUILD_ID = '2000000000000000001';
const OTHER_GUILD_ID = '2000000000000000002';
const DEFAULT_TUNING = {
	pipeline_v2_gate_open_probability: 0.6,
	pipeline_v2_gate_refresh_probability: 0.35,
	pipeline_v2_gate_hangover_ms: 400,
	pipeline_v2_gain_target_dbfs: -26,
	pipeline_v2_gain_max_db: 20,
};
const CUSTOM_TUNING = {
	pipeline_v2_gate_open_probability: 0.8,
	pipeline_v2_gate_refresh_probability: 0.2,
	pipeline_v2_gate_hangover_ms: 900,
	pipeline_v2_gain_target_dbfs: -30,
	pipeline_v2_gain_max_db: 12,
};

describe('voice noise suppression configuration', () => {
	test('derives defaults from the schema with independently owned arrays', () => {
		const first = VoiceNoiseSuppressionConfigSchema.parse({});
		const second = VoiceNoiseSuppressionConfigSchema.parse({});
		expect(first).toEqual(DEFAULT_VOICE_NOISE_SUPPRESSION_CONFIG);
		first.enabled_backends.pop();
		first.included_user_ids.push(TARGETED_USER_ID);
		first.excluded_user_ids.push(OTHER_USER_ID);
		first.guild_overrides.push({guild_id: GUILD_ID, backend: 'rnnoise'});
		expect(second).toEqual(DEFAULT_VOICE_NOISE_SUPPRESSION_CONFIG);
	});

	test.each([{}, {enabled: false}, {enabled: undefined}, {suppression_strength: 42}])(
		'keeps partial updates free of configuration defaults: %j',
		(patch) => {
			expect(VoiceNoiseSuppressionConfigUpdateRequest.parse(patch)).toEqual(patch);
		},
	);

	test('does not accept a client-provided configuration version', () => {
		expect(VoiceNoiseSuppressionConfigUpdateRequest.parse({config_version: 12})).toEqual({});
	});

	test.each([
		{rollout_basis_points: -1},
		{rollout_basis_points: 10001},
		{suppression_strength: -1},
		{suppression_strength: 101},
		{rollout_salt: ' '},
		{included_user_ids: ['not-an-id']},
		{guild_overrides: [{guild_id: GUILD_ID, backend: 'unknown'}]},
	])('applies the same validation to stored configuration and updates: %j', (value) => {
		expect(VoiceNoiseSuppressionConfigSchema.safeParse(value).success).toBe(false);
		expect(VoiceNoiseSuppressionConfigUpdateRequest.safeParse(value).success).toBe(false);
	});
});

function createConfig(overrides: Partial<VoiceNoiseSuppressionConfig> = {}): VoiceNoiseSuppressionConfig {
	return {
		...DEFAULT_VOICE_NOISE_SUPPRESSION_CONFIG,
		enabled_backends: [...DEFAULT_VOICE_NOISE_SUPPRESSION_CONFIG.enabled_backends],
		included_user_ids: [],
		excluded_user_ids: [],
		guild_overrides: [],
		...overrides,
	};
}

function createAssignment(
	overrides: Partial<VoiceNoiseSuppressionAssignmentResponse> = {},
): VoiceNoiseSuppressionAssignmentResponse {
	return {
		enabled: true,
		pipeline_v2_enabled: false,
		pipeline_v2_all: false,
		...DEFAULT_TUNING,
		config_version: 7,
		user_targeted: true,
		backend: 'rnnoise',
		source: 'canary',
		guild_overrides: [],
		enabled_backends: [...VOICE_NOISE_SUPPRESSION_BACKENDS],
		allow_user_override: false,
		suppression_strength: 80,
		...overrides,
	};
}

const LegacyBackendSchema = z.enum(['none', 'standard', 'gate', 'speex', 'rnnoise', 'gtcrn', 'deep_filter']);
const LegacyAssignmentSchema = z.object({
	enabled: z.boolean(),
	config_version: z.number().int(),
	user_targeted: z.boolean(),
	backend: LegacyBackendSchema.nullable(),
	source: z.enum(['user_rule', 'canary']).nullable(),
	guild_overrides: z.array(z.object({guild_id: z.string().regex(/^\d{1,20}$/u), backend: LegacyBackendSchema})),
	enabled_backends: z.array(LegacyBackendSchema),
	allow_user_override: z.boolean(),
	suppression_strength: z.number().int().min(0).max(100),
});
const LegacyExperimentSchema = z.object({
	poll_interval_seconds: z.number().int(),
	poll_jitter_percent: z.number().int().min(0).max(50),
	assignments: z.object({
		voice_noise_suppression: LegacyAssignmentSchema.optional(),
		voice_room: VoiceRoomAssignmentResponse.optional(),
	}),
});

describe('voice pipeline v2', () => {
	test('defaults configuration and old server assignments to disabled', () => {
		expect(VoiceNoiseSuppressionConfigSchema.parse({})).toMatchObject({
			pipeline_v2_enabled: false,
			pipeline_v2_all: false,
		});
		const oldAssignment = LegacyAssignmentSchema.parse(createAssignment());
		expect(AssignmentSchema.parse(oldAssignment)).toMatchObject({pipeline_v2_enabled: false, pipeline_v2_all: false});
		expect(
			ExperimentAssignmentsResponse.parse({
				poll_interval_seconds: 300,
				poll_jitter_percent: 15,
				assignments: {voice_noise_suppression: oldAssignment},
			}).assignments.voice_noise_suppression,
		).toMatchObject({pipeline_v2_enabled: false, pipeline_v2_all: false});
	});

	test('accepts partial switches without inserting defaults', () => {
		for (const patch of [
			{pipeline_v2_enabled: false},
			{pipeline_v2_all: true},
			{guild_overrides: [{guild_id: GUILD_ID, backend: 'deep_filter', pipeline_v2: true}]},
		]) {
			expect(VoiceNoiseSuppressionConfigUpdateRequest.parse(patch)).toEqual(patch);
		}
	});

	test.each([
		{pipeline_v2_enabled: 'true'},
		{pipeline_v2_all: 1},
		{guild_overrides: [{guild_id: GUILD_ID, backend: 'deep_filter', pipeline_v2: 'true'}]},
	])('rejects non-boolean pipeline switches: %j', (patch) => {
		expect(VoiceNoiseSuppressionConfigSchema.safeParse(patch).success).toBe(false);
		expect(VoiceNoiseSuppressionConfigUpdateRequest.safeParse(patch).success).toBe(false);
	});

	test('carries switches and guild overrides while keeping disabled and excluded users off', () => {
		const config = createConfig({
			enabled: true,
			pipeline_v2_enabled: true,
			pipeline_v2_all: true,
			guild_overrides: [{guild_id: GUILD_ID, backend: 'deep_filter', pipeline_v2: true}],
		});
		expect(resolveVoiceNoiseSuppressionAssignment(config, TARGETED_USER_ID)).toMatchObject({
			pipeline_v2_enabled: true,
			pipeline_v2_all: true,
			guild_overrides: config.guild_overrides,
		});
		for (const inactive of [
			{...config, enabled: false},
			{...config, excluded_user_ids: [TARGETED_USER_ID]},
		]) {
			expect(resolveVoiceNoiseSuppressionAssignment(inactive, TARGETED_USER_ID)).toMatchObject({
				pipeline_v2_enabled: false,
				pipeline_v2_all: false,
				guild_overrides: [],
			});
		}
	});

	test.each([
		{enabled: false, master: true, all: true, guild: GUILD_ID, override: true, active: false},
		{enabled: true, master: false, all: true, guild: GUILD_ID, override: true, active: false},
		{enabled: true, master: true, all: false, guild: GUILD_ID, override: true, active: true},
		{enabled: true, master: true, all: false, guild: OTHER_GUILD_ID, override: true, active: false},
		{enabled: true, master: true, all: false, guild: GUILD_ID, override: false, active: false},
		{enabled: true, master: true, all: false, guild: null, override: true, active: false},
		{enabled: true, master: true, all: true, guild: null, override: false, active: true},
	])('resolves the pipeline scope: %j', ({enabled, master, all, guild, override, active}) => {
		expect(
			isVoicePipelineV2Active(
				createAssignment({
					enabled,
					pipeline_v2_enabled: master,
					pipeline_v2_all: all,
					user_targeted: false,
					guild_overrides: [{guild_id: GUILD_ID, backend: 'deep_filter', pipeline_v2: override}],
				}),
				guild,
			),
		).toBe(active);
	});

	test('keeps new assignments compatible with the previous assignment and experiment schemas', () => {
		const assignment = resolveVoiceNoiseSuppressionAssignment(
			createConfig({
				enabled: true,
				pipeline_v2_enabled: true,
				pipeline_v2_all: true,
				guild_overrides: [{guild_id: GUILD_ID, backend: 'deep_filter', pipeline_v2: true}],
			}),
			TARGETED_USER_ID,
		);
		const legacy = LegacyAssignmentSchema.parse(assignment);
		expect(legacy).not.toHaveProperty('pipeline_v2_enabled');
		expect(legacy.guild_overrides[0]).not.toHaveProperty('pipeline_v2');
		const response = ExperimentAssignmentsResponse.parse({
			poll_interval_seconds: 300,
			poll_jitter_percent: 15,
			assignments: {voice_noise_suppression: assignment},
		});
		expect(LegacyExperimentSchema.parse(response).assignments.voice_noise_suppression).toEqual(legacy);
	});
});

describe('voice pipeline v2 tuning', () => {
	test('defaults configuration tuning to the published limits', () => {
		expect(VoiceNoiseSuppressionConfigSchema.parse({})).toMatchObject(DEFAULT_TUNING);
		expect(
			Object.fromEntries(
				Object.entries(VOICE_PIPELINE_V2_TUNING_LIMITS).map(([key, limits]) => [`pipeline_v2_${key}`, limits.default]),
			),
		).toEqual(DEFAULT_TUNING);
	});

	test.each([
		{pipeline_v2_gate_open_probability: 0.29},
		{pipeline_v2_gate_open_probability: 0.96},
		{pipeline_v2_gate_refresh_probability: 0.09},
		{pipeline_v2_gate_refresh_probability: 0.91},
		{pipeline_v2_gate_hangover_ms: 99},
		{pipeline_v2_gate_hangover_ms: 1501},
		{pipeline_v2_gate_hangover_ms: 400.5},
		{pipeline_v2_gain_target_dbfs: -41},
		{pipeline_v2_gain_target_dbfs: -13},
		{pipeline_v2_gain_target_dbfs: -26.5},
		{pipeline_v2_gain_max_db: -1},
		{pipeline_v2_gain_max_db: 31},
		{pipeline_v2_gain_max_db: 10.5},
		{pipeline_v2_gate_open_probability: '0.6'},
	])('rejects out-of-range tuning in configuration and updates: %j', (value) => {
		expect(VoiceNoiseSuppressionConfigSchema.safeParse(value).success).toBe(false);
		expect(VoiceNoiseSuppressionConfigUpdateRequest.safeParse(value).success).toBe(false);
	});

	test('accepts each tuning field alone at both bounds without inserting defaults', () => {
		for (const [key, limits] of Object.entries(VOICE_PIPELINE_V2_TUNING_LIMITS)) {
			for (const bound of [limits.min, limits.max]) {
				const patch = {[`pipeline_v2_${key}`]: bound};
				expect(VoiceNoiseSuppressionConfigUpdateRequest.parse(patch)).toEqual(patch);
			}
		}
	});

	test('carries configured tuning into assignments for targeted and untargeted users', () => {
		const config = createConfig({enabled: true, included_user_ids: [TARGETED_USER_ID], ...CUSTOM_TUNING});
		expect(resolveVoiceNoiseSuppressionAssignment(config, TARGETED_USER_ID)).toMatchObject(CUSTOM_TUNING);
		expect(resolveVoiceNoiseSuppressionAssignment(config, OTHER_USER_ID)).toMatchObject({
			user_targeted: false,
			...CUSTOM_TUNING,
		});
	});

	test('uses default tuning when the configuration is off or the user is excluded', () => {
		expect(INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT).toMatchObject(DEFAULT_TUNING);
		const config = createConfig({enabled: true, rollout_basis_points: 10000, ...CUSTOM_TUNING});
		for (const inactive of [
			{...config, enabled: false},
			{...config, excluded_user_ids: [TARGETED_USER_ID]},
		]) {
			expect(resolveVoiceNoiseSuppressionAssignment(inactive, TARGETED_USER_ID)).toMatchObject(DEFAULT_TUNING);
		}
	});

	test('parses older assignments without tuning into the defaults', () => {
		const oldAssignment = LegacyAssignmentSchema.parse(createAssignment(CUSTOM_TUNING));
		expect(oldAssignment).not.toHaveProperty('pipeline_v2_gate_open_probability');
		expect(AssignmentSchema.parse(oldAssignment)).toMatchObject(DEFAULT_TUNING);
		expect(
			ExperimentAssignmentsResponse.parse({
				poll_interval_seconds: 300,
				poll_jitter_percent: 15,
				assignments: {voice_noise_suppression: oldAssignment},
			}).assignments.voice_noise_suppression,
		).toMatchObject(DEFAULT_TUNING);
	});

	test('keeps out-of-range tuning in an assignment instead of rejecting it', () => {
		const outOfRange = {
			pipeline_v2_gate_open_probability: 2,
			pipeline_v2_gate_refresh_probability: -1,
			pipeline_v2_gate_hangover_ms: 99999.5,
			pipeline_v2_gain_target_dbfs: 10,
			pipeline_v2_gain_max_db: 120.25,
		};
		const assignment = createAssignment(outOfRange);
		expect(AssignmentSchema.parse(assignment)).toMatchObject(outOfRange);
		expect(
			ExperimentAssignmentsResponse.parse({
				poll_interval_seconds: 300,
				poll_jitter_percent: 15,
				assignments: {voice_noise_suppression: assignment},
			}).assignments.voice_noise_suppression,
		).toMatchObject(outOfRange);
	});
});

function syntheticUserIds(count: number): Array<string> {
	const ids: Array<string> = [];
	for (let index = 0; index < count; index++) {
		ids.push((1400000000000000000n + BigInt(index)).toString());
	}
	return ids;
}

function targetedUserIds(config: VoiceNoiseSuppressionConfig, userIds: ReadonlyArray<string>): Set<string> {
	const targeted = new Set<string>();
	for (const userId of userIds) {
		if (resolveVoiceNoiseSuppressionAssignment(config, userId).user_targeted) {
			targeted.add(userId);
		}
	}
	return targeted;
}

describe('experimentBucket', () => {
	test('stays inside the basis point range for every synthetic id', () => {
		for (const userId of syntheticUserIds(500)) {
			const bucket = experimentBucket(userId, 'voice-ns-v1');
			expect(Number.isInteger(bucket)).toBe(true);
			expect(bucket).toBeGreaterThanOrEqual(0);
			expect(bucket).toBeLessThan(10000);
		}
	});

	test.each([
		{userId: TARGETED_USER_ID, salt: 'voice-ns-v1', expected: 8241},
		{userId: TARGETED_USER_ID, salt: 'voice-ns-v2', expected: 8500},
		{userId: OTHER_USER_ID, salt: 'voice-ns-v1', expected: 5384},
		{userId: OTHER_USER_ID, salt: 'voice-ns-v2', expected: 1357},
	])('preserves the assignment bucket for $userId with salt $salt', ({userId, salt, expected}) => {
		expect(experimentBucket(userId, salt)).toBe(expected);
	});

	test('changes with the salt for at least most user ids', () => {
		const userIds = syntheticUserIds(200);
		const changed = userIds.filter(
			(userId) => experimentBucket(userId, 'voice-ns-v1') !== experimentBucket(userId, 'voice-ns-v2'),
		);
		expect(changed.length).toBeGreaterThan(userIds.length - 5);
	});
});

describe('resolveVoiceNoiseSuppressionAssignment', () => {
	test('returns the inert assignment when the master switch is off', () => {
		const config = createConfig({
			enabled: false,
			config_version: 4,
			rollout_basis_points: 10000,
			included_user_ids: [TARGETED_USER_ID],
			guild_overrides: [{guild_id: GUILD_ID, backend: 'rnnoise'}],
		});
		expect(resolveVoiceNoiseSuppressionAssignment(config, TARGETED_USER_ID)).toEqual({
			...INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT,
			config_version: 4,
		});
	});

	test('returns the inert assignment for the default config', () => {
		expect(resolveVoiceNoiseSuppressionAssignment(createConfig(), TARGETED_USER_ID)).toEqual(
			INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT,
		);
	});

	test('denylist beats allowlist', () => {
		const config = createConfig({
			enabled: true,
			included_user_ids: [TARGETED_USER_ID],
			excluded_user_ids: [TARGETED_USER_ID],
		});
		const assignment = resolveVoiceNoiseSuppressionAssignment(config, TARGETED_USER_ID);
		expect(assignment.user_targeted).toBe(false);
		expect(assignment.backend).toBeNull();
		expect(assignment.source).toBeNull();
	});

	test('denylist beats canary', () => {
		const config = createConfig({
			enabled: true,
			rollout_basis_points: 10000,
			excluded_user_ids: [TARGETED_USER_ID],
		});
		const assignment = resolveVoiceNoiseSuppressionAssignment(config, TARGETED_USER_ID);
		expect(assignment.user_targeted).toBe(false);
		expect(assignment.source).toBeNull();
		expect(resolveVoiceNoiseSuppressionAssignment(config, OTHER_USER_ID).user_targeted).toBe(true);
	});

	test('denylist strips guild overrides and the client-side knobs', () => {
		const config = createConfig({
			enabled: true,
			allow_user_override: true,
			rollout_basis_points: 10000,
			excluded_user_ids: [TARGETED_USER_ID],
			guild_overrides: [{guild_id: GUILD_ID, backend: 'rnnoise'}],
		});
		const assignment = resolveVoiceNoiseSuppressionAssignment(config, TARGETED_USER_ID);
		expect(assignment.guild_overrides).toEqual([]);
		expect(assignment.enabled_backends).toEqual([]);
		expect(assignment.allow_user_override).toBe(false);
	});

	test('allowlist gives source user_rule outside the canary', () => {
		const config = createConfig({
			enabled: true,
			default_backend: 'gtcrn',
			rollout_basis_points: 0,
			included_user_ids: [TARGETED_USER_ID],
		});
		const assignment = resolveVoiceNoiseSuppressionAssignment(config, TARGETED_USER_ID);
		expect(assignment.user_targeted).toBe(true);
		expect(assignment.backend).toBe('gtcrn');
		expect(assignment.source).toBe('user_rule');
	});

	test.each([
		{basisPoints: 0, targeted: false},
		{basisPoints: 10000, targeted: true},
	])('canary at $basisPoints basis points targets $targeted', ({basisPoints, targeted}) => {
		const config = createConfig({enabled: true, rollout_basis_points: basisPoints});
		for (const userId of syntheticUserIds(200)) {
			const assignment = resolveVoiceNoiseSuppressionAssignment(config, userId);
			expect(assignment.user_targeted).toBe(targeted);
			expect(assignment.source).toBe(targeted ? 'canary' : null);
		}
	});

	test('raising the rollout basis points only ever adds users', () => {
		const userIds = syntheticUserIds(2000);
		const atOneThousand = targetedUserIds(createConfig({enabled: true, rollout_basis_points: 1000}), userIds);
		const atTwoThousand = targetedUserIds(createConfig({enabled: true, rollout_basis_points: 2000}), userIds);
		expect(atOneThousand.size).toBeGreaterThan(0);
		for (const userId of atOneThousand) {
			expect(atTwoThousand.has(userId)).toBe(true);
		}
		expect(atTwoThousand.size).toBeGreaterThan(atOneThousand.size);
	});

	test('the canary set follows the salt', () => {
		const userIds = syntheticUserIds(2000);
		const first = targetedUserIds(
			createConfig({enabled: true, rollout_basis_points: 5000, rollout_salt: 'voice-ns-v1'}),
			userIds,
		);
		const second = targetedUserIds(
			createConfig({enabled: true, rollout_basis_points: 5000, rollout_salt: 'voice-ns-v2'}),
			userIds,
		);
		expect(first).not.toEqual(second);
	});

	test('a default backend missing from enabled_backends yields no backend and no source', () => {
		const config = createConfig({
			enabled: true,
			default_backend: 'deep_filter',
			enabled_backends: ['none', 'standard'],
			rollout_basis_points: 10000,
			included_user_ids: [OTHER_USER_ID],
		});
		for (const userId of [TARGETED_USER_ID, OTHER_USER_ID]) {
			const assignment = resolveVoiceNoiseSuppressionAssignment(config, userId);
			expect(assignment.user_targeted).toBe(false);
			expect(assignment.backend).toBeNull();
			expect(assignment.source).toBeNull();
		}
	});

	test('guild overrides naming a disabled backend are filtered out', () => {
		const config = createConfig({
			enabled: true,
			default_backend: 'standard',
			enabled_backends: ['none', 'standard', 'rnnoise'],
			rollout_basis_points: 10000,
			guild_overrides: [
				{guild_id: GUILD_ID, backend: 'rnnoise'},
				{guild_id: OTHER_GUILD_ID, backend: 'deep_filter'},
			],
		});
		expect(resolveVoiceNoiseSuppressionAssignment(config, TARGETED_USER_ID).guild_overrides).toEqual([
			{guild_id: GUILD_ID, backend: 'rnnoise'},
		]);
	});

	test('guild overrides survive the allowlist path too', () => {
		const config = createConfig({
			enabled: true,
			enabled_backends: ['none', 'standard', 'rnnoise'],
			included_user_ids: [TARGETED_USER_ID],
			guild_overrides: [
				{guild_id: GUILD_ID, backend: 'rnnoise'},
				{guild_id: OTHER_GUILD_ID, backend: 'gtcrn'},
			],
		});
		expect(resolveVoiceNoiseSuppressionAssignment(config, TARGETED_USER_ID).guild_overrides).toEqual([
			{guild_id: GUILD_ID, backend: 'rnnoise'},
		]);
	});

	test('echoes the config version on every path', () => {
		const config = createConfig({enabled: true, config_version: 11, rollout_basis_points: 10000});
		expect(resolveVoiceNoiseSuppressionAssignment(config, TARGETED_USER_ID).config_version).toBe(11);
	});
});

describe('resolveVoiceNoiseSuppressionForCall', () => {
	test('returns null when the master switch is off', () => {
		const assignment = createAssignment({
			enabled: false,
			user_targeted: true,
			backend: 'rnnoise',
			source: 'user_rule',
			allow_user_override: true,
			guild_overrides: [{guild_id: GUILD_ID, backend: 'gtcrn'}],
		});
		expect(resolveVoiceNoiseSuppressionForCall(assignment, GUILD_ID, 'speex')).toBeNull();
		expect(resolveVoiceNoiseSuppressionForCall(assignment, null, null)).toBeNull();
	});

	test('returns null when nothing targets the user', () => {
		const assignment = createAssignment({user_targeted: false, backend: null, source: null});
		expect(resolveVoiceNoiseSuppressionForCall(assignment, GUILD_ID, null)).toBeNull();
		expect(resolveVoiceNoiseSuppressionForCall(assignment, null, null)).toBeNull();
	});

	test('user_rule beats guild_rule', () => {
		const assignment = createAssignment({
			backend: 'rnnoise',
			source: 'user_rule',
			guild_overrides: [{guild_id: GUILD_ID, backend: 'gtcrn'}],
		});
		expect(resolveVoiceNoiseSuppressionForCall(assignment, GUILD_ID, null)).toMatchObject({
			backend: 'rnnoise',
			source: 'user_rule',
		});
	});

	test('guild_rule beats canary', () => {
		const assignment = createAssignment({
			backend: 'rnnoise',
			source: 'canary',
			guild_overrides: [{guild_id: GUILD_ID, backend: 'gtcrn'}],
		});
		expect(resolveVoiceNoiseSuppressionForCall(assignment, GUILD_ID, null)).toMatchObject({
			backend: 'gtcrn',
			source: 'guild_rule',
		});
	});

	test('a guild override targets an otherwise untargeted user', () => {
		const assignment = createAssignment({
			user_targeted: false,
			backend: null,
			source: null,
			guild_overrides: [{guild_id: GUILD_ID, backend: 'speex'}],
		});
		expect(resolveVoiceNoiseSuppressionForCall(assignment, GUILD_ID, null)).toMatchObject({
			backend: 'speex',
			source: 'guild_rule',
		});
		expect(resolveVoiceNoiseSuppressionForCall(assignment, OTHER_GUILD_ID, null)).toBeNull();
	});

	test('a DM falls through to the user level result', () => {
		const assignment = createAssignment({
			backend: 'rnnoise',
			source: 'canary',
			guild_overrides: [{guild_id: GUILD_ID, backend: 'gtcrn'}],
		});
		expect(resolveVoiceNoiseSuppressionForCall(assignment, null, null)).toMatchObject({
			backend: 'rnnoise',
			source: 'canary',
		});
	});

	test.each([
		{allowUserOverride: true, preference: 'speex', expectedBackend: 'speex', expectedSource: 'user_override'},
		{allowUserOverride: true, preference: 'gtcrn', expectedBackend: 'rnnoise', expectedSource: 'canary'},
		{allowUserOverride: false, preference: 'speex', expectedBackend: 'rnnoise', expectedSource: 'canary'},
		{allowUserOverride: true, preference: null, expectedBackend: 'rnnoise', expectedSource: 'canary'},
	] as const)(
		'allow_user_override $allowUserOverride with preference $preference resolves to $expectedSource',
		({allowUserOverride, preference, expectedBackend, expectedSource}) => {
			const assignment = createAssignment({
				backend: 'rnnoise',
				source: 'canary',
				allow_user_override: allowUserOverride,
				enabled_backends: ['none', 'standard', 'speex', 'rnnoise'],
			});
			expect(resolveVoiceNoiseSuppressionForCall(assignment, null, preference)).toMatchObject({
				backend: expectedBackend,
				source: expectedSource,
			});
		},
	);

	test('a user override also outranks a guild rule', () => {
		const assignment = createAssignment({
			user_targeted: false,
			backend: null,
			source: null,
			allow_user_override: true,
			enabled_backends: ['none', 'standard', 'speex'],
			guild_overrides: [{guild_id: GUILD_ID, backend: 'standard'}],
		});
		expect(resolveVoiceNoiseSuppressionForCall(assignment, GUILD_ID, 'speex')).toMatchObject({
			backend: 'speex',
			source: 'user_override',
		});
	});

	test('carries the client knobs through', () => {
		const assignment = createAssignment({
			backend: 'rnnoise',
			source: 'user_rule',
			suppression_strength: 42,
			config_version: 19,
		});
		expect(resolveVoiceNoiseSuppressionForCall(assignment, null, null)).toEqual({
			backend: 'rnnoise',
			source: 'user_rule',
			suppressionStrength: 42,
			configVersion: 19,
		});
	});
});

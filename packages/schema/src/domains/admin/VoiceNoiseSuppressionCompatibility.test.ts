// SPDX-License-Identifier: AGPL-3.0-or-later

import {InstanceConfigUpdateRequest} from '@fluxer/schema/src/domains/admin/AdminSchemas';
import {ExperimentAssignmentsResponse} from '@fluxer/schema/src/domains/experiment/ExperimentSchemas';
import {describe, expect, test} from 'vitest';

describe('voice noise suppression compatibility', () => {
	test('retains operator strength and guild overrides in admin updates', () => {
		const voice_noise_suppression = {
			suppression_strength: 57,
			guild_overrides: [{guild_id: '123', backend: 'rnnoise'}],
		};
		expect(InstanceConfigUpdateRequest.parse({voice_noise_suppression})).toEqual({voice_noise_suppression});
	});

	test('retains the per-user noise assignment in experiment responses', () => {
		const response = {
			poll_interval_seconds: 300,
			poll_jitter_percent: 15,
			assignments: {
				voice_noise_suppression: {
					enabled: true,
					pipeline_v2_enabled: true,
					pipeline_v2_all: true,
					pipeline_v2_gate_open_probability: 0.7,
					pipeline_v2_gate_refresh_probability: 0.4,
					pipeline_v2_gate_hangover_ms: 600,
					pipeline_v2_gain_target_dbfs: -24,
					pipeline_v2_gain_max_db: 12,
					config_version: 7,
					user_targeted: true,
					backend: 'rnnoise',
					source: 'user_rule',
					guild_overrides: [{guild_id: '123', backend: 'gate'}],
					enabled_backends: ['rnnoise', 'gate'],
					allow_user_override: true,
					suppression_strength: 57,
				},
			},
		};
		expect(ExperimentAssignmentsResponse.parse(response)).toEqual(response);
	});
});

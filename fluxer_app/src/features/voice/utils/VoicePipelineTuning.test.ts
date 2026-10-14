// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT,
	VOICE_PIPELINE_V2_TUNING_LIMITS,
	type VoiceNoiseSuppressionAssignmentResponse,
} from '@fluxer/schema/src/domains/admin/VoiceNoiseSuppressionSchemas';
import {describe, expect, it} from 'vitest';
import {resolveVoicePipelineTuning, VOICE_PIPELINE_TUNING} from './VoicePipelineTuning';

function tuning(values: Partial<VoiceNoiseSuppressionAssignmentResponse>) {
	return resolveVoicePipelineTuning({...INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT, ...values});
}

describe('voice pipeline v2 tuning resolution', () => {
	it('defaults to the shared schema limits', () => {
		expect(VOICE_PIPELINE_TUNING).toMatchObject({
			gateOpenProbability: VOICE_PIPELINE_V2_TUNING_LIMITS.gate_open_probability.default,
			gateRefreshProbability: VOICE_PIPELINE_V2_TUNING_LIMITS.gate_refresh_probability.default,
			gateHangoverMs: VOICE_PIPELINE_V2_TUNING_LIMITS.gate_hangover_ms.default,
			gainTargetDbfs: VOICE_PIPELINE_V2_TUNING_LIMITS.gain_target_dbfs.default,
			gainMaxDb: VOICE_PIPELINE_V2_TUNING_LIMITS.gain_max_db.default,
		});
		expect(resolveVoicePipelineTuning(INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT)).toEqual(VOICE_PIPELINE_TUNING);
	});

	it('applies in-range assignment values and keeps the fixed constants', () => {
		expect(
			tuning({
				pipeline_v2_gate_open_probability: 0.8,
				pipeline_v2_gate_refresh_probability: 0.5,
				pipeline_v2_gate_hangover_ms: 900,
				pipeline_v2_gain_target_dbfs: -20,
				pipeline_v2_gain_max_db: 10,
			}),
		).toEqual({
			...VOICE_PIPELINE_TUNING,
			gateOpenProbability: 0.8,
			gateRefreshProbability: 0.5,
			gateHangoverMs: 900,
			gainTargetDbfs: -20,
			gainMaxDb: 10,
		});
	});

	it('clamps out-of-range values to the limits', () => {
		expect(
			tuning({
				pipeline_v2_gate_open_probability: 0.99,
				pipeline_v2_gate_refresh_probability: 0.01,
				pipeline_v2_gate_hangover_ms: 5000,
				pipeline_v2_gain_target_dbfs: -60,
				pipeline_v2_gain_max_db: 45,
			}),
		).toMatchObject({
			gateOpenProbability: 0.95,
			gateRefreshProbability: 0.1,
			gateHangoverMs: 1500,
			gainTargetDbfs: -40,
			gainMaxDb: 30,
		});
		expect(
			tuning({
				pipeline_v2_gate_open_probability: 0.1,
				pipeline_v2_gate_hangover_ms: 10,
				pipeline_v2_gain_target_dbfs: 0,
				pipeline_v2_gain_max_db: -5,
			}),
		).toMatchObject({gateOpenProbability: 0.3, gateHangoverMs: 100, gainTargetDbfs: -14, gainMaxDb: 0});
	});

	it('rounds the integer fields only', () => {
		expect(
			tuning({
				pipeline_v2_gate_open_probability: 0.615,
				pipeline_v2_gate_hangover_ms: 412.6,
				pipeline_v2_gain_target_dbfs: -26.6,
				pipeline_v2_gain_max_db: 19.4,
			}),
		).toMatchObject({gateOpenProbability: 0.615, gateHangoverMs: 413, gainTargetDbfs: -27, gainMaxDb: 19});
	});

	it('never lets the refresh probability exceed the open probability', () => {
		expect(tuning({pipeline_v2_gate_open_probability: 0.4, pipeline_v2_gate_refresh_probability: 0.6})).toMatchObject({
			gateOpenProbability: 0.4,
			gateRefreshProbability: 0.4,
		});
		expect(tuning({pipeline_v2_gate_open_probability: 0.1, pipeline_v2_gate_refresh_probability: 0.95})).toMatchObject({
			gateOpenProbability: 0.3,
			gateRefreshProbability: 0.3,
		});
		expect(tuning({pipeline_v2_gate_open_probability: 0.7, pipeline_v2_gate_refresh_probability: 0.6})).toMatchObject({
			gateOpenProbability: 0.7,
			gateRefreshProbability: 0.6,
		});
	});

	it('falls back to the default for a missing or NaN value', () => {
		const {pipeline_v2_gate_hangover_ms: _hangover, ...missing} = INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT;
		expect(resolveVoicePipelineTuning(missing as VoiceNoiseSuppressionAssignmentResponse)).toEqual(
			VOICE_PIPELINE_TUNING,
		);
		expect(
			tuning({
				pipeline_v2_gate_open_probability: Number.NaN,
				pipeline_v2_gate_refresh_probability: Number.NaN,
				pipeline_v2_gate_hangover_ms: Number.NaN,
				pipeline_v2_gain_target_dbfs: Number.NaN,
				pipeline_v2_gain_max_db: Number.NaN,
			}),
		).toEqual(VOICE_PIPELINE_TUNING);
	});
});

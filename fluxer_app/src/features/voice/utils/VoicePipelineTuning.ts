// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	VOICE_PIPELINE_V2_TUNING_LIMITS,
	type VoiceNoiseSuppressionAssignmentResponse,
} from '@fluxer/schema/src/domains/admin/VoiceNoiseSuppressionSchemas';

const LIMITS = VOICE_PIPELINE_V2_TUNING_LIMITS;

export const VOICE_PIPELINE_TUNING = {
	highpassHz: 100,
	highpassQ: -3.0102999566,
	gateOpenProbability: LIMITS.gate_open_probability.default,
	gateRefreshProbability: LIMITS.gate_refresh_probability.default,
	gateHangoverMs: LIMITS.gate_hangover_ms.default,
	gateLookaheadMs: 10,
	gateHighpassHz: 150,
	gateLowpassHz: 4000,
	gainMaxDb: LIMITS.gain_max_db.default,
	gainTargetDbfs: LIMITS.gain_target_dbfs.default,
	gainRiseDbPerSecond: 6,
	gainFallDbPerSecond: 12,
	gainTimeConstantSeconds: 0.2,
} as const;

export type VoicePipelineTuning = {readonly [Key in keyof typeof VOICE_PIPELINE_TUNING]: number};

function bounded(value: number, limit: {min: number; max: number; default: number}, integer = false): number {
	if (!Number.isFinite(value)) return limit.default;
	return Math.min(limit.max, Math.max(limit.min, integer ? Math.round(value) : value));
}

export function resolveVoicePipelineTuning(assignment: VoiceNoiseSuppressionAssignmentResponse): VoicePipelineTuning {
	const gateOpenProbability = bounded(assignment.pipeline_v2_gate_open_probability, LIMITS.gate_open_probability);
	return {
		...VOICE_PIPELINE_TUNING,
		gateOpenProbability,
		gateRefreshProbability: Math.min(
			gateOpenProbability,
			bounded(assignment.pipeline_v2_gate_refresh_probability, LIMITS.gate_refresh_probability),
		),
		gateHangoverMs: bounded(assignment.pipeline_v2_gate_hangover_ms, LIMITS.gate_hangover_ms, true),
		gainTargetDbfs: bounded(assignment.pipeline_v2_gain_target_dbfs, LIMITS.gain_target_dbfs, true),
		gainMaxDb: bounded(assignment.pipeline_v2_gain_max_db, LIMITS.gain_max_db, true),
	};
}

export function isSameVoicePipelineTuning(a: VoicePipelineTuning, b: VoicePipelineTuning): boolean {
	return (Object.keys(a) as Array<keyof VoicePipelineTuning>).every((key) => a[key] === b[key]);
}

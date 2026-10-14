// SPDX-License-Identifier: AGPL-3.0-or-later

import ExperimentAssignments from '@app/features/experiment/state/ExperimentAssignments';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {
	resolveVoiceNoiseSuppressionForCall,
	type VoiceNoiseSuppressionAssignmentResponse,
	type VoiceNoiseSuppressionBackend,
	type VoiceNoiseSuppressionResolution,
} from '@fluxer/schema/src/domains/admin/VoiceNoiseSuppressionSchemas';
import {readVoiceNoiseSuppressionAssignment} from '@fluxer/schema/src/domains/experiment/ExperimentSchemas';

const logger = new Logger('VoiceNoiseSuppressionRollout');

class VoiceNoiseSuppressionRolloutSelector {
	constructor() {
		void import('@app/features/voice/utils/noise_suppression/NoiseSuppressionRuntime')
			.then(({bindVoicePipelineV2Prefetch}) => bindVoicePipelineV2Prefetch())
			.catch((error: unknown) => logger.warn('Failed to initialize noise suppression prefetch', {error}));
	}

	get assignment(): VoiceNoiseSuppressionAssignmentResponse {
		return readVoiceNoiseSuppressionAssignment(ExperimentAssignments.response);
	}

	resolveForCall(
		guildId: string | null,
		userPreference: VoiceNoiseSuppressionBackend | null,
	): VoiceNoiseSuppressionResolution | null {
		try {
			return resolveVoiceNoiseSuppressionForCall(this.assignment, guildId, userPreference);
		} catch (err) {
			logger.warn('Failed to resolve noise suppression for call:', err);
			return null;
		}
	}
}

export const VoiceNoiseSuppressionRollout = new VoiceNoiseSuppressionRolloutSelector();

export default VoiceNoiseSuppressionRollout;

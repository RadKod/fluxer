// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
	ILiveKitService,
	ListParticipantsResult,
	SetParticipantAttributesParams,
	UpdateRoomMetadataParams,
} from '@app/api/infrastructure/ILiveKitService';
import type {VoiceRegionMetadata, VoiceServerRecord} from '@app/api/voice/VoiceModel';

export class DisabledLiveKitService implements ILiveKitService {
	async createToken(): Promise<{
		token: string;
		endpoint: string;
	}> {
		throw new Error('Voice is disabled');
	}

	async updateParticipant(): Promise<void> {}

	async updateParticipantPermissions(): Promise<void> {}

	async muteMicrophoneTrack(): Promise<void> {}

	async disconnectParticipant(): Promise<void> {}

	async setParticipantAttributes(_params: SetParticipantAttributesParams): Promise<'ok'> {
		return 'ok';
	}

	async updateRoomMetadata(_params: UpdateRoomMetadataParams): Promise<'ok'> {
		return 'ok';
	}

	async listParticipants(): Promise<ListParticipantsResult> {
		return {status: 'ok', participants: []};
	}

	getDefaultRegionId(): string | null {
		return null;
	}

	getRegionMetadata(): Array<VoiceRegionMetadata> {
		return [];
	}

	getServer(): VoiceServerRecord | null {
		return null;
	}
}

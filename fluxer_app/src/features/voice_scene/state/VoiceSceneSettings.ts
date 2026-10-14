// SPDX-License-Identifier: AGPL-3.0-or-later

import {makePersistent} from '@app/features/platform/utils/MobXPersistence';
import {makeAutoObservable} from 'mobx';

export type VoiceSceneFailure = 'context_lost' | 'load_failed';

// Per-device choices for the 3D voice room; `failure` lives only for this session.
class VoiceSceneSettingsState {
	preferRoom = true;
	spatialAudio = true;
	// Cameras on avatars inside the room (on by default, like the flat call view).
	showRoomCameras = true;
	failure: VoiceSceneFailure | null = null;

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
		void makePersistent(this, 'VoiceSceneSettings', ['preferRoom', 'spatialAudio', 'showRoomCameras']);
	}

	setPreferRoom(preferRoom: boolean): void {
		this.preferRoom = preferRoom;
	}

	setSpatialAudio(spatialAudio: boolean): void {
		this.spatialAudio = spatialAudio;
	}

	setShowRoomCameras(showRoomCameras: boolean): void {
		this.showRoomCameras = showRoomCameras;
	}

	// The room falls back to the flat call view; the voice connection is not touched.
	reportFailure(failure: VoiceSceneFailure): void {
		this.failure = failure;
	}

	retry(): void {
		this.failure = null;
		this.preferRoom = true;
	}
}

export default new VoiceSceneSettingsState();

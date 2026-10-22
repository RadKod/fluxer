// SPDX-License-Identifier: AGPL-3.0-or-later

import type {VoiceMusicProcessing} from '@app/features/voice/utils/VoiceProcessingProfile';
import {makeAutoObservable, reaction} from 'mobx';

// A processing choice laid over the saved voice settings for a while, never saved itself: a reload or a crash drops
// it and the mic is back on the user's own settings. The band game sets music processing for its singer during a song.
class VoiceProcessingOverrideState {
	music: VoiceMusicProcessing | null = null;

	constructor() {
		makeAutoObservable(this, {subscribe: false}, {autoBind: true});
	}

	setMusic(music: VoiceMusicProcessing | null): void {
		this.music = music;
	}

	subscribe(listener: () => void): () => void {
		return reaction(() => this.music, listener);
	}
}

export default new VoiceProcessingOverrideState();

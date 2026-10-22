// SPDX-License-Identifier: AGPL-3.0-or-later

import {makePersistent} from '@app/features/platform/utils/MobXPersistence';
import {makeAutoObservable} from 'mobx';

// The rhythm guitar's sound: distorted power chords or the clean tone, one note per lane either way.
export type JamRhythmTone = 'power' | 'clean';

// Per device, like the band settings: how I like my jam screen and my rhythm guitar.
class JamSettingsState {
	// The key box on the right, folded down to its header.
	infoCollapsed = false;
	rhythmTone: JamRhythmTone = 'power';

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
		void makePersistent(this, 'BandJamSettings', ['infoCollapsed', 'rhythmTone']);
	}

	setInfoCollapsed(collapsed: boolean): void {
		this.infoCollapsed = collapsed;
	}

	setRhythmTone(tone: JamRhythmTone): void {
		this.rhythmTone = tone;
	}
}

export default new JamSettingsState();

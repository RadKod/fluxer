// SPDX-License-Identifier: AGPL-3.0-or-later

import {makePersistent} from '@app/features/platform/utils/MobXPersistence';
import {makeAutoObservable} from 'mobx';

// Per-device game activity choices that never leave this device.
class GameActivityLocalSettingsState {
	// Spotify now playing rides on game activity: it only runs while game activity sharing is on.
	showSpotify = true;

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
		void makePersistent(this, 'GameActivityLocalSettings', ['showSpotify']);
	}

	setShowSpotify(showSpotify: boolean): void {
		this.showSpotify = showSpotify;
	}
}

export default new GameActivityLocalSettingsState();

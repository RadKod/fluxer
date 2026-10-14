// SPDX-License-Identifier: AGPL-3.0-or-later

import {VOICE_ROOM_CONTROL_DISCOVERY_STORAGE_KEY} from '@app/features/platform/state/PersistentStorage';
import {makePersistent} from '@app/features/platform/utils/MobXPersistence';
import {makeAutoObservable} from 'mobx';

class VoiceRoomControlDiscoveryState {
	dismissed = false;
	shimmerShown = false;

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
		void makePersistent(this, VOICE_ROOM_CONTROL_DISCOVERY_STORAGE_KEY, ['dismissed', 'shimmerShown'], {
			syncAcrossTabs: true,
		});
	}

	dismiss(): void {
		this.dismissed = true;
	}

	markShimmerShown(): void {
		this.shimmerShown = true;
	}
}

export default new VoiceRoomControlDiscoveryState();

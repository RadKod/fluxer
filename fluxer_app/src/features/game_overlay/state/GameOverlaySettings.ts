// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GameOverlayMode} from '@app/features/game_overlay/utils/GameOverlayModel';
import {makePersistent} from '@app/features/platform/utils/MobXPersistence';
import type {DesktopGameOverlayCorner} from '@app/types/electron.d';
import {makeAutoObservable} from 'mobx';

class GameOverlaySettingsState {
	enabled = false;
	mode: GameOverlayMode = 'speaking';
	corner: DesktopGameOverlayCorner = 'top-left';

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
		void makePersistent(this, 'GameOverlaySettings', ['enabled', 'mode', 'corner']);
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	setMode(mode: GameOverlayMode): void {
		this.mode = mode;
	}

	setCorner(corner: DesktopGameOverlayCorner): void {
		this.corner = corner;
	}
}

export default new GameOverlaySettingsState();

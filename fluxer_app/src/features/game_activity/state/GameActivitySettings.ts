// SPDX-License-Identifier: AGPL-3.0-or-later

import AppStorage from '@app/features/platform/state/PersistentStorage';
import {Logger} from '@app/features/platform/utils/AppLogger';
import UserSettings from '@app/features/user/state/UserSettings';
import Users from '@app/features/user/state/Users';
import {getEffectiveProfilePrivacy} from '@app/features/user/utils/ProfilePrivacyUtils';
import {ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';
import {makeAutoObservable} from 'mobx';

const logger = new Logger('GameActivitySettings');

export class GameActivitySettingsState {
	private detection = new Map<string, boolean>();
	private unconfirmedSharing = new Set<string>();

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
	}

	getDetectionEnabled(accountId: string): boolean {
		if (this.detection.has(accountId)) return this.detection.get(accountId) === true;
		try {
			return AppStorage.getItem(`GameActivity:detection:${accountId}`) === 'true';
		} catch (error) {
			logger.warn('Failed to read game detection preference:', error);
			return false;
		}
	}

	setDetectionEnabled(accountId: string, enabled: boolean): void {
		// Micup: local storage belongs to this device; only the account preference is saved.
		if (enabled) AppStorage.setItem(`GameActivity:detection:${accountId}`, 'true');
		else AppStorage.removeItem(`GameActivity:detection:${accountId}`);
		this.detection.set(accountId, enabled);
	}

	getEffectiveSharing(): boolean {
		return (
			UserSettings.isHydrated() &&
			Users.currentUser?.publicProfileAllowed === true &&
			!Users.currentUser.bot &&
			!this.unconfirmedSharing.has(Users.currentUser.id) &&
			UserSettings.getGameActivityVisibility() === 'friends' &&
			getEffectiveProfilePrivacy() !== ProfilePrivacyLevels.ONLY_ME
		);
	}

	setSharingUnconfirmed(accountId: string, unconfirmed: boolean): void {
		if (unconfirmed) this.unconfirmedSharing.add(accountId);
		else this.unconfirmedSharing.delete(accountId);
	}
}

export default new GameActivitySettingsState();

// SPDX-License-Identifier: AGPL-3.0-or-later

import UserSettings from '@app/features/user/state/UserSettings';
import Users from '@app/features/user/state/Users';
import {getEffectiveProfilePrivacy} from '@app/features/user/utils/ProfilePrivacyUtils';
import {ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';
import {makeAutoObservable} from 'mobx';

export class GameActivitySettingsState {
	private unconfirmedSharing = new Set<string>();

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
	}

	getEffectiveSharing(): boolean {
		const visibility = UserSettings.getGameActivityVisibility();
		return (
			UserSettings.isHydrated() &&
			UserSettings.getGameActivityEligible() &&
			!!Users.currentUser &&
			!Users.currentUser.bot &&
			!this.unconfirmedSharing.has(Users.currentUser.id) &&
			(visibility === 'friends' || visibility === 'everyone') &&
			getEffectiveProfilePrivacy() !== ProfilePrivacyLevels.ONLY_ME
		);
	}

	setSharingUnconfirmed(accountId: string, unconfirmed: boolean): void {
		if (unconfirmed) this.unconfirmedSharing.add(accountId);
		else this.unconfirmedSharing.delete(accountId);
	}
}

export default new GameActivitySettingsState();

// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import GameActivitySettings from '@app/features/game_activity/state/GameActivitySettings';
import DesktopGameActivityBridge from '@app/features/game_activity/utils/DesktopGameActivityBridge';
import {http} from '@app/features/platform/transport/RestTransport';
import type {UserSettings} from '@app/features/user/state/UserSettings';
import UserSettingsState from '@app/features/user/state/UserSettings';
import Users from '@app/features/user/state/Users';
import {ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';

export type UserSettingsPatch = Partial<UserSettings>;
const gameSharingChanges = new Map<string, number>();

function assertCurrentGameSharingChange(accountId: string, change: number, epoch: number): void {
	if (Users.currentUser?.id !== accountId || UserSettingsState.getAccountEpoch() !== epoch)
		throw new Error('Account changed while saving game sharing');
	if (gameSharingChanges.get(accountId) !== change) throw new Error('Game sharing change was superseded');
}

async function persistUserSettings(settings: UserSettingsPatch): Promise<unknown> {
	return UserSettingsState.saveSettings(settings);
}

export async function update(settings: UserSettingsPatch): Promise<void> {
	if (settings.gameActivityVisibility !== undefined) {
		await updateGameActivityVisibility(settings.gameActivityVisibility);
		const {gameActivityVisibility: _, ...remaining} = settings;
		if (Object.keys(remaining).length > 0) await update(remaining);
		return;
	}
	const accountId = Users.currentUser?.id;
	if (settings.profilePrivacy === undefined) {
		await persistUserSettings(settings);
		return;
	}
	if (!accountId) throw new Error('No authenticated account');
	const epoch = UserSettingsState.getAccountEpoch();
	const change = (gameSharingChanges.get(accountId) ?? 0) + 1;
	gameSharingChanges.set(accountId, change);
	GameActivitySettings.setSharingUnconfirmed(accountId, true);
	await DesktopGameActivityBridge.stopSharing();
	assertCurrentGameSharingChange(accountId, change, epoch);
	const response = await persistUserSettings(settings);
	assertCurrentGameSharingChange(accountId, change, epoch);
	if (
		!response ||
		typeof response !== 'object' ||
		!('profile_privacy' in response) ||
		response.profile_privacy !== settings.profilePrivacy
	)
		throw new Error('Profile privacy was not confirmed');
	UserSettingsState.updateUserSettings(response, {
		hydrate: false,
		fields: [
			'profilePrivacy',
			...('game_activity_visibility' in response && response.game_activity_visibility === 'off'
				? ['gameActivityVisibility' as const]
				: []),
		],
	});
	GameActivitySettings.setSharingUnconfirmed(accountId, false);
	await DesktopGameActivityBridge.refreshPolicy();
	assertCurrentGameSharingChange(accountId, change, epoch);
}

export async function updateGameActivityVisibility(visibility: 'off' | 'friends'): Promise<void> {
	const accountId = Users.currentUser?.id;
	if (!accountId) throw new Error('No authenticated account');
	const epoch = UserSettingsState.getAccountEpoch();
	const change = (gameSharingChanges.get(accountId) ?? 0) + 1;
	gameSharingChanges.set(accountId, change);
	GameActivitySettings.setSharingUnconfirmed(accountId, true);
	// Micup: stopping detection precedes the server revocation barrier and survives uncertain saves.
	await DesktopGameActivityBridge.stopSharing();
	assertCurrentGameSharingChange(accountId, change, epoch);
	try {
		const response = await http.patch<{game_activity_visibility?: 'off' | 'friends'; profile_privacy?: number}>(
			Endpoints.USER_SETTINGS,
			{
				body: {game_activity_visibility: visibility},
			},
		);
		assertCurrentGameSharingChange(accountId, change, epoch);
		if (response.body.game_activity_visibility !== visibility) throw new Error('Game sharing was not confirmed');
		UserSettingsState.updateUserSettings(response.body, {
			hydrate: false,
			fields: [
				'gameActivityVisibility',
				...(response.body.profile_privacy === ProfilePrivacyLevels.ONLY_ME ? ['profilePrivacy' as const] : []),
			],
		});
		GameActivitySettings.setSharingUnconfirmed(accountId, false);
		await DesktopGameActivityBridge.refreshPolicy();
		assertCurrentGameSharingChange(accountId, change, epoch);
	} catch (error) {
		if (
			Users.currentUser?.id === accountId &&
			UserSettingsState.getAccountEpoch() === epoch &&
			gameSharingChanges.get(accountId) === change
		) {
			try {
				const response = await http.get<{game_activity_visibility?: 'off' | 'friends'; profile_privacy?: number}>(
					Endpoints.USER_SETTINGS,
				);
				assertCurrentGameSharingChange(accountId, change, epoch);
				UserSettingsState.updateUserSettings(response.body, {
					hydrate: false,
					fields: [
						'gameActivityVisibility',
						...(response.body.profile_privacy === ProfilePrivacyLevels.ONLY_ME ? ['profilePrivacy' as const] : []),
					],
				});
			} catch {
				// Micup: the original save error remains actionable; the producer stays stopped.
			}
		}
		throw error;
	}
}

export async function updateVoiceActivitySharingDefault(value: boolean): Promise<void> {
	await http.put(Endpoints.USER_VOICE_ACTIVITY_SHARING, {body: {share_voice_activity: value}});
}

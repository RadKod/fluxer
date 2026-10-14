// SPDX-License-Identifier: AGPL-3.0-or-later

import {Nagbar} from '@app/features/app/components/layout/Nagbar';
import {NagbarButton} from '@app/features/app/components/layout/NagbarButton';
import {NagbarContent} from '@app/features/app/components/layout/NagbarContent';
import {NAGBAR_TONES, NagbarToneKind} from '@app/features/app/components/layout/NagbarTones';
import {OPEN_SETTINGS_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import * as NagbarCommands from '@app/features/ui/commands/NagbarCommands';
import {UserSettingsModal} from '@app/features/user/components/modals/UserSettingsModal';
import UserSettings from '@app/features/user/state/UserSettings';
import {type ProfilePrivacyLevel, ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';

const SMALL_COMMUNITIES_GONE_DESCRIPTOR = msg({
	message:
		'Profile privacy options have changed: "Friends and small communities only" is gone. Your profile is now on "Shared communities": your friends, people you follow each other with and members of communities you share can see it.',
	comment:
		'Micup nagbar for a user whose profile privacy was the removed "Friends and small communities only" option; it now reads as "Shared communities". The quoted names are option labels in Privacy settings. Legal-effect text: approved before release.',
});
const FRIENDS_NOW_INCLUDE_MUTUALS_DESCRIPTOR = msg({
	message:
		'Profile privacy options have changed: "Friends only" is now "Friends and mutual follows". People you follow each other with can see your profile too.',
	comment:
		'Micup nagbar for a user whose profile privacy was "Friends only", which now also lets mutual follows (people who follow each other) see the profile. The quoted names are option labels in Privacy settings. Legal-effect text: approved before release.',
});

// Micup: the old small-communities (1) and friends-only (2) settings widened at release; their
// owners are told once. An explicit choice in Privacy settings also dismisses it (ProfilePrivacyTab).
export function canShowProfilePrivacyWidened(profilePrivacy: ProfilePrivacyLevel | null, dismissed: boolean): boolean {
	return (
		(profilePrivacy === ProfilePrivacyLevels.SMALL_GUILDS_ONLY ||
			profilePrivacy === ProfilePrivacyLevels.FRIENDS_ONLY) &&
		!dismissed
	);
}

export const ProfilePrivacyChangedNagbar = observer(({isMobile}: {isMobile: boolean}) => {
	const {i18n} = useLingui();
	const message =
		UserSettings.getProfilePrivacy() === ProfilePrivacyLevels.SMALL_GUILDS_ONLY
			? SMALL_COMMUNITIES_GONE_DESCRIPTOR
			: FRIENDS_NOW_INCLUDE_MUTUALS_DESCRIPTOR;
	const handleOpenSettings = () => {
		ModalCommands.push(
			modal(() => (
				<UserSettingsModal
					initialTab="privacy_safety"
					initialSubtab="profile-privacy"
					data-flx="app.app-layout.nagbars.profile-privacy-changed-nagbar.handle-open-settings.user-settings-modal"
				/>
			)),
		);
	};
	const handleDismiss = () => {
		NagbarCommands.dismissNagbar('profilePrivacyWidenedDismissed');
	};
	return (
		<Nagbar
			isMobile={isMobile}
			backgroundColor={NAGBAR_TONES[NagbarToneKind.BRAND].backgroundColor}
			textColor={NAGBAR_TONES[NagbarToneKind.BRAND].textColor}
			dismissible
			onDismiss={handleDismiss}
			data-flx="app.app-layout.nagbars.profile-privacy-changed-nagbar.nagbar"
		>
			<NagbarContent
				isMobile={isMobile}
				onDismiss={handleDismiss}
				message={i18n._(message)}
				actions={
					<NagbarButton
						isMobile={isMobile}
						onClick={handleOpenSettings}
						data-flx="app.app-layout.nagbars.profile-privacy-changed-nagbar.nagbar-button.open-settings"
					>
						{i18n._(OPEN_SETTINGS_DESCRIPTOR)}
					</NagbarButton>
				}
				data-flx="app.app-layout.nagbars.profile-privacy-changed-nagbar.nagbar-content"
			/>
		</Nagbar>
	);
});

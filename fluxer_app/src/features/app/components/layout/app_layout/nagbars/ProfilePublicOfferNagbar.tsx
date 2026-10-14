// SPDX-License-Identifier: AGPL-3.0-or-later

import {Nagbar} from '@app/features/app/components/layout/Nagbar';
import {NagbarButton} from '@app/features/app/components/layout/NagbarButton';
import {NagbarContent} from '@app/features/app/components/layout/NagbarContent';
import {NAGBAR_TONES, NagbarToneKind} from '@app/features/app/components/layout/NagbarTones';
import * as NagbarCommands from '@app/features/ui/commands/NagbarCommands';
import * as UserSettingsCommands from '@app/features/user/commands/UserSettingsCommands';
import {type ProfilePrivacyLevel, ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';

const PUBLIC_PROFILE_OFFER_DESCRIPTOR = msg({
	message:
		'Would you like to make your profile public? If you do, everyone signed in can see your profile. Your earlier posts marked public (most of what you shared while on "Shared communities") open to everyone too, and those from the last 72 hours can appear in Discover.',
	comment:
		'sanalyer one-time nagbar offering a public profile. It must say that earlier posts marked public open to everyone and that the last 72 hours of them can appear in Discover. "Shared communities" is an option label in Privacy settings. Legal-effect text: approved before release.',
});
const MAKE_IT_PUBLIC_DESCRIPTOR = msg({
	message: 'Make it public',
	comment: 'Button on the public profile offer nagbar. Sets the profile visibility to Everyone.',
});
const NOT_NOW_DESCRIPTOR = msg({
	message: 'Not now',
	comment: 'Button on the public profile offer nagbar. Closes the offer for good without changing anything.',
});

// Micup: a one-time public profile offer, after the change notice, never to "only me" or under 16.
export function canShowProfilePublicOffer(params: {
	profilePrivacy: ProfilePrivacyLevel | null;
	publicProfileAllowed: boolean;
	dismissed: boolean;
	widenedShown: boolean;
}): boolean {
	const {profilePrivacy} = params;
	return (
		profilePrivacy !== null &&
		!params.widenedShown &&
		profilePrivacy !== ProfilePrivacyLevels.EVERYONE &&
		profilePrivacy !== ProfilePrivacyLevels.ONLY_ME &&
		params.publicProfileAllowed &&
		!params.dismissed
	);
}

// Nothing is preselected: both answers are the same kind of button, and closing the bar counts as "not now".
export const ProfilePublicOfferNagbar = observer(({isMobile}: {isMobile: boolean}) => {
	const {i18n} = useLingui();
	const handleDismiss = () => {
		NagbarCommands.dismissNagbar('profilePublicOfferDismissed');
	};
	// Dismissed only once the server took the level; a refused write (UserSettings logs it and rolls the level back)
	// leaves the offer up.
	const handleAccept = async () => {
		try {
			await UserSettingsCommands.update({profilePrivacy: ProfilePrivacyLevels.EVERYONE});
		} catch {
			return;
		}
		handleDismiss();
	};
	return (
		<Nagbar
			isMobile={isMobile}
			backgroundColor={NAGBAR_TONES[NagbarToneKind.BRAND].backgroundColor}
			textColor={NAGBAR_TONES[NagbarToneKind.BRAND].textColor}
			dismissible
			onDismiss={handleDismiss}
			data-flx="app.app-layout.nagbars.profile-public-offer-nagbar.nagbar"
		>
			<NagbarContent
				isMobile={isMobile}
				onDismiss={handleDismiss}
				message={i18n._(PUBLIC_PROFILE_OFFER_DESCRIPTOR)}
				actions={
					<>
						<NagbarButton
							isMobile={isMobile}
							onClick={handleDismiss}
							data-flx="app.app-layout.nagbars.profile-public-offer-nagbar.nagbar-button.not-now"
						>
							{i18n._(NOT_NOW_DESCRIPTOR)}
						</NagbarButton>
						<NagbarButton
							isMobile={isMobile}
							onClick={handleAccept}
							data-flx="app.app-layout.nagbars.profile-public-offer-nagbar.nagbar-button.make-public"
						>
							{i18n._(MAKE_IT_PUBLIC_DESCRIPTOR)}
						</NagbarButton>
					</>
				}
				data-flx="app.app-layout.nagbars.profile-public-offer-nagbar.nagbar-content"
			/>
		</Nagbar>
	);
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {SettingsTabSection} from '@app/features/app/components/dialogs/shared/SettingsTabLayout';
import {PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import * as NagbarCommands from '@app/features/ui/commands/NagbarCommands';
import {RadioGroup} from '@app/features/ui/radio_group/RadioGroup';
import * as UserSettingsCommands from '@app/features/user/commands/UserSettingsCommands';
import Users from '@app/features/user/state/Users';
import {getEffectiveProfilePrivacy} from '@app/features/user/utils/ProfilePrivacyUtils';
import {type ProfilePrivacyLevel, ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import type React from 'react';

const PROFILE_PRIVACY_LABEL_DESCRIPTOR = msg({
	message: 'Profile privacy',
	comment: 'Privacy > Profile privacy: aria-label for the radio group controlling who sees the user profile.',
});
const WHO_CAN_SEE_YOUR_PROFILE_DESCRIPTOR = msg({
	message: 'Who can see your profile',
	comment: 'Privacy > Profile privacy: section title.',
});
// Micup: four options. The descriptions have legal effect and are approved before release. "Profile
// content" is the same under every option: bio and connections, follow lists and counts, posts and media, mutual friends
// and communities.
const EVERYONE_OPTION_DESCRIPTOR = msg({
	message: 'Everyone',
	context: 'profile-privacy',
	comment: 'Privacy > Profile privacy: radio option label making the full profile visible to every signed-in user.',
});
const EVERYONE_DESCRIPTION_DESCRIPTOR = msg({
	message:
		'Anyone signed in to {productName} can see your bio, follow lists, posts and media. New posts can appear in Discover.',
	comment:
		'Privacy > Profile privacy: helper text under the Everyone option. {productName} is the app name. Legal-effect text.',
});
const EVERYONE_AGE_DESCRIPTOR = msg({
	message: 'Available from age 16.',
	comment:
		'Privacy > Profile privacy: helper text under the disabled Everyone option for accounts under 16 or without a date of birth.',
});
const SHARED_COMMUNITIES_OPTION_DESCRIPTOR = msg({
	message: 'Shared communities',
	comment:
		'Privacy > Profile privacy: radio option label for friends, mutual follows and members of shared communities.',
});
const SHARED_COMMUNITIES_DESCRIPTION_DESCRIPTOR = msg({
	message: 'Your friends, people you follow each other with and members of communities you share.',
	comment: 'Privacy > Profile privacy: helper text under the Shared communities option. Legal-effect text.',
});
const FRIENDS_AND_MUTUALS_OPTION_DESCRIPTOR = msg({
	message: 'Friends and mutual follows',
	comment: 'Privacy > Profile privacy: radio option label for friends and people who follow each other.',
});
const FRIENDS_AND_MUTUALS_DESCRIPTION_DESCRIPTOR = msg({
	message: 'Only your friends and people you follow each other with.',
	comment: 'Privacy > Profile privacy: helper text under the Friends and mutual follows option. Legal-effect text.',
});
const ONLY_ME_OPTION_DESCRIPTOR = msg({
	message: 'Only me',
	comment: 'Privacy > Profile privacy: radio option label hiding the profile content from everyone else.',
});
const ONLY_ME_DESCRIPTION_DESCRIPTOR = msg({
	message:
		'Nobody else sees your profile content and nobody can start following you. Your name, avatar and banner still show in chats, and you still appear in the follower lists of accounts you follow, to anyone who can see those lists.',
	comment: 'Privacy > Profile privacy: helper text under the Only me option. Legal-effect text.',
});
const EARLIER_POSTS_NOTE_DESCRIPTOR = msg({
	message:
		'When your profile is public, your posts marked public open to everyone signed in — including earlier ones the app marked public while you were on shared communities — and those from the last 72 hours can appear in Discover. Posts not marked public never open to strangers. Limiting your profile closes them to strangers again.',
	comment:
		'Privacy > Profile privacy: note under the section title about posts. Until now the app marked most posts public on the shared communities setting. Legal-effect text.',
});
export const ProfilePrivacyTabContent: React.FC = observer(() => {
	const {i18n} = useLingui();
	// Micup: the level the server applies — the legacy small-communities value (never offered again) and a stored Everyone
	// under 16 read as shared communities.
	const profilePrivacy = getEffectiveProfilePrivacy();
	const publicAllowed = Users.currentUser?.publicProfileAllowed === true;
	const handleChange = async (value: ProfilePrivacyLevel) => {
		await UserSettingsCommands.update({profilePrivacy: value});
		// An explicit choice answers both privacy nagbars.
		NagbarCommands.dismissNagbar('profilePrivacyWidenedDismissed');
		NagbarCommands.dismissNagbar('profilePublicOfferDismissed');
	};
	return (
		<SettingsTabSection
			title={i18n._(WHO_CAN_SEE_YOUR_PROFILE_DESCRIPTOR)}
			description={i18n._(EARLIER_POSTS_NOTE_DESCRIPTOR)}
			data-flx="user.privacy-safety-tab.profile-privacy-tab.settings-tab-section"
		>
			<RadioGroup
				value={profilePrivacy}
				onChange={handleChange}
				aria-label={i18n._(PROFILE_PRIVACY_LABEL_DESCRIPTOR)}
				options={[
					{
						value: ProfilePrivacyLevels.EVERYONE,
						name: i18n._(EVERYONE_OPTION_DESCRIPTOR),
						desc: publicAllowed
							? i18n._(EVERYONE_DESCRIPTION_DESCRIPTOR, {productName: PRODUCT_NAME})
							: i18n._(EVERYONE_AGE_DESCRIPTOR),
						disabled: !publicAllowed,
					},
					{
						value: ProfilePrivacyLevels.ALL_GUILDS,
						name: i18n._(SHARED_COMMUNITIES_OPTION_DESCRIPTOR),
						desc: i18n._(SHARED_COMMUNITIES_DESCRIPTION_DESCRIPTOR),
					},
					{
						value: ProfilePrivacyLevels.FRIENDS_ONLY,
						name: i18n._(FRIENDS_AND_MUTUALS_OPTION_DESCRIPTOR),
						desc: i18n._(FRIENDS_AND_MUTUALS_DESCRIPTION_DESCRIPTOR),
					},
					{
						value: ProfilePrivacyLevels.ONLY_ME,
						name: i18n._(ONLY_ME_OPTION_DESCRIPTOR),
						desc: i18n._(ONLY_ME_DESCRIPTION_DESCRIPTOR),
					},
				]}
				data-flx="user.privacy-safety-tab.profile-privacy-tab.radio-group.profile-privacy-change"
			/>
		</SettingsTabSection>
	);
});

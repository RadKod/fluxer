// SPDX-License-Identifier: AGPL-3.0-or-later

import {CustomStatusDisplay} from '@app/features/app/components/shared/custom_status_display/CustomStatusDisplay';
import {UserTag} from '@app/features/channel/components/ChannelUserTag';
import {ProfilePostsButton} from '@app/features/feed/components/ProfilePostsButton';
import {ProfileFollowActions} from '@app/features/follow/components/ProfileFollowActions';
import {GameActivityDisplay} from '@app/features/game_activity/components/GameActivityDisplay';
import {NameStyleText} from '@app/features/name_style/components/NameStyleText';
import userProfileModalStyles from '@app/features/user/components/modals/UserProfileModal.module.css';
import type {UserInfoProps} from '@app/features/user/components/modals/user_profile_modal/UserProfileModalShared';
import {LimitedProfileNotice} from '@app/features/user/components/popouts/LimitedProfileNotice';
import {UserProfileBadges} from '@app/features/user/components/popouts/UserProfileBadges';
import {UserProfileDataWarning} from '@app/features/user/components/popouts/UserProfileDataWarning';
import {VerifiedUserBadge} from '@app/features/user/components/VerifiedUserBadge';
import {useAutoplayExpandedProfileAnimations} from '@app/features/user/hooks/useAutoplayExpandedProfileAnimations';
import {useProfileBadgeMetrics} from '@app/features/user/hooks/useProfileBadgeMetrics';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import {nameReadsOnProfileTheme, profileThemeColors} from '@app/features/user/utils/ProfileGradient';
import {
	getProfileMembershipDisplayName,
	resolveProfileGuildMembership,
} from '@app/features/user/utils/ProfileGuildMembership';
import {Trans} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useRef} from 'react';

export const UserInfo: React.FC<UserInfoProps> = observer((props) => {
	const {user, profile, guildId, showProfileDataWarning, onPage} = props;
	const membership = resolveProfileGuildMembership(profile);
	const displayName = getProfileMembershipDisplayName(user, membership, guildId);
	const displayNameRef = useRef<HTMLSpanElement>(null);
	const {badgeStyle, bindNameRef} = useProfileBadgeMetrics(displayNameRef, displayName);
	const effectiveProfile = profile?.getEffectiveProfile() ?? null;
	const shouldAutoplayProfileAnimations = useAutoplayExpandedProfileAnimations();
	return (
		<div
			className={clsx(userProfileModalStyles.userInfo, onPage && userProfileModalStyles.userInfoPage)}
			style={badgeStyle}
			data-flx="user.user-profile-modal.user-info.div"
		>
			<div
				className={clsx(userProfileModalStyles.userInfoHeader, userProfileModalStyles.userInfoHeaderDesktop)}
				data-flx="user.user-profile-modal.user-info.div--2"
			>
				<div className={userProfileModalStyles.userInfoContent} data-flx="user.user-profile-modal.user-info.div--3">
					{showProfileDataWarning && (
						<div
							className={userProfileModalStyles.profileDataWarning}
							data-flx="user.user-profile-modal.user-info.div--4"
						>
							<UserProfileDataWarning data-flx="user.user-profile-modal.user-info.user-profile-data-warning" />
						</div>
					)}
					{profile?.profileLimited && !onPage && (
						<div
							className={userProfileModalStyles.profileDataWarning}
							data-flx="user.user-profile-modal.user-info.profile-limited-notice"
						>
							<LimitedProfileNotice data-flx="user.user-profile-modal.user-profile-modal-user-info.user-info.limited-profile-notice" />
						</div>
					)}
					<div className={userProfileModalStyles.nameRow} data-flx="user.user-profile-modal.user-info.div--5">
						<NameStyleText
							ref={bindNameRef}
							nameStyle={user.nameStyle}
							fontOnly={!nameReadsOnProfileTheme(user.nameStyle, profileThemeColors(user, profile))}
							className={userProfileModalStyles.userName}
							data-flx="user.user-profile-modal.user-info.span"
						>
							{displayName}
						</NameStyleText>
						<VerifiedUserBadge user={user} size={20} data-flx="user.user-profile-modal.user-info.verified-user-badge" />
						{user.bot && (
							<UserTag
								className={userProfileModalStyles.userTag}
								system={user.system}
								size="lg"
								data-flx="user.user-profile-modal.user-info.user-tag"
							/>
						)}
					</div>
					<div className={userProfileModalStyles.badgesWrapper} data-flx="user.user-profile-modal.user-info.div--8">
						<UserProfileBadges
							user={user}
							profile={profile}
							isModal={true}
							isMobile={false}
							largeProfile={onPage}
							data-flx="user.user-profile-modal.user-info.user-profile-badges"
						/>
					</div>
					<div className={userProfileModalStyles.tagBadgeRow} data-flx="user.user-profile-modal.user-info.div--6">
						<div className={userProfileModalStyles.usernameRow} data-flx="user.user-profile-modal.user-info.div--7">
							{NicknameUtils.formatTagForStreamerMode(user.tag)}
						</div>
						{!onPage && (
							<>
								<ProfileFollowActions
									userId={user.id}
									hideFollowButton
									data-flx="user.user-profile-modal.user-info.profile-follow-actions"
								/>
								<ProfilePostsButton
									userId={user.id}
									data-flx="user.user-profile-modal.user-info.profile-posts-button"
								/>
							</>
						)}
					</div>
					{effectiveProfile?.pronouns && (
						<div className={userProfileModalStyles.pronouns} data-flx="user.user-profile-modal.user-info.div--9">
							<span className={userProfileModalStyles.srOnly} data-flx="user.user-profile-modal.user-info.span--2">
								<Trans>Pronouns: </Trans>
							</span>
							{effectiveProfile.pronouns}
						</div>
					)}
					<div className={userProfileModalStyles.customStatusRow} data-flx="user.user-profile-modal.user-info.div--10">
						<CustomStatusDisplay
							userId={user.id}
							className={userProfileModalStyles.customStatusText}
							showTooltip
							allowJumboEmoji
							maxLines={0}
							alwaysAnimate={shouldAutoplayProfileAnimations}
							data-flx="user.user-profile-modal.user-info.custom-status-display"
						/>
					</div>
					<GameActivityDisplay userId={user.id} />
				</div>
			</div>
		</div>
	);
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/feed/components/FeedProfileAside.module.css';
import {canFeedPostsBePublic} from '@app/features/feed/utils/FeedPrivacyUtils';
import {getUserAccentColor} from '@app/features/theme/utils/AccentColorUtils';
import {Button} from '@app/features/ui/button/Button';
import {Avatar} from '@app/features/ui/components/Avatar';
import {VerifiedUserBadge} from '@app/features/user/components/VerifiedUserBadge';
import UserProfile from '@app/features/user/state/UserProfile';
import Users from '@app/features/user/state/Users';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import * as ProfileDisplayUtils from '@app/features/user/utils/ProfileDisplayUtils';
import {createMockProfile} from '@app/features/user/utils/ProfileUtils';
import {MEDIA_PROXY_PROFILE_BANNER_SIZE_POPOUT} from '@fluxer/constants/src/MediaProxyAssetSizes';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import type {PropsWithChildren} from 'react';

const PROFILE_DESCRIPTOR = msg({
	message: 'Profile',
	comment: 'Accessible label of the card beside the feed that shows your own account.',
});
const YOUR_POSTS_DESCRIPTOR = msg({
	message: 'Your posts',
	comment: 'Button in the card beside the feed that opens the posts you published. Keep it concise.',
});
const PUBLIC_POSTS_NOTE_DESCRIPTOR = msg({
	message:
		'Your profile is public: anyone signed in can see your posts, and new ones can appear in Discover. If you limit your profile in Privacy, your posts close to strangers, and they leave Discover shortly after.',
	comment:
		'Small note under the profile card beside the feed, shown only while the profile visibility is Everyone (and Discover is on). Privacy is the settings section that limits who can see the profile; limiting it closes the posts to strangers on their next request, and Discover drops them within about half a minute, so do not say "at once". Discover picks popular posts, so a post may or may not appear.',
});

// Only the signed-in account: no profile request and no follow counts. The cover comes like
// UserAreaPopout's: the stored profile when one is loaded, else a mock one built from the account (no request either).
// Read on every render, not memoised: the rail stays mounted beside the feed, so a profile stored or changed later shows.
// Micup akis-oneri: the feed page puts the suggestions under the card as children; this card itself still
// sends no request.
export const FeedProfileAside = observer(({onShowPosts, children}: PropsWithChildren<{onShowPosts?: () => void}>) => {
	const {i18n} = useLingui();
	const user = Users.currentUser;
	if (!user) return null;
	const profile = UserProfile.getProfile(user.id) ?? createMockProfile(user);
	const {bannerUrl} = ProfileDisplayUtils.getProfileBannerUrls(
		{user, profile},
		undefined,
		MEDIA_PROXY_PROFILE_BANNER_SIZE_POPOUT,
	);
	const accentColor = getUserAccentColor(user, profile.getEffectiveProfile().accent_color);
	return (
		<aside className={styles.aside} aria-label={i18n._(PROFILE_DESCRIPTOR)} data-flx="feed.feed-profile-aside.aside">
			<div className={styles.card} data-flx="feed.feed-profile-aside.card">
				<div className={styles.cover} style={{backgroundColor: accentColor}} data-flx="feed.feed-profile-aside.cover">
					{bannerUrl && (
						<img
							className={styles.coverImage}
							src={bannerUrl}
							alt=""
							loading="lazy"
							data-flx="feed.feed-profile-aside.cover-image"
						/>
					)}
				</div>
				<div className={styles.profile} data-flx="feed.feed-profile-aside.profile">
					<Avatar user={user} size={80} className={styles.avatar} data-flx="feed.feed-profile-aside.avatar" />
					<div className={styles.names} data-flx="feed.feed-profile-aside.names">
						<div className={styles.nameRow} data-flx="feed.feed-profile-aside.name-row">
							<span className={styles.name} data-flx="feed.feed-profile-aside.name">
								{NicknameUtils.getNickname(user, null)}
							</span>
							<VerifiedUserBadge user={user} data-flx="feed.feed-profile-aside.verified-user-badge" />
						</div>
						<span className={styles.tag} data-flx="feed.feed-profile-aside.tag">
							{NicknameUtils.formatTagForStreamerMode(user.tag)}
						</span>
					</div>
					{onShowPosts && (
						<Button
							variant="secondary"
							small
							fitContainer
							className={styles.postsButton}
							onClick={onShowPosts}
							data-flx="feed.feed-profile-aside.button.show-posts"
						>
							{i18n._(YOUR_POSTS_DESCRIPTOR)}
						</Button>
					)}
				</div>
			</div>
			{canFeedPostsBePublic() && (
				<p className={styles.note} data-flx="feed.feed-profile-aside.note">
					{i18n._(PUBLIC_POSTS_NOTE_DESCRIPTOR)}
				</p>
			)}
			{children}
		</aside>
	);
});

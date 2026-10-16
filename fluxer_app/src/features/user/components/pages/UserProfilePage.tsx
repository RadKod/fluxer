// SPDX-License-Identifier: AGPL-3.0-or-later

import {showDmActionErrorModal} from '@app/features/app/components/alerts/DmActionErrorModal';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import Authentication from '@app/features/auth/state/Authentication';
import * as PrivateChannelCommands from '@app/features/channel/commands/PrivateChannelCommands';
import {DMPageFrame} from '@app/features/channel/components/direct_message/DMPageFrame';
import {ProfileEffectOverlay} from '@app/features/cosmetics/components/ProfileEffectOverlay';
import * as FeedCommands from '@app/features/feed/commands/FeedCommands';
import {FeedTimelineList} from '@app/features/feed/components/FeedTimelineList';
import FeedTimeline, {userTimelineKey} from '@app/features/feed/state/FeedTimeline';
import {isFeedEnabled} from '@app/features/feed/utils/FeedUtils';
import {FollowListModal} from '@app/features/follow/components/FollowListModal';
import {ProfileFollowButton} from '@app/features/follow/components/ProfileFollowActions';
import type {FollowListKind} from '@app/features/follow/state/FollowLists';
import {getFollowProfile} from '@app/features/follow/utils/FollowProfileUtils';
import {MORE_OPTIONS_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Logger} from '@app/features/platform/utils/AppLogger';
import Relationships from '@app/features/relationship/state/Relationships';
import * as RelationshipActionUtils from '@app/features/relationship/utils/RelationshipActionUtils';
import {
	ACCEPT_FRIEND_REQUEST_DESCRIPTOR,
	ADD_FRIEND_DESCRIPTOR,
	CANCEL_FRIEND_REQUEST_DESCRIPTOR,
	UNBLOCK_USER_ACTION_DESCRIPTOR,
} from '@app/features/relationship/utils/RelationshipMessageDescriptors';
import {getUserAccentColor} from '@app/features/theme/utils/AccentColorUtils';
import {UserContextMenu} from '@app/features/ui/action_menu/UserContextMenu';
import {Button} from '@app/features/ui/button/Button';
import * as ContextMenuCommands from '@app/features/ui/commands/ContextMenuCommands';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {Avatar} from '@app/features/ui/components/Avatar';
import type {ScrollerHandle} from '@app/features/ui/components/Scroller';
import {Tabs} from '@app/features/ui/tabs/Tabs';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import * as UserProfileCommands from '@app/features/user/commands/UserProfileCommands';
import {UserSettingsModal} from '@app/features/user/components/modals/UserSettingsModal';
import {ProfileBody} from '@app/features/user/components/modals/user_profile_modal/ProfileBody';
import {ProfileMediaHeader} from '@app/features/user/components/modals/user_profile_modal/ProfileMediaHeader';
import {UserInfo} from '@app/features/user/components/modals/user_profile_modal/UserProfileModalUserInfo';
import {ProfileMediaGrid} from '@app/features/user/components/pages/ProfileMediaGrid';
import styles from '@app/features/user/components/pages/UserProfilePage.module.css';
import {profileGradientSurface} from '@app/features/user/components/profile/ProfileGradientSurface';
import {UserProfileLoadingSkeleton} from '@app/features/user/components/profile/UserProfileLoadingSkeleton';
import {useUserProfileSurfaceState} from '@app/features/user/hooks/useUserProfileSurfaceState';
import type {Profile} from '@app/features/user/models/Profile';
import {User} from '@app/features/user/models/User';
import UserNote from '@app/features/user/state/UserNote';
import UserProfile from '@app/features/user/state/UserProfile';
import Users from '@app/features/user/state/Users';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import * as ProfileDisplayUtils from '@app/features/user/utils/ProfileDisplayUtils';
import {profileThemeColors} from '@app/features/user/utils/ProfileGradient';
import {resolveProfileGuildMembership, toProfileDisplayContext} from '@app/features/user/utils/ProfileGuildMembership';
import {createMockProfile} from '@app/features/user/utils/ProfileUtils';
import {
	MEDIA_PROXY_AVATAR_SIZE_PROFILE,
	MEDIA_PROXY_PROFILE_BANNER_SIZE_MODAL,
} from '@fluxer/constants/src/MediaProxyAssetSizes';
import {RelationshipTypes} from '@fluxer/constants/src/UserConstants';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {
	ChatTeardropIcon,
	CheckCircleIcon,
	ClockCounterClockwiseIcon,
	DotsThreeIcon,
	PencilIcon,
	ProhibitIcon,
	UserCircleIcon,
	UserPlusIcon,
} from '@phosphor-icons/react';
import {reaction} from 'mobx';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {type RefObject, useCallback, useEffect, useMemo, useRef, useState} from 'react';

const PROFILE_DESCRIPTOR = msg({
	message: 'Profile',
	comment: 'Title of the full profile page while the user name is not known (an unknown or hidden account).',
});
const USER_NOT_FOUND_DESCRIPTOR = msg({
	message: 'User not found',
	comment: 'Shown on the full profile page when the link points to no account, or to a deleted one.',
});
const YOU_CAN_T_SEE_THIS_PROFILE_DESCRIPTOR = msg({
	message: "You can't see this profile",
	comment:
		'Shown on the full profile page when the account shows its profile only to people it shares a friendship, follow or community with. Keep tone plain and not blaming.',
});
const LIMITED_PROFILE_DESCRIPTOR = msg({
	message: 'This person shows their profile only to certain people.',
	comment:
		'Shown on the full profile page under the name, in place of the posts and the about tab, when the account limits who sees its profile.',
});
const POSTS_TAB_DESCRIPTOR = msg({
	message: 'Posts',
	comment: 'Tab on the full profile page listing the feed posts of the user. Keep it concise.',
});
const MEDIA_TAB_DESCRIPTOR = msg({
	message: 'Media',
	comment: 'Tab on the full profile page showing the posts with pictures or a video as a grid. Keep it concise.',
});
const ABOUT_TAB_DESCRIPTOR = msg({
	message: 'About',
	comment:
		'Tab on the full profile page with the bio, connections, membership dates, the note and the mutual friends and communities. Keep it concise.',
});
const NO_POSTS_TO_SHOW_DESCRIPTOR = msg({
	message: 'No posts to show.',
	comment:
		"Empty state of the posts on someone else's full profile page: they have no posts, or none you are allowed to see.",
});
const NO_POSTS_YET_DESCRIPTOR = msg({
	message: 'No posts yet.',
	comment: 'Empty state of the posts list of a user.',
});
const FOLLOWERS_COUNT_DESCRIPTOR = msg({
	message: '{count, plural, one {# follower} other {# followers}}',
	comment:
		'Button on the full profile page that opens the followers list. {count} is how many accounts follow the user.',
});
const FOLLOWING_COUNT_DESCRIPTOR = msg({
	message: '{count, plural, one {# following} other {# following}}',
	comment:
		'Button on the full profile page that opens the list of accounts the user follows. {count} is how many accounts the user follows.',
});

const logger = new Logger('UserProfilePage');

type ProfilePageTab = 'posts' | 'media' | 'about';

// Micup: the full profile page at /users/<id>, built from the profile modal's parts. It asks for
// the profile without the mutual lists (60 s client cache, so usually none after the popup) and, only on a full or public
// profile, the first page of posts; the mutual lists come when About opens. No gateway subscription: counts change through
// FOLLOW_CREATE/DELETE as everywhere else.
// TEMPORARY: the server reads a popular profile's own partitions at most once a minute — the access decision,
// the owner side and the profile view stay 60 s in KV, the first page of posts 15 s. What stays hot is one KV
// key per profile: the side and the view have a 2 s copy per API process; the follow counts, feed:author_first and
// follow:set do not. Trigger: more than 50 K GET/s on one such key. Path: the same 2 s per-process copy for them.
export const UserProfilePage = observer(({userId}: {userId: string}) => {
	const {i18n} = useLingui();
	const scrollerRef = useRef<ScrollerHandle>(null);
	const valid = UserProfileCommands.isProfileId(userId);
	const user = valid ? Users.getUser(userId) : null;
	return (
		<DMPageFrame
			icon={UserCircleIcon}
			title={user ? NicknameUtils.getNickname(user, null) : i18n._(PROFILE_DESCRIPTOR)}
			bodyClassName={styles.body}
			scrollerRef={scrollerRef}
			data-flx="user.user-profile-page.dm-page-frame"
		>
			{valid ? (
				<ProfilePageContent
					key={userId}
					userId={userId}
					scrollerRef={scrollerRef}
					data-flx="user.user-profile-page.profile-page-content"
				/>
			) : (
				<ProfilePageMessage kind="not_found" data-flx="user.user-profile-page.profile-page-message" />
			)}
		</DMPageFrame>
	);
});

const ProfilePageContent = observer(
	({userId, scrollerRef}: {userId: string; scrollerRef: RefObject<ScrollerHandle | null>}) => {
		const pageRef = useRef<HTMLDivElement>(null);
		const storeUser = Users.getUser(userId);
		const fallbackUser = useMemo(
			() =>
				new User({
					id: userId,
					username: userId,
					discriminator: '0000',
					global_name: null,
					avatar: null,
					avatar_color: null,
					flags: 0,
				}),
			[userId],
		);
		const user = storeUser ?? fallbackUser;
		const fallbackProfile = useMemo(() => createMockProfile(user), [user]);
		const {
			profile: loadedProfile,
			profileLoadError,
			profileLoadStatus,
			showProfileSkeleton,
		} = useUserProfileSurfaceState({userId, enabled: true, withMutuals: false, fallbackProfile});
		// The client keeps a profile 60 s and drops it sooner when it changes; the page outlives both, and the Follow button
		// and the counts read that cache. So a dropped profile is asked for again, as the page had it (with or without the
		// mutual lists).
		// TEMPORARY: a page open past 60 s asks once a minute (no mutual lists, the server answers from KV); a hold in the
		// UserProfile store would need none — add it if open profile pages show in the profile route's request rate.
		useEffect(
			() =>
				reaction(
					() => UserProfile.getProfile(userId),
					(current, previous) => {
						if (current || !previous) return;
						UserProfileCommands.fetch(userId, undefined, false, {withMutuals: previous.mutualsLoaded}).catch((error) =>
							logger.warn(`Failed to load the profile of ${userId} again:`, error),
						);
					},
				),
			[userId],
		);
		// About asks again with the mutual lists, and a follow updates the cached profile; the store has the newest.
		const profile = UserProfile.getProfile(userId) ?? loadedProfile;
		if (profileLoadStatus === 400 || profileLoadStatus === 404) {
			return <ProfilePageMessage kind="not_found" data-flx="user.user-profile-page.content.not-found" />;
		}
		if (profileLoadStatus === 403) {
			return (
				<ProfilePageMessage kind="forbidden" user={storeUser} data-flx="user.user-profile-page.content.forbidden" />
			);
		}
		if (showProfileSkeleton || !profile) {
			return <UserProfileLoadingSkeleton variant="modal" data-flx="user.user-profile-page.content.skeleton" />;
		}
		// A limited profile, or one that failed to load, asks for no posts or lists.
		const showContent = !profileLoadError && !profile.profileLimited;
		return (
			<div ref={pageRef} className={styles.page} data-flx="user.user-profile-page.content.page">
				<ProfilePageHeader
					user={user}
					profile={profile}
					showProfileDataWarning={profileLoadError}
					showFollowStats={showContent}
					data-flx="user.user-profile-page.content.header"
				/>
				{profile.profileLimited && (
					<ProfilePageMessage kind="limited" data-flx="user.user-profile-page.content.limited" />
				)}
				{showContent && (
					<ProfilePageTabs
						user={user}
						profile={profile}
						scrollerRef={scrollerRef}
						pageRef={pageRef}
						data-flx="user.user-profile-page.content.tabs"
					/>
				)}
			</div>
		);
	},
);

const ProfilePageHeader = observer(
	({
		user,
		profile,
		showProfileDataWarning,
		showFollowStats,
	}: {
		user: User;
		profile: Profile;
		showProfileDataWarning: boolean;
		showFollowStats: boolean;
	}) => {
		const membership = resolveProfileGuildMembership(profile);
		const renderActions = useCallback(
			() => <ProfilePageActions user={user} data-flx="user.user-profile-page.content.actions" />,
			[user],
		);
		const profileContext = useMemo(
			() => toProfileDisplayContext({user, profile, membership, guildMemberProfile: profile.guildMemberProfile}),
			[user, profile, membership],
		);
		const {avatarUrl, hoverAvatarUrl} = ProfileDisplayUtils.getProfileAvatarUrls(
			profileContext,
			undefined,
			MEDIA_PROXY_AVATAR_SIZE_PROFILE,
		);
		const {bannerUrl, hoverBannerUrl} = ProfileDisplayUtils.getProfileBannerUrls(
			profileContext,
			undefined,
			MEDIA_PROXY_PROFILE_BANNER_SIZE_MODAL,
		);
		const gradient = profileGradientSurface(profileThemeColors(user, profile));
		return (
			<div
				className={clsx(styles.card, gradient?.className)}
				style={gradient?.style}
				data-flx="user.user-profile-page.header.card"
			>
				<ProfileMediaHeader
					user={user}
					profile={profile}
					profileContext={profileContext}
					bannerColor={getUserAccentColor(user, profile.getEffectiveProfile()?.accent_color)}
					bannerUrl={bannerUrl}
					hoverBannerUrl={hoverBannerUrl}
					avatarUrl={avatarUrl}
					hoverAvatarUrl={hoverAvatarUrl}
					renderActionButtons={renderActions}
					identity={
						<div className={styles.identity} data-flx="user.user-profile-page.header.identity">
							<UserInfo
								user={user}
								profile={profile}
								showProfileDataWarning={showProfileDataWarning}
								isPreview={false}
								onPage
								data-flx="user.user-profile-page.header.user-info"
							/>
							{showFollowStats && (
								<ProfileFollowStats userId={user.id} data-flx="user.user-profile-page.content.stats" />
							)}
						</div>
					}
					data-flx="user.user-profile-page.header.profile-media-header"
				/>
				<ProfileEffectOverlay effect={profile.profileEffect} data-flx="user.user-profile-page.header.effect-overlay" />
			</div>
		);
	},
);

// Fluxer's own commands; the modal's handlers are not copied.
const ProfilePageActions = observer(({user}: {user: User}) => {
	const {i18n} = useLingui();
	if (user.id === Authentication.currentUserId) {
		if (!(Users.currentUser?.isClaimed() ?? true)) return null;
		const editProfile = () =>
			ModalCommands.push(
				modal(() => (
					<UserSettingsModal initialTab="my_profile" data-flx="user.user-profile-page.actions.user-settings-modal" />
				)),
			);
		return (
			<div className={styles.actions} data-flx="user.user-profile-page.actions">
				<Button
					small
					leftIcon={<PencilIcon className={styles.buttonIcon} data-flx="user.user-profile-page.actions.pencil-icon" />}
					onClick={editProfile}
					data-flx="user.user-profile-page.actions.button.edit-profile"
				>
					<Trans>Edit profile</Trans>
				</Button>
			</div>
		);
	}
	const relationshipType = Relationships.getRelationship(user.id)?.type;
	const blocked = relationshipType === RelationshipTypes.BLOCKED;
	const openMessages = async () => {
		try {
			await PrivateChannelCommands.openDMChannel(user.id);
		} catch (error) {
			logger.error('Failed to open DM channel:', error);
			showDmActionErrorModal(error);
		}
	};
	const openMore = (event: React.MouseEvent<HTMLButtonElement>) =>
		ContextMenuCommands.openFromElementBottomRight(event, ({onClose}) => (
			<UserContextMenu user={user} onClose={onClose} data-flx="user.user-profile-page.actions.user-context-menu" />
		));
	return (
		<div className={styles.actions} data-flx="user.user-profile-page.actions--2">
			{!RuntimeConfig.directMessagesDisabled && !blocked && (
				<Button
					small
					leftIcon={
						<ChatTeardropIcon className={styles.buttonIcon} data-flx="user.user-profile-page.actions.chat-icon" />
					}
					onClick={openMessages}
					data-flx="user.user-profile-page.actions.button.message"
				>
					<Trans context="message-action">Message</Trans>
				</Button>
			)}
			<ProfileFollowButton userId={user.id} data-flx="user.user-profile-page.actions.profile-follow-button" />
			<FriendshipButton
				user={user}
				relationshipType={relationshipType}
				data-flx="user.user-profile-page.actions.friend"
			/>
			<Tooltip text={i18n._(MORE_OPTIONS_DESCRIPTOR)} data-flx="user.user-profile-page.actions.more-tooltip">
				<Button
					small
					square
					variant="secondary"
					icon={
						<DotsThreeIcon
							className={styles.buttonIcon}
							weight="bold"
							data-flx="user.user-profile-page.actions.dots-icon"
						/>
					}
					aria-label={i18n._(MORE_OPTIONS_DESCRIPTOR)}
					onClick={openMore}
					data-flx="user.user-profile-page.actions.button.more"
				/>
			</Tooltip>
		</div>
	);
});

// One friendship button for the relationship there is: none → add, outgoing → cancel, incoming → accept, blocked →
// unblock; friends need none (removing a friend is in the "..." menu).
const FriendshipButton = observer(({user, relationshipType}: {user: User; relationshipType: number | undefined}) => {
	const {i18n} = useLingui();
	const confirmation = (event?: React.MouseEvent) => ({
		bypassConfirm: RelationshipActionUtils.shouldBypassRelationshipConfirmation(event),
		showShiftBypassConfirmationTip: true,
	});
	let action: {label: string; icon: React.ReactNode; onClick: (event: React.MouseEvent) => void} | null = null;
	if (relationshipType === RelationshipTypes.BLOCKED) {
		action = {
			label: i18n._(UNBLOCK_USER_ACTION_DESCRIPTOR),
			icon: <ProhibitIcon className={styles.buttonIcon} data-flx="user.user-profile-page.friend.prohibit-icon" />,
			onClick: (event) => RelationshipActionUtils.showUnblockUserConfirmation(i18n, user, confirmation(event)),
		};
	} else if (relationshipType === RelationshipTypes.INCOMING_REQUEST) {
		action = {
			label: i18n._(ACCEPT_FRIEND_REQUEST_DESCRIPTOR),
			icon: <CheckCircleIcon className={styles.buttonIcon} data-flx="user.user-profile-page.friend.check-icon" />,
			onClick: (event) => RelationshipActionUtils.showAcceptFriendRequestConfirmation(i18n, user, confirmation(event)),
		};
	} else if (relationshipType === RelationshipTypes.OUTGOING_REQUEST) {
		action = {
			label: i18n._(CANCEL_FRIEND_REQUEST_DESCRIPTOR),
			icon: (
				<ClockCounterClockwiseIcon className={styles.buttonIcon} data-flx="user.user-profile-page.friend.clock-icon" />
			),
			onClick: () => void RelationshipActionUtils.cancelFriendRequest(i18n, user.id),
		};
	} else if (!user.bot && relationshipType !== RelationshipTypes.FRIEND) {
		action = {
			label: i18n._(ADD_FRIEND_DESCRIPTOR),
			icon: <UserPlusIcon className={styles.buttonIcon} data-flx="user.user-profile-page.friend.user-plus-icon" />,
			onClick: () => void RelationshipActionUtils.sendFriendRequest(i18n, user.id),
		};
	}
	if (!action) return null;
	return (
		<Tooltip text={action.label} data-flx="user.user-profile-page.friend.tooltip">
			<Button
				small
				square
				variant="secondary"
				icon={action.icon}
				aria-label={action.label}
				onClick={action.onClick}
				disabled={!(Users.currentUser?.isClaimed() ?? true) && relationshipType === undefined}
				data-flx="user.user-profile-page.friend.button"
			/>
		</Tooltip>
	);
});

// The counts come with the profile (the server leaves them out of a limited one, so the buttons go too).
const ProfileFollowStats = observer(({userId}: {userId: string}) => {
	const {i18n} = useLingui();
	const profile = getFollowProfile(userId);
	if (profile?.followerCount == null || profile.followingCount == null) return null;
	const openList = (initialKind: FollowListKind) =>
		ModalCommands.push(
			modal(() => (
				<FollowListModal
					userId={userId}
					initialKind={initialKind}
					data-flx="user.user-profile-page.stats.follow-list-modal"
				/>
			)),
		);
	return (
		<div className={styles.stats} data-flx="user.user-profile-page.stats">
			<button
				type="button"
				className={styles.statButton}
				onClick={() => openList('followers')}
				data-flx="user.user-profile-page.stats.button.followers"
			>
				{i18n._(FOLLOWERS_COUNT_DESCRIPTOR, {count: profile.followerCount})}
			</button>
			<button
				type="button"
				className={styles.statButton}
				onClick={() => openList('following')}
				data-flx="user.user-profile-page.stats.button.following"
			>
				{i18n._(FOLLOWING_COUNT_DESCRIPTOR, {count: profile.followingCount})}
			</button>
		</div>
	);
});

const ProfilePageTabs = observer(
	({
		user,
		profile,
		scrollerRef,
		pageRef,
	}: {
		user: User;
		profile: Profile;
		scrollerRef: RefObject<ScrollerHandle | null>;
		pageRef: RefObject<HTMLDivElement | null>;
	}) => {
		const {i18n} = useLingui();
		// The same rule as the profile's Posts button (ProfilePostsButton): the viewer's feed is on, a person's profile.
		const showPosts = isFeedEnabled() && !user.bot && !user.system;
		const [selectedTab, setSelectedTab] = useState<ProfilePageTab>(showPosts ? 'posts' : 'about');
		// The feed can close while the page is open (its limit changes): About then.
		const activeTab = showPosts ? selectedTab : 'about';
		const timelineKey = userTimelineKey(user.id);
		// One timeline behind Posts and Media, open while the page shows them; the first page is the page's one extra request.
		useEffect(() => {
			if (!showPosts) return;
			FeedTimeline.open(timelineKey);
			if (FeedTimeline.isStale(timelineKey)) void FeedCommands.refresh(timelineKey);
			return () => FeedTimeline.close(timelineKey);
		}, [showPosts, timelineKey]);
		const tabs: Array<{key: ProfilePageTab; label: string}> = showPosts
			? [
					{key: 'posts', label: i18n._(POSTS_TAB_DESCRIPTOR)},
					{key: 'media', label: i18n._(MEDIA_TAB_DESCRIPTOR)},
					{key: 'about', label: i18n._(ABOUT_TAB_DESCRIPTOR)},
				]
			: [{key: 'about', label: i18n._(ABOUT_TAB_DESCRIPTOR)}];
		return (
			<>
				<div className={styles.tabsBar} data-flx="user.user-profile-page.tabs.bar">
					<Tabs
						tabs={tabs}
						activeTab={activeTab}
						onTabChange={setSelectedTab}
						className={styles.tabs}
						data-flx="user.user-profile-page.tabs.tabs"
					/>
				</div>
				{activeTab === 'posts' && (
					<ProfilePostsTab
						userId={user.id}
						scrollerRef={scrollerRef}
						pageRef={pageRef}
						data-flx="user.user-profile-page.tabs.posts"
					/>
				)}
				{activeTab === 'media' && (
					<ProfileMediaGrid timelineKey={timelineKey} data-flx="user.user-profile-page.tabs.media" />
				)}
				{activeTab === 'about' && (
					<ProfileAboutTab user={user} profile={profile} data-flx="user.user-profile-page.tabs.about" />
				)}
			</>
		);
	},
);

const ProfilePostsTab = observer(
	({
		userId,
		scrollerRef,
		pageRef,
	}: {
		userId: string;
		scrollerRef: RefObject<ScrollerHandle | null>;
		pageRef: RefObject<HTMLDivElement | null>;
	}) => {
		const {i18n} = useLingui();
		const listRef = useRef<HTMLDivElement>(null);
		const scrollMargin = useScrollMargin(listRef, pageRef, scrollerRef);
		// The server filters a public view to its public posts, so on someone else's page "no posts yet" could be untrue.
		const emptyText = i18n._(
			userId === Authentication.currentUserId ? NO_POSTS_YET_DESCRIPTOR : NO_POSTS_TO_SHOW_DESCRIPTOR,
		);
		return (
			<div ref={listRef} className={styles.posts} data-flx="user.user-profile-page.posts">
				<FeedTimelineList
					timelineKey={userTimelineKey(userId)}
					scrollerRef={scrollerRef}
					emptyText={emptyText}
					scrollMargin={scrollMargin}
					data-flx="user.user-profile-page.posts.feed-timeline-list"
				/>
			</div>
		);
	},
);

// How far below the scroller's top the posts list starts: the header above it scrolls in the same scroller. Measured
// after the scroller sets its handle (an effect, not a layout effect) and again whenever the page changes size.
function useScrollMargin(
	listRef: RefObject<HTMLElement | null>,
	pageRef: RefObject<HTMLElement | null>,
	scrollerRef: RefObject<ScrollerHandle | null>,
): number {
	const [scrollMargin, setScrollMargin] = useState(0);
	useEffect(() => {
		const list = listRef.current;
		const page = pageRef.current;
		const viewport = scrollerRef.current?.getViewportElement();
		if (!list || !page || !viewport) return;
		const measure = () =>
			setScrollMargin(
				Math.round(list.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop),
			);
		measure();
		const ownerWindow = page.ownerDocument.defaultView ?? window;
		if (typeof ownerWindow.ResizeObserver === 'undefined') return;
		const observer = new ownerWindow.ResizeObserver(measure);
		observer.observe(page);
		return () => observer.disconnect();
	}, [listRef, pageRef, scrollerRef]);
	return scrollMargin;
}

const ProfileAboutTab = observer(({user, profile}: {user: User; profile: Profile}) => {
	// the mutual lists only now. Your own profile shows none.
	useEffect(() => {
		if (user.id === Authentication.currentUserId) return;
		UserProfileCommands.fetch(user.id, undefined, false, {withMutuals: true}).catch((error) =>
			logger.warn(`Failed to load the mutual lists of ${user.id}:`, error),
		);
	}, [user.id]);
	return (
		<div className={styles.about} data-flx="user.user-profile-page.about">
			<ProfileBody
				profile={profile}
				user={user}
				userNote={UserNote.getUserNote(user.id)}
				isPreview={false}
				hideUserInfo
				onLeave={stayOnPage}
				onOpenUser={UserProfileCommands.openProfilePage}
				data-flx="user.user-profile-page.about.profile-body"
			/>
		</div>
	);
});

// Leaving for a community, a group or a voice channel needs nothing closed first on the page.
const stayOnPage = () => {};

const ProfilePageMessage = observer(
	({kind, user}: {kind: 'not_found' | 'forbidden' | 'limited'; user?: User | null}) => {
		const {i18n} = useLingui();
		const descriptor =
			kind === 'not_found'
				? USER_NOT_FOUND_DESCRIPTOR
				: kind === 'forbidden'
					? YOU_CAN_T_SEE_THIS_PROFILE_DESCRIPTOR
					: LIMITED_PROFILE_DESCRIPTOR;
		return (
			<div className={styles.message} data-flx="user.user-profile-page.message">
				{user && (
					<div className={styles.messageUser} data-flx="user.user-profile-page.message.user">
						<Avatar user={user} size={80} data-flx="user.user-profile-page.message.avatar" />
						<span className={styles.messageName} data-flx="user.user-profile-page.message.name">
							{NicknameUtils.getNickname(user, null)}
						</span>
					</div>
				)}
				<p className={styles.messageText} data-flx="user.user-profile-page.message.text">
					{i18n._(descriptor)}
				</p>
			</div>
		);
	},
);

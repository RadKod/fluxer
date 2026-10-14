// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import {ConfirmModal} from '@app/features/app/components/dialogs/ConfirmModal';
import Authentication from '@app/features/auth/state/Authentication';
import {AttachmentMosaic} from '@app/features/channel/components/embeds/attachments/AttachmentMosaic';
import {TimestampWithTooltip} from '@app/features/channel/components/TimestampWithTooltip';
import * as FeedCommands from '@app/features/feed/commands/FeedCommands';
import {FEED_VIEW_THRESHOLDS, isHalfVisible, recordView} from '@app/features/feed/commands/FeedViewCommands';
import {FeedComments, feedCommentBoxId} from '@app/features/feed/components/FeedComments';
import {FeedItemMenu, toastFeedFailure} from '@app/features/feed/components/FeedItemMenu';
import {FeedLinkPreview} from '@app/features/feed/components/FeedLinkPreview';
import {FeedPollView} from '@app/features/feed/components/FeedPollView';
import styles from '@app/features/feed/components/FeedPostCard.module.css';
import {FeedPostContent} from '@app/features/feed/components/FeedPostContent';
import {FeedReportModal} from '@app/features/feed/components/FeedReportModal';
import {FeedVideo} from '@app/features/feed/components/FeedVideo';
import FeedTimeline, {type FeedPost} from '@app/features/feed/state/FeedTimeline';
import * as FollowCommands from '@app/features/follow/commands/FollowCommands';
import {
	FOLLOW_DESCRIPTOR,
	FOLLOWING_DESCRIPTOR,
	toastFollowFailure,
	UNFOLLOW_DESCRIPTOR,
} from '@app/features/follow/components/ProfileFollowActions';
import {canFollowThroughPost} from '@app/features/follow/utils/FollowProfileUtils';
import {CANCEL_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import * as RouterUtils from '@app/features/navigation/utils/RouterUtils';
import {observeIntersection} from '@app/features/platform/utils/SharedIntersectionObserver';
import {MoreIcon} from '@app/features/ui/action_menu/ContextMenuIcons';
import * as ContextMenuCommands from '@app/features/ui/commands/ContextMenuCommands';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {Avatar} from '@app/features/ui/components/Avatar';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import * as UserProfileCommands from '@app/features/user/commands/UserProfileCommands';
import {PremiumUserBadge} from '@app/features/user/components/PremiumUserBadge';
import {VerifiedUserBadge} from '@app/features/user/components/VerifiedUserBadge';
import Users from '@app/features/user/state/Users';
import {getRelativeDateString} from '@app/features/user/utils/DateFormatting';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import {extractTimestamp} from '@fluxer/snowflake/src/SnowflakeUtils';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {ChatCircleIcon, EyeIcon, GlobeSimpleIcon, HeartIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useEffect, useRef, useState} from 'react';

const POST_OPTIONS_DESCRIPTOR = msg({
	message: 'Post options',
	comment: 'Accessible label and tooltip of the "..." button on a feed post that opens its menu.',
});
const LIKE_DESCRIPTOR = msg({
	message: '{count, plural, one {# like} other {# likes}}',
	comment: 'Accessible label of the like button on a feed post. {count} is how many accounts like the post.',
});
const COMMENTS_DESCRIPTOR = msg({
	message: '{count, plural, one {# comment} other {# comments}}',
	comment:
		'Accessible label of the button on a feed post that shows or hides its comments. {count} is how many comments it has.',
});
const VIEWS_DESCRIPTOR = msg({
	message: '{count, plural, one {{formatted} view} other {{formatted} views}}',
	comment:
		'Under a feed post, at the end of its action row: the full text for the view count, read by screen readers and shown in the tooltip; the card shows only an eye icon and the shortened number. {formatted} is the full count with digit grouping (1,234); {count} is the same number, only for the plural form.',
});
const DELETE_POST_DESCRIPTOR = msg({
	message: 'Delete post',
	comment: 'Menu action and confirmation title that deletes your own feed post.',
});
const DELETE_POST_CONFIRM_DESCRIPTOR = msg({
	message: 'Your post and its comments will be gone for everyone. This cannot be undone.',
	comment: 'Confirmation text before deleting your own feed post.',
});
const REPORT_POST_DESCRIPTOR = msg({
	message: 'Report post',
	comment: 'Menu action and report dialog title for reporting a feed post to the safety team.',
});
const PUBLIC_POST_DESCRIPTOR = msg({
	message: 'Public post',
	comment:
		'Tooltip and screen reader label of the globe next to the time of a feed post that anyone can see, also in Discover.',
});
const FOLLOW_USER_DESCRIPTOR = msg({
	message: 'Follow {name}',
	comment:
		'Accessible name of the Follow pill at the top right of a Discover post, before its "..." button. {name} is the display name of the post author.',
});
const FOLLOWING_USER_DESCRIPTOR = msg({
	message: 'Following {name}',
	context: 'follow-button',
	comment:
		'Accessible name of the pill at the top right of a Discover post once you follow its author; a tap unfollows. {name} is the display name of the post author.',
});
// A click on these, or inside something marked data-feed-no-open (media, poll, link preview), is not a click on the post.
const NO_OPEN_SELECTOR = 'a, button, video, img, input, textarea, label, [role="button"], [data-feed-no-open]';

interface FeedPostCardProps {
	post: FeedPost;
	// 'page' is the post page itself: the card does not open the page again and the page lists the comments.
	variant?: 'timeline' | 'page';
	// Runs before the post page opens, so a card inside a modal closes the modal first.
	onOpenPost?: () => void;
	// Post page on the desktop layout: drawn inside the card, above the action row and at its end.
	beforeActions?: React.ReactNode;
	actionsEnd?: React.ReactNode;
}

export const FeedPostCard = observer(({post, variant = 'timeline', onOpenPost, ...slots}: FeedPostCardProps) => {
	const {i18n} = useLingui();
	const isAuthor = post.author.id === Authentication.currentUserId;
	const commentsOpen = FeedTimeline.getThread(post.id) != null;
	// Opened from the keyboard (a click with detail 0, as in BlockedMessageGroups), the panel puts focus in its reply
	// box; a mouse or touch opening leaves focus where it is, so no phone keyboard pops up.
	const [focusReply, setFocusReply] = useState(false);
	// A ref, not state: watching the card costs no extra render, with view counts off too.
	const cardRef = useRef<HTMLElement>(null);
	// The latest token, read at the crossing: a reloaded copy of the post (poll vote, fresh video URLs) carries a new one,
	// and re-observing for it would count a card that never left the screen again.
	const viewTokenRef = useRef(post.viewToken);
	viewTokenRef.current = post.viewToken;
	const watchViews = post.viewToken !== null;
	// Micup akis-izlenme: the card counts as seen once half of it is on screen (FeedViewCommands); only while the server
	// gives the post a view token, so with view counts off nothing is watched or sent.
	useEffect(() => {
		const card = cardRef.current;
		if (!card || !watchViews) return undefined;
		return observeIntersection(
			card,
			(entry) => {
				const token = viewTokenRef.current;
				if (token && isHalfVisible(entry)) recordView(post.id, token);
			},
			{threshold: FEED_VIEW_THRESHOLDS},
		);
	}, [post.id, watchViews]);
	// Micup akis-takip: the pill is offered when the card mounts on a Discover post of an author the viewer does not
	// follow, and stays through the follow so a second tap undoes it; a card mounted later has none (X, Instagram). Not to
	// a viewer the server would refuse on the post path.
	const [followOfferedFor] = useState(() =>
		post.authorFollowing === false && !isAuthor && canFollowThroughPost(Users.currentUser) ? post.id : null,
	);
	const [followBusy, setFollowBusy] = useState(false);
	const authorName = NicknameUtils.getNickname(post.author, null);
	const toggleFollow = async () => {
		const wasFollowing = post.authorFollowing === true;
		setFollowBusy(true);
		const outcome = wasFollowing
			? await FollowCommands.unfollow(post.author.id)
			: await FollowCommands.follow(post.author.id, {postId: post.id});
		setFollowBusy(false);
		toastFollowFailure(i18n, outcome, wasFollowing);
	};
	const postedAt = new Date(extractTimestamp(post.id));
	const openProfile = () => UserProfileCommands.openProfilePage(post.author.id);
	const openPost = () => {
		onOpenPost?.();
		RouterUtils.transitionTo(Routes.feedPost(post.id));
	};
	const openFromBody = (event: React.MouseEvent<HTMLElement>) => {
		const target = event.target as Element;
		// Clicks from a portal (a tooltip) bubble here in React but are not inside the post.
		if (!event.currentTarget.contains(target)) return;
		const control = target.closest(NO_OPEN_SELECTOR);
		if (control && event.currentTarget.contains(control)) return;
		if (window.getSelection()?.toString()) return;
		openPost();
	};
	// A plain click stays in the app (on the post page it is already there); a click for a new tab or window is left to
	// the browser.
	const openFromTimestamp = (event: React.MouseEvent<HTMLAnchorElement>) => {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		if (variant === 'timeline') openPost();
	};
	const toggleLike = async () => {
		toastFeedFailure(i18n, await FeedCommands.setLiked(post.id, !post.liked));
	};
	const toggleComments = (event: React.MouseEvent) => {
		// The post page lists the comments below the card, always open: the button goes to its comment box.
		if (variant === 'page') {
			document.getElementById(feedCommentBoxId(post.id))?.focus();
			return;
		}
		if (commentsOpen) {
			FeedTimeline.closeThread(post.id);
			return;
		}
		setFocusReply(event.detail === 0);
		FeedTimeline.openThread(post.id);
		void FeedCommands.loadComments(post.id);
	};
	const confirmDelete = () => {
		ModalCommands.push(
			modal(() => (
				<ConfirmModal
					title={i18n._(DELETE_POST_DESCRIPTOR)}
					description={i18n._(DELETE_POST_CONFIRM_DESCRIPTOR)}
					primaryText={i18n._(DELETE_POST_DESCRIPTOR)}
					primaryVariant="danger"
					secondaryText={i18n._(CANCEL_DESCRIPTOR)}
					onPrimary={async () => toastFeedFailure(i18n, await FeedCommands.deletePost(post.id))}
					data-flx="feed.feed-post-card.confirm-delete.confirm-modal"
				/>
			)),
		);
	};
	const report = () => {
		ModalCommands.push(
			modal(() => (
				<FeedReportModal
					title={i18n._(REPORT_POST_DESCRIPTOR)}
					onSubmit={(category) => FeedCommands.reportPost(post.id, category)}
					data-flx="feed.feed-post-card.report.feed-report-modal"
				/>
			)),
		);
	};
	const openMenu = (event: React.MouseEvent) => {
		ContextMenuCommands.openFromElementBottomRight(event, ({onClose}) => (
			<FeedItemMenu
				onClose={onClose}
				deleteLabel={DELETE_POST_DESCRIPTOR}
				reportLabel={REPORT_POST_DESCRIPTOR}
				onDelete={isAuthor ? confirmDelete : null}
				onReport={isAuthor ? null : report}
				data-flx="feed.feed-post-card.open-menu.feed-item-menu"
			/>
		));
	};
	const menuLabel = i18n._(POST_OPTIONS_DESCRIPTOR);
	const views =
		post.viewCount === null
			? null
			: {
					count: post.viewCount,
					label: i18n._(VIEWS_DESCRIPTOR, {count: post.viewCount, formatted: i18n.number(post.viewCount)}),
				};
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: mouse convenience; the timestamp link is the keyboard affordance.
		<article
			ref={cardRef}
			className={clsx(styles.post, variant === 'page' && styles.pageVariant)}
			onClick={variant === 'timeline' ? openFromBody : undefined}
			data-flx="feed.feed-post-card.post"
		>
			<button
				type="button"
				className={styles.avatarButton}
				onClick={openProfile}
				tabIndex={-1}
				aria-hidden
				data-flx="feed.feed-post-card.avatar-button.open-profile"
			>
				<Avatar user={post.author} size={40} data-flx="feed.feed-post-card.avatar" />
			</button>
			<div className={styles.body} data-flx="feed.feed-post-card.body">
				<header className={styles.header} data-flx="feed.feed-post-card.header">
					<FocusRing offset={-2} data-flx="feed.feed-post-card.author-focus-ring">
						<button
							type="button"
							className={styles.authorButton}
							onClick={openProfile}
							data-flx="feed.feed-post-card.author-button.open-profile"
						>
							{authorName}
						</button>
					</FocusRing>
					<VerifiedUserBadge user={post.author} data-flx="feed.feed-post-card.verified-user-badge" />
					<PremiumUserBadge user={post.author} data-flx="feed.feed-post-card.premium-user-badge" />
					<span className={styles.tag} data-flx="feed.feed-post-card.tag">
						{NicknameUtils.formatTagForStreamerMode(post.author.tag)}
					</span>
					<TimestampWithTooltip
						date={postedAt}
						className={clsx(styles.timestamp, post.isPublic && styles.timestampBeforeMarker)}
						data-flx="feed.feed-post-card.timestamp"
					>
						<FocusRing offset={-2} data-flx="feed.feed-post-card.timestamp-focus-ring">
							<a
								href={Routes.feedPost(post.id)}
								className={styles.timestampLink}
								onClick={openFromTimestamp}
								data-flx="feed.feed-post-card.timestamp-link.open-post"
							>
								{getRelativeDateString(postedAt, i18n)}
							</a>
						</FocusRing>
					</TimestampWithTooltip>
					{post.isPublic && (
						<Tooltip text={i18n._(PUBLIC_POST_DESCRIPTOR)} data-flx="feed.feed-post-card.public-tooltip">
							<span
								className={styles.publicMarker}
								role="img"
								aria-label={i18n._(PUBLIC_POST_DESCRIPTOR)}
								data-flx="feed.feed-post-card.public-marker"
							>
								<GlobeSimpleIcon weight="bold" aria-hidden data-flx="feed.feed-post-card.globe-simple-icon" />
							</span>
						</Tooltip>
					)}
					{followOfferedFor === post.id && post.authorFollowing !== null && (
						<FocusRing offset={-2} data-flx="feed.feed-post-card.follow-focus-ring">
							<button
								type="button"
								className={clsx(styles.followPill, post.authorFollowing && styles.followPillFollowing)}
								onClick={toggleFollow}
								disabled={followBusy}
								aria-label={i18n._(post.authorFollowing ? FOLLOWING_USER_DESCRIPTOR : FOLLOW_USER_DESCRIPTOR, {
									name: authorName,
								})}
								data-flx="feed.feed-post-card.follow-pill.toggle-follow"
							>
								{post.authorFollowing ? (
									<>
										<span className={styles.followIdleLabel} data-flx="feed.feed-post-card.follow-idle-label">
											{i18n._(FOLLOWING_DESCRIPTOR)}
										</span>
										<span
											className={styles.followHoverLabel}
											aria-hidden
											data-flx="feed.feed-post-card.follow-hover-label"
										>
											{i18n._(UNFOLLOW_DESCRIPTOR)}
										</span>
									</>
								) : (
									i18n._(FOLLOW_DESCRIPTOR)
								)}
							</button>
						</FocusRing>
					)}
					<FocusRing offset={-2} data-flx="feed.feed-post-card.focus-ring">
						<Tooltip text={menuLabel} data-flx="feed.feed-post-card.tooltip">
							<button
								type="button"
								className={styles.moreButton}
								onClick={openMenu}
								aria-label={menuLabel}
								data-flx="feed.feed-post-card.more-button.open-menu"
							>
								<MoreIcon size={18} data-flx="feed.feed-post-card.more-icon" />
							</button>
						</Tooltip>
					</FocusRing>
				</header>
				{post.content && (
					<div className={styles.content} data-flx="feed.feed-post-card.content">
						<FeedPostContent content={post.content} postId={post.id} data-flx="feed.feed-post-card.feed-post-content" />
					</div>
				)}
				{post.poll && (
					<div className={styles.noOpen} data-feed-no-open data-flx="feed.feed-post-card.poll">
						<FeedPollView post={post} data-flx="feed.feed-post-card.feed-poll-view" />
					</div>
				)}
				{post.video && (
					<div className={styles.media} data-feed-no-open data-flx="feed.feed-post-card.video">
						<FeedVideo postId={post.id} video={post.video} data-flx="feed.feed-post-card.feed-video" />
					</div>
				)}
				{!post.video && post.attachments.length > 0 && (
					<div className={styles.media} data-feed-no-open data-flx="feed.feed-post-card.media">
						<AttachmentMosaic
							attachments={post.attachments}
							hideExpiryFootnote
							data-flx="feed.feed-post-card.attachment-mosaic"
						/>
					</div>
				)}
				{post.linkPreview && (
					<div className={styles.noOpen} data-feed-no-open data-flx="feed.feed-post-card.link-preview">
						<FeedLinkPreview preview={post.linkPreview} data-flx="feed.feed-post-card.feed-link-preview" />
					</div>
				)}
				{slots.beforeActions}
				<footer className={styles.actions} data-flx="feed.feed-post-card.actions">
					<FocusRing offset={-2} data-flx="feed.feed-post-card.like-focus-ring">
						<button
							type="button"
							className={clsx(styles.actionButton, styles.likeButton, post.liked && styles.actionButtonActive)}
							onClick={toggleLike}
							aria-pressed={post.liked}
							aria-label={i18n._(LIKE_DESCRIPTOR, {count: post.likeCount})}
							data-flx="feed.feed-post-card.action-button.toggle-like"
						>
							<HeartIcon
								weight={post.liked ? 'fill' : 'bold'}
								className={styles.actionIcon}
								data-flx="feed.feed-post-card.heart-icon"
							/>
							{i18n.number(post.likeCount, {notation: 'compact'})}
						</button>
					</FocusRing>
					<FocusRing offset={-2} data-flx="feed.feed-post-card.comments-focus-ring">
						<button
							type="button"
							className={styles.actionButton}
							onClick={toggleComments}
							aria-expanded={variant === 'timeline' ? commentsOpen : undefined}
							aria-label={i18n._(COMMENTS_DESCRIPTOR, {count: post.commentCount})}
							data-flx="feed.feed-post-card.action-button.toggle-comments"
						>
							<ChatCircleIcon
								weight="bold"
								className={styles.actionIcon}
								data-flx="feed.feed-post-card.chat-circle-icon"
							/>
							{i18n.number(post.commentCount, {notation: 'compact'})}
						</button>
					</FocusRing>
					{views && (
						// an eye icon with the shortened count; the full "N views" text is the accessible name and the
						// tooltip.
						<Tooltip text={views.label} data-flx="feed.feed-post-card.views-tooltip">
							<span
								className={styles.viewCount}
								role="img"
								aria-label={views.label}
								data-flx="feed.feed-post-card.view-count"
							>
								<EyeIcon
									weight="bold"
									className={styles.actionIcon}
									aria-hidden
									data-flx="feed.feed-post-card.eye-icon"
								/>
								<span aria-hidden data-flx="feed.feed-post-card.view-count-number">
									{i18n.number(views.count, {notation: 'compact'})}
								</span>
							</span>
						</Tooltip>
					)}
					{slots.actionsEnd ? (
						<span className={styles.actionsEnd} data-flx="feed.feed-post-card.actions-end">
							{slots.actionsEnd}
						</span>
					) : null}
				</footer>
				{commentsOpen && variant === 'timeline' && (
					<div className={styles.noOpen} data-feed-no-open data-flx="feed.feed-post-card.comments">
						<FeedComments post={post} autoFocus={focusReply} data-flx="feed.feed-post-card.feed-comments" />
					</div>
				)}
			</div>
		</article>
	);
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import {FeedComments} from '@app/features/feed/components/FeedComments';
import {FeedLikers} from '@app/features/feed/components/FeedLikers';
import {FeedPostCard} from '@app/features/feed/components/FeedPostCard';
import {FeedProfileAside} from '@app/features/feed/components/FeedProfileAside';
import pageStyles from '@app/features/feed/components/pages/FeedPage.module.css';
import styles from '@app/features/feed/components/pages/FeedPostDetail.module.css';
import FeedTimeline from '@app/features/feed/state/FeedTimeline';
import {GO_BACK_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import * as FeedNotificationCommands from '@app/features/inbox/commands/FeedNotificationCommands';
import {goBackOr} from '@app/features/platform/components/router/NavigationAdapter';
import {remFromPx} from '@app/features/theme/layout/RemFromPx';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {Scroller} from '@app/features/ui/components/Scroller';
import {Spinner} from '@app/features/ui/components/Spinner';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import {getFormattedShortDate, getFormattedTime} from '@app/features/user/utils/DateFormatting';
import {extractTimestamp} from '@fluxer/snowflake/src/SnowflakeUtils';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {ArrowLeftIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useEffect} from 'react';

const POST_DESCRIPTOR = msg({
	message: 'Post',
	context: 'feed-post-title',
	comment:
		'Title of the page that shows one feed post with its likes and comments (opened from the post in the feed or from a shared link). A noun.',
});
const POST_UNAVAILABLE_DESCRIPTOR = msg({
	message: "This post can't be shown.",
	comment:
		'Shown on the page of a feed post that was deleted, is hidden from you or failed to load (opened from the feed or a shared link).',
});
const PUBLIC_POST_DESCRIPTOR = msg({
	message: 'Public post',
	comment:
		'On the page of a feed post, after its time and date, for a post that anyone can see, also in Discover. Keep it concise.',
});
const SEE_WHO_LIKED_DESCRIPTOR = msg({
	message: 'See who liked',
	comment: 'Button on the page of a feed post that opens the list of accounts that like it. Keep it concise.',
});

interface FeedPostDetailProps {
	postId: string;
	// Set beside the feed sidebar (not on the narrow layout): the profile card stays where it is on the feed.
	onShowPosts?: () => void;
}

// The id comes from the address bar; anything but a snowflake is never put in an API path.
const POST_ID_PATTERN = /^\d{1,20}$/;

// The post in a timeline of its own (the one a notification opens it in), so its likes and comments work as in the feed.
export const FeedPostDetail = observer(({postId, onShowPosts}: FeedPostDetailProps) => {
	const {i18n} = useLingui();
	const timelineKey = FeedNotificationCommands.feedPostTimelineKey(postId);
	const isPostId = POST_ID_PATTERN.test(postId);
	useEffect(() => {
		if (!isPostId) return undefined;
		// The page opens the comments; the post's card in a feed behind it keeps its panel as it was.
		const commentsWereOpen = FeedTimeline.getThread(postId) != null;
		FeedTimeline.open(timelineKey);
		void FeedNotificationCommands.loadPost(postId, true);
		return () => {
			if (!commentsWereOpen) FeedTimeline.closeThread(postId);
			FeedTimeline.close(timelineKey);
		};
	}, [isPostId, timelineKey, postId]);
	const timeline = FeedTimeline.getTimeline(timelineKey);
	const post = isPostId ? timeline?.posts[0] : undefined;
	const unavailable = !isPostId || (!post && (timeline?.failure != null || timeline?.fetchedAt != null));
	const postedAt = post ? new Date(extractTimestamp(post.id)) : null;
	const openLikers = () =>
		ModalCommands.push(
			modal(() => <FeedLikers postId={postId} data-flx="feed.feed-post-detail.open-likers.feed-likers" />),
		);
	// The desktop layout draws the time line and See who liked inside the card; the phone layout keeps them
	// in a row under it.
	const inCard = !MobileLayout.enabled;
	const stamp = post && postedAt && (
		<>
			<time dateTime={postedAt.toISOString()} data-flx="feed.feed-post-detail.time">
				{`${getFormattedTime(postedAt)} · ${getFormattedShortDate(postedAt)}`}
			</time>
			{post.isPublic && <span data-flx="feed.feed-post-detail.public">{` · ${i18n._(PUBLIC_POST_DESCRIPTOR)}`}</span>}
		</>
	);
	const likersButton = post != null && post.likeCount > 0 && (
		<FocusRing offset={-2} data-flx="feed.feed-post-detail.likers-focus-ring">
			<button
				type="button"
				className={styles.likersButton}
				onClick={openLikers}
				data-flx="feed.feed-post-detail.likers-button.open-likers"
			>
				{i18n._(SEE_WHO_LIKED_DESCRIPTOR)}
			</button>
		</FocusRing>
	);
	return (
		<div className={pageStyles.main} data-flx="feed.feed-post-detail.main">
			<header className={pageStyles.header} data-flx="feed.feed-post-detail.header">
				<FocusRing offset={-2} data-flx="feed.feed-post-detail.focus-ring">
					<button
						type="button"
						className={styles.backButton}
						aria-label={i18n._(GO_BACK_DESCRIPTOR)}
						onClick={() => goBackOr(Routes.FEED)}
						data-flx="feed.feed-post-detail.back-button.go-back-or"
					>
						<ArrowLeftIcon
							size={remFromPx(20)}
							weight="bold"
							aria-hidden
							data-flx="feed.feed-post-detail.arrow-left-icon"
						/>
					</button>
				</FocusRing>
				<h1 className={pageStyles.headerTitle} data-flx="feed.feed-post-detail.header-title">
					{i18n._(POST_DESCRIPTOR)}
				</h1>
			</header>
			<div className={pageStyles.body} data-flx="feed.feed-post-detail.body">
				<div className={pageStyles.timeline} data-flx="feed.feed-post-detail.timeline">
					<div className={pageStyles.listArea} data-flx="feed.feed-post-detail.list-area">
						<Scroller data-flx="feed.feed-post-detail.scroller">
							{post && postedAt && (
								<div className={styles.post} data-flx="feed.feed-post-detail.post">
									<FeedPostCard
										post={post}
										variant="page"
										beforeActions={
											inCard && (
												<div className={styles.cardStamp} data-flx="feed.feed-post-detail.card-stamp">
													{stamp}
												</div>
											)
										}
										actionsEnd={inCard && likersButton}
										data-flx="feed.feed-post-detail.feed-post-card"
									/>
									{!inCard && (
										<div className={styles.meta} data-flx="feed.feed-post-detail.meta">
											<span className={styles.stamp} data-flx="feed.feed-post-detail.stamp">
												{stamp}
											</span>
											{likersButton}
										</div>
									)}
									<div className={styles.comments} data-flx="feed.feed-post-detail.comments">
										<FeedComments post={post} layout="page" data-flx="feed.feed-post-detail.feed-comments" />
									</div>
								</div>
							)}
							{unavailable && (
								<p className={styles.status} data-flx="feed.feed-post-detail.status">
									{i18n._(POST_UNAVAILABLE_DESCRIPTOR)}
								</p>
							)}
							{!post && !unavailable && (
								<div className={styles.status} data-flx="feed.feed-post-detail.status--2">
									<Spinner data-flx="feed.feed-post-detail.spinner" />
								</div>
							)}
						</Scroller>
					</div>
				</div>
				{onShowPosts && (
					<FeedProfileAside onShowPosts={onShowPosts} data-flx="feed.feed-post-detail.feed-profile-aside" />
				)}
			</div>
		</div>
	);
});

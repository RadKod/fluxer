// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import * as FeedCommands from '@app/features/feed/commands/FeedCommands';
import FeedTimeline, {type FeedPost} from '@app/features/feed/state/FeedTimeline';
import {
	buildMediaProxyURL,
	mediaDevicePixelRatio,
	resolvePreferredImageFormat,
	snapMediaProxyImageSize,
} from '@app/features/messaging/utils/MediaProxyUtils';
import * as RouterUtils from '@app/features/navigation/utils/RouterUtils';
import {Button} from '@app/features/ui/button/Button';
import {Spinner} from '@app/features/ui/components/Spinner';
import styles from '@app/features/user/components/pages/ProfileMediaGrid.module.css';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {PlayIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';

const NO_MEDIA_TO_SHOW_DESCRIPTOR = msg({
	message: 'No media to show.',
	comment:
		'Empty state of the Media tab on the full profile page: the posts loaded so far hold no pictures or videos you may see.',
});
const SHOW_OLDER_POSTS_DESCRIPTOR = msg({
	message: 'Show older posts',
	comment:
		'Button at the end of a feed after several pages in a row held no posts to show (for example posts of accounts you no longer follow). Loads older posts.',
});
const OPEN_POST_DESCRIPTOR = msg({
	message: 'Open post',
	comment: 'Accessible label of a picture or video tile in the Media tab of the full profile page; opens that post.',
});

// TEMPORARY: Media filters the posts timeline on the client and asks for at most five more pages by
// itself, so a text-heavy account shows a button instead of a long empty chain. Path: a feed_media_by_author
// ((author_id, bucket), post_id) table filled in the post write batch, and ?media=1 on GET /users/:id/posts.
// Trigger: Media opens ask more than 3 pages on average, or Media requests pass 20 % of user post requests.
const MEDIA_AUTO_PAGES = 5;
const MEDIA_FILL = 12;
// A third of the 760px page column.
const TILE_CSS_PX = 256;

function hasMedia(post: FeedPost): boolean {
	return post.attachments.length > 0 || post.video != null;
}

// The feed card's media proxy (AttachmentGridItem): the short side of the picture covers the square tile.
function tileImageUrl(post: FeedPost): string {
	if (post.video) return post.video.poster_url;
	const attachment = post.attachments[0]!;
	const source = attachment.proxy_url ?? attachment.url ?? '';
	if (!source || source.startsWith('blob:')) return source;
	const aspect = attachment.width && attachment.height ? attachment.width / attachment.height : 1;
	return buildMediaProxyURL(source, {
		format: resolvePreferredImageFormat(attachment.content_type),
		width: snapMediaProxyImageSize(TILE_CSS_PX * mediaDevicePixelRatio() * Math.max(1, aspect)),
	});
}

// Micup: the Media tab, a square grid of the user's posts with pictures or a video.
export const ProfileMediaGrid = observer(({timelineKey}: {timelineKey: string}) => {
	const {i18n} = useLingui();
	const timeline = FeedTimeline.getTimeline(timelineKey);
	const loadedCount = timeline?.posts.length ?? 0;
	const posts = (timeline?.posts ?? []).filter(hasMedia);
	const [autoPages, setAutoPages] = useState(0);
	const canLoadMore = timeline?.hasMore === true && !timeline.isLoading && timeline.failure == null;
	const fillsItself = canLoadMore && posts.length < MEDIA_FILL && autoPages < MEDIA_AUTO_PAGES;
	// loadedCount: each page that adds posts and still leaves the grid short asks for the next one.
	useEffect(() => {
		if (!fillsItself) return;
		setAutoPages((count) => count + 1);
		void FeedCommands.loadNextPage(timelineKey);
	}, [fillsItself, loadedCount, timelineKey]);
	const offersOlder =
		timeline != null &&
		!timeline.isLoading &&
		!fillsItself &&
		(canLoadMore || timeline.failure === 'paused' || timeline.failure === 'error');
	return (
		<div className={styles.container} data-flx="user.profile-media-grid.container">
			{posts.length > 0 && (
				<div className={styles.grid} data-flx="user.profile-media-grid.grid">
					{posts.map((post) => (
						<button
							key={post.id}
							type="button"
							className={styles.tile}
							aria-label={i18n._(OPEN_POST_DESCRIPTOR)}
							onClick={() => RouterUtils.transitionTo(Routes.feedPost(post.id))}
							data-flx="user.profile-media-grid.tile"
						>
							<img
								className={styles.image}
								src={tileImageUrl(post)}
								alt=""
								loading="lazy"
								draggable={false}
								data-flx="user.profile-media-grid.image"
							/>
							{post.video && (
								<PlayIcon weight="fill" className={styles.videoBadge} data-flx="user.profile-media-grid.play-icon" />
							)}
						</button>
					))}
				</div>
			)}
			{timeline?.isLoading && (
				<div className={styles.status} data-flx="user.profile-media-grid.status">
					<Spinner size={posts.length === 0 ? 'medium' : 'small'} data-flx="user.profile-media-grid.spinner" />
				</div>
			)}
			{offersOlder && (
				<div className={styles.status} data-flx="user.profile-media-grid.status--2">
					<Button
						small
						variant="secondary"
						onClick={() => void FeedCommands.retry(timelineKey)}
						data-flx="user.profile-media-grid.button.load-older"
					>
						{i18n._(SHOW_OLDER_POSTS_DESCRIPTOR)}
					</Button>
				</div>
			)}
			{timeline && !timeline.isLoading && !timeline.hasMore && posts.length === 0 && (
				<p className={styles.status} data-flx="user.profile-media-grid.empty">
					{i18n._(NO_MEDIA_TO_SHOW_DESCRIPTOR)}
				</p>
			)}
		</div>
	);
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import * as FeedCommands from '@app/features/feed/commands/FeedCommands';
import {FeedPostCard} from '@app/features/feed/components/FeedPostCard';
import styles from '@app/features/feed/components/FeedTimelineList.module.css';
import FeedTimeline from '@app/features/feed/state/FeedTimeline';
import {TRY_AGAIN_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {remFromPx} from '@app/features/theme/layout/RemFromPx';
import {Button} from '@app/features/ui/button/Button';
import type {ScrollerHandle} from '@app/features/ui/components/Scroller';
import {Spinner} from '@app/features/ui/components/Spinner';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import {getAppRemScale} from '@app/features/ui/utils/AppZoomUtils';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {CompassIcon, UsersIcon} from '@phosphor-icons/react';
import {useVirtualizer, type VirtualItem} from '@tanstack/react-virtual';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useCallback, useEffect, useLayoutEffect, useReducer, useRef} from 'react';

const ESTIMATED_POST_HEIGHT_PX = 180;
const OVERSCAN_POSTS = 4;
const MAX_SAVED_SCROLLS = 16;

// Where a timeline list was when it went away (to the post page), with the measured post heights, so the list
// mounted again for it shows the same posts. The oldest entries go past MAX_SAVED_SCROLLS.
const savedScrolls = new Map<string, {offset: number; measurements: Array<VirtualItem>}>();

const YOU_CAN_T_VIEW_THESE_POSTS_DESCRIPTOR = msg({
	message: "You can't view these posts.",
	comment:
		'Shown in place of a feed when the server refuses it, for example because the feed is off for you or the account blocks you. Keep tone plain and not blaming.',
});
const SHOW_OLDER_POSTS_DESCRIPTOR = msg({
	message: 'Show older posts',
	comment:
		'Button at the end of a feed after several pages in a row held no posts to show (for example posts of accounts you no longer follow). Loads older posts.',
});
const COULDN_T_LOAD_POSTS_DESCRIPTOR = msg({
	message: "Couldn't load posts.",
	comment: 'Error shown in a feed when a page of posts fails to load. A retry button follows.',
});

interface FeedTimelineListProps {
	timelineKey: string;
	scrollerRef: React.RefObject<ScrollerHandle | null>;
	emptyText: string;
	// A titled empty state with an optional button (the empty home feed); without a title, only the text. The icon and
	// the title show on the desktop layout only, the phone layout keeps the text and the button.
	emptyTitle?: string;
	emptyAction?: {label: string; onClick: () => void};
	// Passed to every card: a list inside a modal closes the modal before a post page opens.
	onOpenPost?: () => void;
	// Micup: how far below the scroller's top the list starts, when other content (the profile header)
	// scrolls above it in the same scroller. 0, the list at the top, everywhere else.
	scrollMargin?: number;
}

// Virtualized: only the posts near the viewport are mounted, and the store keeps at most 200 posts per timeline.
export const FeedTimelineList = observer((props: FeedTimelineListProps) => {
	const {timelineKey, scrollerRef, emptyText, emptyTitle, emptyAction, onOpenPost, scrollMargin = 0} = props;
	const {i18n} = useLingui();
	const timeline = FeedTimeline.getTimeline(timelineKey);
	const posts = timeline?.posts ?? [];
	const getItemKey = useCallback((index: number) => posts[index]?.id ?? index, [posts]);
	// Only while the store still holds fresh posts; a timeline that loads again (stale or closed) starts at the top.
	const saved = posts.length > 0 && !FeedTimeline.isStale(timelineKey) ? savedScrolls.get(timelineKey) : undefined;
	const virtualizer = useVirtualizer({
		count: posts.length,
		getScrollElement: () => scrollerRef.current?.getViewportElement() ?? null,
		estimateSize: () => ESTIMATED_POST_HEIGHT_PX * getAppRemScale(),
		getItemKey,
		overscan: OVERSCAN_POSTS,
		scrollMargin,
		initialOffset: saved?.offset,
		initialMeasurementsCache: saved?.measurements,
	});
	// The Scroller around this list sets its handle only after the list's layout effects ran, so on mount the virtualizer
	// finds no scroll element. One more render after the commit lets it bind, or posts already in the store never show.
	const [, rerender] = useReducer((renders: number) => renders + 1, 0);
	useEffect(() => rerender(), []);
	useEffect(
		() => () => {
			savedScrolls.delete(timelineKey);
			savedScrolls.set(timelineKey, {offset: virtualizer.scrollOffset ?? 0, measurements: virtualizer.takeSnapshot()});
			const oldest = savedScrolls.keys().next().value;
			if (savedScrolls.size > MAX_SAVED_SCROLLS && oldest !== undefined) savedScrolls.delete(oldest);
		},
		[timelineKey, virtualizer],
	);
	const virtualRows = virtualizer.getVirtualItems();
	const lastVisibleIndex = virtualRows.at(-1)?.index ?? -1;
	useEffect(() => {
		if (lastVisibleIndex >= posts.length - OVERSCAN_POSTS) {
			void FeedCommands.loadNextPage(timelineKey);
		}
	}, [timelineKey, lastVisibleIndex, posts.length]);
	// Paging back past 200 posts drops the newest ones above the view; scroll up by their height so the view stays put.
	const droppedCount = timeline?.droppedCount ?? 0;
	const droppedCountRef = useRef(droppedCount);
	const startByPostIdRef = useRef(new Map<string, number>());
	useLayoutEffect(() => {
		const previousStart = posts[0] ? startByPostIdRef.current.get(posts[0].id) : undefined;
		const viewport = scrollerRef.current?.getViewportElement();
		if (droppedCount > droppedCountRef.current && viewport && previousStart) {
			viewport.scrollTop = Math.max(0, viewport.scrollTop - (previousStart - scrollMargin));
		}
		droppedCountRef.current = droppedCount;
		startByPostIdRef.current = new Map(virtualizer.measurementsCache.map((item) => [String(item.key), item.start]));
	});
	return (
		<>
			<div
				className={styles.rows}
				style={{height: virtualizer.getTotalSize()}}
				role="feed"
				aria-busy={timeline?.isLoading ?? false}
				data-flx="feed.feed-timeline-list.rows"
			>
				{virtualRows.map((virtualRow) => {
					const post = posts[virtualRow.index];
					if (!post) return null;
					return (
						<div
							key={post.id}
							ref={virtualizer.measureElement}
							data-index={virtualRow.index}
							className={styles.row}
							style={{transform: `translateY(${virtualRow.start - scrollMargin}px)`}}
							data-flx="feed.feed-timeline-list.row"
						>
							<FeedPostCard post={post} onOpenPost={onOpenPost} data-flx="feed.feed-timeline-list.feed-post-card" />
						</div>
					);
				})}
			</div>
			{timeline?.isLoading && (
				<div className={styles.status} data-flx="feed.feed-timeline-list.status">
					<Spinner size={posts.length === 0 ? 'medium' : 'small'} data-flx="feed.feed-timeline-list.spinner" />
				</div>
			)}
			{timeline?.failure === 'forbidden' && (
				<p className={styles.status} data-flx="feed.feed-timeline-list.status--2">
					{i18n._(YOU_CAN_T_VIEW_THESE_POSTS_DESCRIPTOR)}
				</p>
			)}
			{timeline?.failure === 'error' && (
				<div className={styles.status} data-flx="feed.feed-timeline-list.status--3">
					{i18n._(COULDN_T_LOAD_POSTS_DESCRIPTOR)}
					<Button
						small
						variant="secondary"
						onClick={() => void FeedCommands.retry(timelineKey)}
						data-flx="feed.feed-timeline-list.button.retry"
					>
						{i18n._(TRY_AGAIN_DESCRIPTOR)}
					</Button>
				</div>
			)}
			{timeline?.failure === 'paused' && (
				<div className={styles.status} data-flx="feed.feed-timeline-list.status--5">
					<Button
						small
						variant="secondary"
						onClick={() => void FeedCommands.retry(timelineKey)}
						data-flx="feed.feed-timeline-list.button.load-older"
					>
						{i18n._(SHOW_OLDER_POSTS_DESCRIPTOR)}
					</Button>
				</div>
			)}
			{timeline &&
				!timeline.isLoading &&
				!timeline.hasMore &&
				!timeline.failure &&
				posts.length === 0 &&
				(emptyTitle ? (
					<div className={styles.empty} data-flx="feed.feed-timeline-list.empty">
						{!MobileLayout.enabled && (
							<>
								<span className={styles.emptyIcon} aria-hidden data-flx="feed.feed-timeline-list.empty-icon">
									<UsersIcon size={remFromPx(22)} weight="bold" data-flx="feed.feed-timeline-list.users-icon" />
								</span>
								<h2 className={styles.emptyTitle} data-flx="feed.feed-timeline-list.empty-title">
									{emptyTitle}
								</h2>
							</>
						)}
						<p className={styles.emptyText} data-flx="feed.feed-timeline-list.empty-text">
							{emptyText}
						</p>
						{emptyAction && (
							<div className={styles.emptyActions} data-flx="feed.feed-timeline-list.empty-actions">
								<Button
									small
									fitContent
									leftIcon={
										<CompassIcon
											size={remFromPx(16)}
											weight="bold"
											aria-hidden
											data-flx="feed.feed-timeline-list.compass-icon"
										/>
									}
									onClick={emptyAction.onClick}
									data-flx="feed.feed-timeline-list.button.empty-action"
								>
									{emptyAction.label}
								</Button>
							</div>
						)}
					</div>
				) : (
					<p className={styles.status} data-flx="feed.feed-timeline-list.status--4">
						{emptyText}
					</p>
				))}
		</>
	);
});

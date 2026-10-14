// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import guildHeaderStyles from '@app/features/app/components/layout/GuildHeader.module.css';
import guildLayoutStyles from '@app/features/app/components/layout/GuildLayout.module.css';
import {GuildSidebar} from '@app/features/app/components/layout/GuildSidebar';
import Authentication from '@app/features/auth/state/Authentication';
import dmStyles from '@app/features/channel/components/direct_message/DirectMessageList.module.css';
import {DMListPageItems, DMListPageRow} from '@app/features/channel/components/direct_message/DMListPageItems';
import sidebarStyles from '@app/features/discovery/discovery/DiscoverySidebar.module.css';
import * as FeedCommands from '@app/features/feed/commands/FeedCommands';
import {FeedComposer} from '@app/features/feed/components/FeedComposer';
import {FeedNotificationsButton} from '@app/features/feed/components/FeedNotificationsButton';
import {FeedProfileAside} from '@app/features/feed/components/FeedProfileAside';
import {FeedSuggestions} from '@app/features/feed/components/FeedSuggestions';
import {FeedTimelineList} from '@app/features/feed/components/FeedTimelineList';
import styles from '@app/features/feed/components/pages/FeedPage.module.css';
import {FeedPostDetail} from '@app/features/feed/components/pages/FeedPostDetail';
import FeedSuggestionPicks from '@app/features/feed/state/FeedSuggestionPicks';
import FeedTabs, {type FeedTab} from '@app/features/feed/state/FeedTabs';
import FeedTimeline, {DISCOVER_TIMELINE, HOME_TIMELINE, userTimelineKey} from '@app/features/feed/state/FeedTimeline';
import {isFeedDiscoverEnabled, isFeedEnabled} from '@app/features/feed/utils/FeedUtils';
import * as RouterUtils from '@app/features/navigation/utils/RouterUtils';
import {remFromPx} from '@app/features/theme/layout/RemFromPx';
import {Button} from '@app/features/ui/button/Button';
import {Scroller, type ScrollerHandle} from '@app/features/ui/components/Scroller';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import {getNextTabIndex, getTabNavigationDirection} from '@app/features/ui/tabs/TabKeyboardNavigation';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {ArrowUpIcon, HouseIcon, NewspaperIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {type ReactNode, useEffect, useRef, useState} from 'react';

// Pull-only freshness (new posts are never pushed and the client does not poll): a timeline loads when its list first
// opens, and once its posts are older than this the "new posts" button offers the reload.
const NEW_POSTS_AFTER_MS = 60 * 1000;

const FEED_DESCRIPTOR = msg({
	message: 'Feed',
	comment: 'Short label in the sidebar navigation button that opens the feed of posts from followed accounts.',
});
const FEED_NAVIGATION_DESCRIPTOR = msg({
	message: 'Feed navigation',
	comment: 'Accessible label for the section navigation in the feed page sidebar.',
});
const HOME_FEED_DESCRIPTOR = msg({
	message: 'Home feed',
	comment: 'Feed page sidebar item and title for the posts of the accounts you follow. Keep it concise.',
});
const YOUR_POSTS_DESCRIPTOR = msg({
	message: 'Your posts',
	comment: 'Feed page sidebar item and title for the posts you published. Keep it concise.',
});
const SHOW_NEW_POSTS_DESCRIPTOR = msg({
	message: 'Show new posts',
	comment: 'Button over the feed that reloads it from the newest post.',
});
const HOME_EMPTY_DESCRIPTOR = msg({
	message: 'Posts from the accounts you follow show up here.',
	comment: 'Empty state of the home feed.',
});
const YOUR_POSTS_EMPTY_DESCRIPTOR = msg({
	message: "You haven't posted anything yet.",
	comment: 'Empty state of your own posts in the feed page.',
});
const HOME_EMPTY_TITLE_DESCRIPTOR = msg({
	message: 'No posts from people you follow yet',
	comment: 'Title of the empty home feed. True whether you follow nobody or they have not posted.',
});
const GO_TO_DISCOVER_DESCRIPTOR = msg({
	message: 'Go to Discover',
	comment: 'Button in the empty home feed that switches to the Discover tab. Keep it concise.',
});
const DISCOVER_EMPTY_DESCRIPTOR = msg({
	message: 'Popular public posts show up here.',
	comment: 'Empty state of the Discover feed, which lists popular public posts from everyone.',
});
const FEED_TABS_DESCRIPTOR = msg({
	message: 'Feed tabs',
	comment: 'Accessible label for the tab list at the top of the feed (Discover and People you follow).',
});
const DISCOVER_TAB_DESCRIPTOR = msg({
	message: 'Discover',
	comment: 'Feed page tab that shows popular public posts from everyone. Keep it concise.',
});
const FOLLOWING_TAB_DESCRIPTOR = msg({
	message: 'People you follow',
	comment: 'Feed page tab that shows the posts of the accounts you follow. Keep it concise.',
});

type FeedView = FeedTab | 'mine';

const feedTabId = (tab: FeedTab) => `feed-tab-${tab}`;
const feedPanelId = (tab: FeedTab) => `feed-panel-${tab}`;

// Fluxer tab list behaviour: one tab in the Tab order, the arrow keys (and Home/End) move and select.
const FeedTabList = ({tab}: {tab: FeedTab}) => {
	const {i18n} = useLingui();
	const tabs: ReadonlyArray<{tab: FeedTab; label: string}> = [
		{tab: 'discover', label: i18n._(DISCOVER_TAB_DESCRIPTOR)},
		{tab: 'home', label: i18n._(FOLLOWING_TAB_DESCRIPTOR)},
	];
	const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
		const direction = getTabNavigationDirection(event.key, 'horizontal');
		const nextIndex = direction ? getNextTabIndex(index, tabs.length, direction) : null;
		const next = nextIndex == null ? undefined : tabs[nextIndex];
		if (nextIndex == null || !next) return;
		event.preventDefault();
		event.stopPropagation();
		FeedTabs.setTab(next.tab);
		const tabList = event.currentTarget.closest('[role="tablist"]');
		tabList?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
	};
	return (
		<div
			className={styles.tabList}
			role="tablist"
			aria-label={i18n._(FEED_TABS_DESCRIPTOR)}
			data-flx="feed.feed-page.feed-tab-list.tab-list"
		>
			{tabs.map((item, index) => {
				const selected = item.tab === tab;
				return (
					<FocusRing key={item.tab} offset={-2} data-flx="feed.feed-page.feed-tab-list.focus-ring">
						<button
							id={feedTabId(item.tab)}
							type="button"
							role="tab"
							aria-selected={selected}
							aria-controls={feedPanelId(item.tab)}
							tabIndex={selected ? 0 : -1}
							className={clsx(styles.tab, selected && styles.tabSelected)}
							onClick={() => FeedTabs.setTab(item.tab)}
							onKeyDown={(event) => handleKeyDown(event, index)}
							data-flx="feed.feed-page.feed-tab-list.tab"
						>
							{item.label}
						</button>
					</FocusRing>
				);
			})}
		</div>
	);
};

const FeedMain = observer(({view, onViewChange}: {view: FeedView; onViewChange?: (view: FeedView) => void}) => {
	const {i18n} = useLingui();
	const scrollerRef = useRef<ScrollerHandle>(null);
	const currentUserId = Authentication.currentUserId;
	const hasTabs = view !== 'mine' && isFeedDiscoverEnabled();
	// The empty home feed points at Discover, the same switch as its tab; only while Discover is on.
	const emptyHome = hasTabs && view === 'home';
	// The empty state and its button go with the switch, so focus moves to the Discover tab instead of the page.
	const goToDiscover = () => {
		FeedTabs.setTab('discover');
		document.getElementById(feedTabId('discover'))?.focus();
	};
	const listPanelProps = hasTabs
		? {id: feedPanelId(view), role: 'tabpanel', 'aria-labelledby': feedTabId(view)}
		: undefined;
	const timelineKey =
		view === 'mine' && currentUserId
			? userTimelineKey(currentUserId)
			: view === 'discover'
				? DISCOVER_TIMELINE
				: HOME_TIMELINE;
	// The timelines stay loaded (held, at most 200 posts each) and are not reloaded when their list opens again: the list
	// comes back where it was, after a post page too (FeedTimelineList keeps the place only while the store holds fresh
	// posts), and a reload would move the posts under it. The "new posts" button offers the reload instead; only a list
	// loaded more than an hour ago (FEED_TIMELINE_STALE_MS) loads again, before the signed video URLs in it run out.
	useEffect(() => {
		FeedTimeline.hold(timelineKey);
		if (FeedTimeline.isStale(timelineKey)) void FeedCommands.refresh(timelineKey);
	}, [timelineKey]);
	const timeline = FeedTimeline.getTimeline(timelineKey);
	const fetchedAt = timeline?.fetchedAt ?? null;
	const [staleFetchedAt, setStaleFetchedAt] = useState<number | null>(null);
	useEffect(() => {
		if (fetchedAt == null) return;
		const timer = window.setTimeout(
			() => setStaleFetchedAt(fetchedAt),
			Math.max(0, fetchedAt + NEW_POSTS_AFTER_MS - Date.now()),
		);
		return () => window.clearTimeout(timer);
	}, [fetchedAt]);
	const showNewPosts =
		timeline != null &&
		!timeline.isLoading &&
		(timeline.droppedCount > 0 || (fetchedAt != null && staleFetchedAt === fetchedAt));
	const showNewPostsNow = () => {
		scrollerRef.current?.scrollTo({to: 0});
		void FeedCommands.refresh(timelineKey);
	};
	return (
		<div className={styles.main} data-flx="feed.feed-page.feed-main.main">
			<header className={styles.header} data-flx="feed.feed-page.feed-main.header">
				{hasTabs ? (
					<>
						{!MobileLayout.enabled && (
							<>
								<h1
									className={clsx(styles.headerTitle, styles.feedTitle)}
									data-flx="feed.feed-page.feed-main.feed-title"
								>
									{i18n._(FEED_DESCRIPTOR)}
								</h1>
								<span className={styles.headerDivider} aria-hidden data-flx="feed.feed-page.feed-main.header-divider" />
							</>
						)}
						<FeedTabList tab={view} data-flx="feed.feed-page.feed-main.feed-tab-list" />
					</>
				) : (
					<h1 className={styles.headerTitle} data-flx="feed.feed-page.feed-main.header-title">
						{i18n._(view === 'mine' ? YOUR_POSTS_DESCRIPTOR : HOME_FEED_DESCRIPTOR)}
					</h1>
				)}
				<FeedNotificationsButton data-flx="feed.feed-page.feed-main.feed-notifications-button" />
			</header>
			<div className={styles.body} data-flx="feed.feed-page.feed-main.body">
				<div className={styles.timeline} data-flx="feed.feed-page.feed-main.timeline">
					<div className={styles.composerColumn} data-flx="feed.feed-page.feed-main.composer-column">
						<FeedComposer announcePosted={view === 'discover'} data-flx="feed.feed-page.feed-main.feed-composer" />
					</div>
					<div className={styles.listArea} {...listPanelProps} data-flx="feed.feed-page.feed-main.list-area">
						{showNewPosts && (
							<div className={styles.newPosts} data-flx="feed.feed-page.feed-main.new-posts">
								<Button
									small
									fitContent
									className={styles.newPostsButton}
									leftIcon={
										<ArrowUpIcon
											size={remFromPx(16)}
											weight="bold"
											aria-hidden
											data-flx="feed.feed-page.feed-main.arrow-up-icon"
										/>
									}
									onClick={showNewPostsNow}
									data-flx="feed.feed-page.feed-main.button.show-new-posts"
								>
									{i18n._(SHOW_NEW_POSTS_DESCRIPTOR)}
								</Button>
							</div>
						)}
						{/* Keyed: each timeline has its own scroll position and virtual list; the header and composer stay. */}
						<Scroller key={timelineKey} ref={scrollerRef} data-flx="feed.feed-page.feed-main.scroller">
							<FeedTimelineList
								timelineKey={timelineKey}
								scrollerRef={scrollerRef}
								emptyText={i18n._(
									view === 'mine'
										? YOUR_POSTS_EMPTY_DESCRIPTOR
										: view === 'discover'
											? DISCOVER_EMPTY_DESCRIPTOR
											: HOME_EMPTY_DESCRIPTOR,
								)}
								emptyTitle={emptyHome ? i18n._(HOME_EMPTY_TITLE_DESCRIPTOR) : undefined}
								emptyAction={emptyHome ? {label: i18n._(GO_TO_DISCOVER_DESCRIPTOR), onClick: goToDiscover} : undefined}
								data-flx="feed.feed-page.feed-main.feed-timeline-list"
							/>
						</Scroller>
					</div>
				</div>
				{onViewChange && (
					<FeedProfileAside
						onShowPosts={view !== 'mine' ? () => onViewChange('mine') : undefined}
						data-flx="feed.feed-page.feed-main.feed-profile-aside"
					>
						<FeedSuggestions data-flx="feed.feed-page.feed-main.feed-suggestions" />
					</FeedProfileAside>
				)}
			</div>
		</div>
	);
});

// Micup: the DM list's rows (DMListPageItems), so both sidebars list premium, Bot System and the shop alike. On a page
// (children) no feed row is current: the page's own row is.
const FeedSidebarNav = observer(
	({view, onPage, onViewChange}: {view: FeedView; onPage: boolean; onViewChange: (view: FeedView) => void}) => {
		const {i18n} = useLingui();
		return (
			<div className={sidebarStyles.container} data-flx="feed.feed-page.feed-sidebar-nav.container">
				<Scroller
					showTrack={false}
					role="navigation"
					aria-label={i18n._(FEED_NAVIGATION_DESCRIPTOR)}
					data-flx="feed.feed-page.feed-sidebar-nav.scroller"
				>
					<div className={dmStyles.scrollerContent} role="list" data-flx="feed.feed-page.feed-sidebar-nav.nav-list">
						<div style={{height: 'var(--spacing-2)'}} data-flx="feed.feed-page.feed-sidebar-nav.top-space" />
						{/* "Home feed" stands for the feed tabs, so it is current on either tab. */}
						<DMListPageRow
							icon={HouseIcon}
							label={i18n._(HOME_FEED_DESCRIPTOR)}
							selected={!onPage && view !== 'mine'}
							onClick={() => onViewChange('home')}
							data-flx="feed.feed-page.feed-sidebar-nav.home"
						/>
						<DMListPageRow
							icon={NewspaperIcon}
							label={i18n._(YOUR_POSTS_DESCRIPTOR)}
							selected={!onPage && view === 'mine'}
							onClick={() => onViewChange('mine')}
							data-flx="feed.feed-page.feed-sidebar-nav.mine"
						/>
						<DMListPageItems data-flx="feed.feed-page.feed-sidebar-nav.page-items" />
					</div>
				</Scroller>
			</div>
		);
	},
);

// /feed, or with postId /feed/posts/:postId: the post page in place of the list, beside the same sidebar. Micup: with
// children (/feed/premium, /feed/shop, /feed/bots) that page in place of the list.
export const FeedPage = observer(({postId, children}: {postId?: string; children?: ReactNode}) => {
	const {i18n} = useLingui();
	const enabled = isFeedEnabled();
	useEffect(() => {
		if (!enabled) RouterUtils.replaceWith(Routes.ME);
	}, [enabled]);
	// Micup akis-oneri: the suggestions beside the feed are picked once per opening of this page.
	useEffect(() => FeedSuggestionPicks.reset, []);
	if (!enabled) return null;
	// The remembered tab, read on every render so a restored choice or Discover turned off applies at once.
	const tab: FeedTab = isFeedDiscoverEnabled() ? FeedTabs.selectedTab : 'home';
	const view: FeedView = FeedTabs.showMine ? 'mine' : tab;
	const setView = (next: FeedView) => {
		FeedTabs.setShowMine(next === 'mine');
		if (postId || children) RouterUtils.transitionTo(Routes.FEED);
	};
	if (MobileLayout.enabled) {
		if (children) return <>{children}</>;
		return postId ? (
			<FeedPostDetail key={postId} postId={postId} data-flx="feed.feed-page.feed-post-detail" />
		) : (
			<FeedMain view={tab} data-flx="feed.feed-page.feed-main--mobile" />
		);
	}
	return (
		<div className={guildLayoutStyles.guildLayoutContainer} data-flx="feed.feed-page.guild-layout-container">
			<div className={guildLayoutStyles.guildLayoutContent} data-flx="feed.feed-page.guild-layout-content">
				<GuildSidebar
					header={
						<div className={guildHeaderStyles.headerContainer} data-flx="feed.feed-page.sidebar-header">
							<h1 className={styles.sidebarHeaderTitle} data-flx="feed.feed-page.sidebar-header-title">
								{i18n._(FEED_DESCRIPTOR)}
							</h1>
						</div>
					}
					content={
						<FeedSidebarNav
							view={view}
							onPage={children != null}
							onViewChange={setView}
							data-flx="feed.feed-page.feed-sidebar-nav"
						/>
					}
					data-flx="feed.feed-page.guild-sidebar"
				/>
				<div className={guildLayoutStyles.guildMainContent} data-flx="feed.feed-page.guild-main-content">
					{children ??
						(postId ? (
							<FeedPostDetail
								key={postId}
								postId={postId}
								onShowPosts={() => setView('mine')}
								data-flx="feed.feed-page.feed-post-detail--2"
							/>
						) : (
							<FeedMain
								key={FeedTabs.showMine ? 'mine' : 'feed'}
								view={view}
								onViewChange={setView}
								data-flx="feed.feed-page.feed-main"
							/>
						))}
				</div>
			</div>
		</div>
	);
});

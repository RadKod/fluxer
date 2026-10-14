// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {runInAction} from 'mobx';
import {act, createElement, forwardRef, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
const nav = vi.hoisted(() => ({premium: true, shop: true, pathname: '/feed'}));
const premiumModalCommands = vi.hoisted(() => ({open: vi.fn()}));
const routerUtils = vi.hoisted(() => ({replaceWith: vi.fn(), transitionTo: vi.fn()}));
vi.mock('@app/features/messaging/utils/MessagingUrlUtils', () => ({marketingUrl: (path: string) => path}));
vi.mock('@app/features/platform/components/router/RouterReact', () => ({
	useLocation: () => ({pathname: nav.pathname}),
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'micup.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => 1000}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/premium/commands/PremiumModalCommands', () => premiumModalCommands);
vi.mock('@app/features/premium/utils/PremiumUtils', () => ({
	getPremiumProductName: () => 'sanalyer Plus',
	shouldShowPremiumFeatures: () => nav.premium,
}));
vi.mock('@app/features/shop/utils/ShopAvailability', () => ({isShopPageAvailable: () => nav.shop}));
vi.mock('@app/features/app/components/layout/GuildSidebar', () => ({
	GuildSidebar: ({header, content}: {header: ReactNode; content: ReactNode}) =>
		createElement('div', null, header, content),
}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: '1'}}));
vi.mock('@app/features/feed/commands/FeedCommands', () => ({refresh: vi.fn()}));
vi.mock('@app/features/feed/components/pages/FeedPostDetail', () => ({
	FeedPostDetail: ({postId}: {postId: string}) =>
		createElement('div', {'data-testid': 'post-detail', 'data-post-id': postId}),
}));
vi.mock('@app/features/feed/components/FeedNotificationsButton', () => ({
	FeedNotificationsButton: () => createElement('span', {'data-testid': 'notifications-button'}),
}));
vi.mock('@app/features/feed/components/FeedComposer', () => ({
	FeedComposer: ({announcePosted}: {announcePosted?: boolean}) =>
		createElement('div', {'data-testid': 'composer', 'data-announce-posted': String(announcePosted === true)}),
}));
vi.mock('@app/features/feed/components/FeedProfileAside', () => ({
	FeedProfileAside: ({onShowPosts, children}: {onShowPosts?: () => void; children?: ReactNode}) =>
		createElement(
			'aside',
			null,
			onShowPosts ? createElement('button', {type: 'button', onClick: onShowPosts}, 'Open your posts') : null,
			children,
		),
}));
// The suggestions request (FeedSuggestionCommands.loadSuggestions); by default an empty answer.
vi.mock('@app/features/platform/transport/RestTransport', () => ({
	http: {get: vi.fn(async () => ({body: {users: [], guilds: []}}))},
}));
// Loads the picks when it mounts, like the real section (FeedSuggestions.test.tsx), and shows the picked ids.
vi.mock('@app/features/feed/components/FeedSuggestions', async () => {
	const {useEffect} = await import('react');
	const {observer} = await import('mobx-react-lite');
	const {default: FeedSuggestionPicks} = await import('@app/features/feed/state/FeedSuggestionPicks');
	const {loadSuggestions} = await import('@app/features/feed/commands/FeedSuggestionCommands');
	return {
		FeedSuggestions: observer(() => {
			useEffect(() => {
				void loadSuggestions();
			}, []);
			return createElement('div', {'data-testid': 'suggestions'}, FeedSuggestionPicks.picks?.userIds.join(',') ?? '');
		}),
	};
});
vi.mock('@app/features/feed/components/FeedTimelineList', () => ({
	FeedTimelineList: ({
		timelineKey,
		emptyText,
		emptyTitle,
		emptyAction,
	}: {
		timelineKey: string;
		emptyText: string;
		emptyTitle?: string;
		emptyAction?: {label: string; onClick: () => void};
	}) =>
		createElement(
			'div',
			{'data-testid': 'timeline', 'data-timeline-key': timelineKey, 'data-empty-title': emptyTitle},
			emptyText,
			emptyAction ? createElement('button', {type: 'button', onClick: emptyAction.onClick}, emptyAction.label) : null,
		),
}));
const limits = vi.hoisted(() => ({discover: true}));
vi.mock('@app/features/feed/utils/FeedUtils', () => ({
	isFeedEnabled: () => true,
	isFeedDiscoverEnabled: () => limits.discover,
}));
vi.mock('@app/features/platform/utils/MobXPersistence', () => ({makePersistent: async () => {}}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => routerUtils);
vi.mock('@app/features/theme/layout/RemFromPx', () => ({remFromPx: (px: number) => px}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick}: {children: ReactNode; onClick: () => void}) =>
		createElement('button', {type: 'button', onClick}, children),
}));
vi.mock('@app/features/ui/components/Scroller', () => ({
	Scroller: forwardRef<HTMLDivElement, {children: ReactNode}>(({children}, ref) =>
		createElement('div', {ref, 'data-testid': 'scroller'}, children),
	),
}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: ReactNode}) => children}));
// Observable like the real store, so a mounted page follows the layout switch.
vi.mock('@app/features/ui/state/MobileLayout', async () => ({
	default: (await import('mobx')).observable({
		enabled: false,
		isMobileLayout() {
			return this.enabled;
		},
	}),
}));

// Idle and LocalPresence import each other; loading Idle first keeps its timer from calling a half-loaded store.
await import('@app/features/ui/state/Idle');
const {default: MobileLayout} = await import('@app/features/ui/state/MobileLayout');
const {default: FeedTabs} = await import('@app/features/feed/state/FeedTabs');
const {default: FeedSuggestionPicks} = await import('@app/features/feed/state/FeedSuggestionPicks');
const {http} = await import('@app/features/platform/transport/RestTransport');
// One suggestions answer: a person with this id, no communities.
const suggestionsOf = (id: string) => ({
	body: {
		users: [
			{id, username: `user${id}`, discriminator: '0001', global_name: null, avatar: null, avatar_color: null, flags: 0},
		],
		guilds: [],
	},
});
const {FeedPage} = await import('@app/features/feed/components/pages/FeedPage');
const {default: FeedTimeline, FEED_TIMELINE_STALE_MS} = await import('@app/features/feed/state/FeedTimeline');
const {default: styles} = await import('@app/features/feed/components/pages/FeedPage.module.css');
const {default: dmStyles} = await import(
	'@app/features/channel/components/direct_message/DirectMessageList.module.css'
);
const {default: pageItemStyles} = await import(
	'@app/features/channel/components/direct_message/DMListPageItems.module.css'
);

const wirePost = (id: string) => ({
	id,
	author: {
		id: '1',
		username: 'user1',
		discriminator: '0001',
		global_name: null,
		avatar: null,
		avatar_color: null,
		flags: 0,
	},
	content: `post ${id}`,
	attachments: [],
	edited_at: null,
	like_count: 0,
	comment_count: 0,
	liked: false,
});
const FeedCommands = await import('@app/features/feed/commands/FeedCommands');
const RouterUtils = await import('@app/features/navigation/utils/RouterUtils');

describe('FeedPage', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const title = () => container.querySelector('[data-flx="feed.feed-page.feed-main.header-title"]')?.textContent;
	const button = (label: string) =>
		Array.from(container.querySelectorAll('button')).find((element) => element.textContent === label);
	const openYourPosts = () => button('Open your posts');
	const tabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
	const tab = (label: string) => tabs().find((element) => element.textContent === label)!;
	const shownTimeline = () =>
		container.querySelector('[data-testid="timeline"]')?.getAttribute('data-timeline-key') ?? null;
	const render = () => act(() => root.render(createElement(FeedPage)));
	const detail = () => container.querySelector('[data-testid="post-detail"]')?.getAttribute('data-post-id') ?? null;
	// Each route renders its own FeedPage, so going between /feed and a post page mounts a new one.
	const navigate = (postId?: string) => {
		act(() => root.unmount());
		root = createRoot(container);
		act(() => root.render(createElement(FeedPage, {postId})));
	};

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		(MobileLayout as {enabled: boolean}).enabled = false;
		limits.discover = true;
		Object.assign(nav, {premium: true, shop: true, pathname: '/feed'});
		premiumModalCommands.open.mockClear();
		routerUtils.transitionTo.mockClear();
		FeedTabs.setTab('discover');
		FeedTabs.setShowMine(false);
		FeedTimeline.reset();
		vi.clearAllMocks();
		FeedSuggestionPicks.reset();
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it('shows your profile card beside the home feed and opens your posts from it', () => {
		limits.discover = false;
		act(() => root.render(createElement(FeedPage)));
		expect(container.querySelector('[data-flx="feed.feed-page.feed-main.main"] aside')).not.toBeNull();
		expect(title()).toBe('Home feed');
		act(() => openYourPosts()!.click());
		expect(title()).toBe('Your posts');
		expect(container.querySelector('[data-flx="feed.feed-page.feed-main.main"] aside')).not.toBeNull();
		expect(openYourPosts()).toBeUndefined();
	});

	it('puts the suggestions inside the profile rail on every feed tab', () => {
		const suggestionsInRail = () =>
			container.querySelector('[data-flx="feed.feed-page.feed-main.main"] aside [data-testid="suggestions"]') !== null;
		render();
		expect(shownTimeline()).toBe('discover');
		expect(suggestionsInRail()).toBe(true);
		act(() => tab('People you follow').click());
		expect(shownTimeline()).toBe('home');
		expect(suggestionsInRail()).toBe(true);
		act(() => openYourPosts()!.click());
		expect(title()).toBe('Your posts');
		expect(suggestionsInRail()).toBe(true);
		act(() => root.unmount());
		limits.discover = false;
		FeedTabs.setShowMine(false);
		root = createRoot(container);
		render();
		expect(title()).toBe('Home feed');
		expect(suggestionsInRail()).toBe(true);
	});

	it('Home feed → Your posts → Home feed sends one request and keeps the picks', async () => {
		const suggestions = () => container.querySelector('[data-testid="suggestions"]')?.textContent;
		vi.mocked(http.get)
			.mockResolvedValueOnce(suggestionsOf('7') as never)
			.mockResolvedValueOnce(suggestionsOf('8') as never);
		limits.discover = false;
		await act(async () => root.render(createElement(FeedPage)));
		expect(title()).toBe('Home feed');
		expect(suggestions()).toBe('7');
		// Your posts mounts the feed column again (keyed), rail included.
		await act(async () => openYourPosts()!.click());
		expect(title()).toBe('Your posts');
		expect(suggestions()).toBe('7');
		await act(async () => button('Home feed')!.click());
		expect(title()).toBe('Home feed');
		expect(suggestions()).toBe('7');
		expect(http.get).toHaveBeenCalledTimes(1);
		// Leaving the feed page drops them: the next opening picks again.
		act(() => root.unmount());
		root = createRoot(container);
		await act(async () => root.render(createElement(FeedPage)));
		expect(http.get).toHaveBeenCalledTimes(2);
		expect(suggestions()).toBe('8');
	});

	it('keeps the picks without a second request across the phone layout and back', async () => {
		const suggestions = () => container.querySelector('[data-testid="suggestions"]')?.textContent;
		vi.mocked(http.get).mockResolvedValueOnce(suggestionsOf('7') as never);
		await act(async () => root.render(createElement(FeedPage)));
		expect(suggestions()).toBe('7');
		// The same page switches its layout in place (MobileLayout is observed), dropping the rail and bringing it back.
		const setMobile = (enabled: boolean) =>
			act(async () => runInAction(() => ((MobileLayout as {enabled: boolean}).enabled = enabled)));
		await setMobile(true);
		expect(container.querySelector('[data-flx="feed.feed-page.feed-main.main"]')).not.toBeNull();
		expect(container.querySelector('aside')).toBeNull();
		await setMobile(false);
		expect(suggestions()).toBe('7');
		expect(http.get).toHaveBeenCalledTimes(1);
	});

	it('has no profile card on the narrow layout', () => {
		(MobileLayout as {enabled: boolean}).enabled = true;
		act(() => root.render(createElement(FeedPage)));
		expect(container.querySelector('[data-flx="feed.feed-page.feed-main.main"]')).not.toBeNull();
		expect(container.querySelector('aside')).toBeNull();
	});

	it('shows Discover and People you follow tabs, Discover first and selected on first open', () => {
		render();
		expect(container.querySelector('[role="tablist"]')!.getAttribute('aria-label')).toBe('Feed tabs');
		expect(tabs().map((element) => element.textContent)).toEqual(['Discover', 'People you follow']);
		expect(tabs().map((element) => element.getAttribute('aria-selected'))).toEqual(['true', 'false']);
		expect(title()).toBeUndefined();
		expect(shownTimeline()).toBe('discover');
		expect(container.querySelector('[data-testid="timeline"]')!.textContent).toBe('Popular public posts show up here.');
		expect(button('Home feed')!.getAttribute('aria-current')).toBe('page');
	});

	it('switching tabs remembers the choice and shows that timeline', () => {
		render();
		const following = tab('People you follow');
		following.focus();
		act(() => following.click());
		expect(FeedTabs.selectedTab).toBe('home');
		expect(shownTimeline()).toBe('home');
		expect(tabs().map((element) => element.getAttribute('aria-selected'))).toEqual(['false', 'true']);
		// The tab list stays in place, so keyboard focus is not lost to the page.
		expect(document.activeElement).toBe(tab('People you follow'));
		act(() => root.unmount());
		root = createRoot(container);
		render();
		expect(shownTimeline()).toBe('home');
		expect(tab('People you follow').getAttribute('aria-selected')).toBe('true');
	});

	it('moves between the tabs with the arrow keys and keeps focus on them', () => {
		render();
		const discover = tab('Discover');
		discover.focus();
		act(() => {
			discover.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
		});
		expect(FeedTabs.selectedTab).toBe('home');
		expect(document.activeElement).toBe(tab('People you follow'));
		expect(tabs().map((element) => element.tabIndex)).toEqual([-1, 0]);
	});

	it('hides the tabs and shows the home feed when feature_feed_discover is 0', () => {
		limits.discover = false;
		render();
		expect(tabs()).toEqual([]);
		expect(container.querySelector('[role="tabpanel"]')).toBeNull();
		expect(title()).toBe('Home feed');
		expect(shownTimeline()).toBe('home');
	});

	// Fluxer tab pattern (DMFriendsView, InboxPopout): each tab names the panel it controls, the panel names its tab.
	it('ties each tab to the feed list it shows, and has no tab panel on Your posts', () => {
		render();
		const panel = () => container.querySelector('[role="tabpanel"]');
		expect(tabs().map((element) => [element.id, element.getAttribute('aria-controls')])).toEqual([
			['feed-tab-discover', 'feed-panel-discover'],
			['feed-tab-home', 'feed-panel-home'],
		]);
		expect(panel()?.id).toBe('feed-panel-discover');
		expect(panel()?.getAttribute('aria-labelledby')).toBe('feed-tab-discover');
		expect(panel()?.contains(container.querySelector('[data-testid="timeline"]'))).toBe(true);
		act(() => tab('People you follow').click());
		expect(panel()?.id).toBe('feed-panel-home');
		expect(panel()?.getAttribute('aria-labelledby')).toBe('feed-tab-home');
		act(() => openYourPosts()!.click());
		expect(panel()).toBeNull();
	});

	it('asks the composer to confirm a new post only on Discover, where your own posts are not listed', () => {
		render();
		const announces = () => container.querySelector('[data-testid="composer"]')!.getAttribute('data-announce-posted');
		expect(announces()).toBe('true');
		act(() => tab('People you follow').click());
		expect(announces()).toBe('false');
		act(() => tab('Discover').click());
		act(() => openYourPosts()!.click());
		expect(announces()).toBe('false');
	});

	it('shows the Feed title and a divider before the tabs on the desktop layout only', () => {
		const header = () => container.querySelector('[data-flx="feed.feed-page.feed-main.header"]')!;
		const divider = () => header().querySelector('[data-flx="feed.feed-page.feed-main.header-divider"]');
		render();
		const heading = header().querySelector('h1')!;
		expect(heading.textContent).toBe('Feed');
		// The smaller desktop type is this title's own class, not the sidebar title's or another page's.
		expect(heading.classList).toContain(styles.feedTitle);
		expect(container.querySelector('[data-flx="feed.feed-page.sidebar-header-title"]')!.classList).not.toContain(
			styles.feedTitle,
		);
		expect(heading.nextElementSibling).toBe(divider());
		expect(divider()!.getAttribute('aria-hidden')).toBe('true');
		expect(divider()!.nextElementSibling!.getAttribute('role')).toBe('tablist');
		act(() => root.unmount());
		(MobileLayout as {enabled: boolean}).enabled = true;
		root = createRoot(container);
		render();
		expect(header().querySelector('h1')).toBeNull();
		expect(divider()).toBeNull();
		expect(tabs().map((element) => element.textContent)).toEqual(['Discover', 'People you follow']);
	});

	it('ends the header with the inbox button on both layouts and in every view', () => {
		const lastInHeader = () =>
			container
				.querySelector('[data-flx="feed.feed-page.feed-main.header"]')!
				.lastElementChild?.getAttribute('data-testid');
		render();
		expect(lastInHeader()).toBe('notifications-button');
		act(() => openYourPosts()!.click());
		expect(title()).toBe('Your posts');
		expect(lastInHeader()).toBe('notifications-button');
		act(() => root.unmount());
		FeedTabs.setShowMine(false);
		(MobileLayout as {enabled: boolean}).enabled = true;
		root = createRoot(container);
		render();
		expect(tabs()).toHaveLength(2);
		expect(lastInHeader()).toBe('notifications-button');
	});

	// The empty home feed and its button go away with the switch: focus moves to the Discover tab, not to the page.
	it('puts focus on the Discover tab after Go to Discover', () => {
		render();
		act(() => tab('People you follow').click());
		const goToDiscover = button('Go to Discover')!;
		goToDiscover.focus();
		act(() => goToDiscover.click());
		expect(document.activeElement).toBe(tab('Discover'));
	});

	// One row for both sidebars: the feed's rows are the DM list rows, with the same icon chip, height and gaps.
	it('draws every sidebar row as a DM list row, in the DM list column', () => {
		render();
		expect(button('Home feed')!.closest('[role="list"]')!.classList).toContain(dmStyles.scrollerContent);
		expect(button('Home feed')!.classList).toContain(dmStyles.clickableItemSelected);
		expect(button('Your posts')!.classList).toContain(dmStyles.clickableItem);
		expect(button('Your posts')!.classList).not.toContain(dmStyles.clickableItemSelected);
		for (const label of ['Home feed', 'Your posts', 'sanalyer Plus', 'Shop', 'Bot System']) {
			expect(button(label)!.querySelector(`.${dmStyles.clickableItemIcon} svg`)).not.toBeNull();
		}
		act(() => button('Your posts')!.click());
		expect(button('Your posts')!.classList).toContain(dmStyles.clickableItemSelected);
		expect(button('Home feed')!.classList).not.toContain(dmStyles.clickableItemSelected);
		expect(button('sanalyer Plus')!.classList).toContain(pageItemStyles.accent);
		expect(button('Shop')!.classList).toContain(pageItemStyles.accent);
		expect(button('Bot System')!.classList).not.toContain(pageItemStyles.accent);
	});

	it('passes an empty title and a Discover button only to the home feed while Discover is on', () => {
		const emptyTitle = () => container.querySelector('[data-testid="timeline"]')!.getAttribute('data-empty-title');
		render();
		expect(emptyTitle()).toBeNull();
		expect(button('Go to Discover')).toBeUndefined();
		act(() => tab('People you follow').click());
		expect(emptyTitle()).toBe('No posts from people you follow yet');
		expect(container.querySelector('[data-testid="timeline"]')!.textContent).toContain(
			'Posts from the accounts you follow show up here.',
		);
		act(() => button('Go to Discover')!.click());
		expect(FeedTabs.selectedTab).toBe('discover');
		expect(shownTimeline()).toBe('discover');
		expect(emptyTitle()).toBeNull();
		act(() => openYourPosts()!.click());
		expect(emptyTitle()).toBeNull();
		expect(button('Go to Discover')).toBeUndefined();
		// Content, not layout: the phone layout gets the same button.
		act(() => root.unmount());
		(MobileLayout as {enabled: boolean}).enabled = true;
		FeedTabs.setShowMine(false);
		FeedTabs.setTab('home');
		root = createRoot(container);
		render();
		expect(emptyTitle()).toBe('No posts from people you follow yet');
		expect(button('Go to Discover')).toBeDefined();
		act(() => root.unmount());
		(MobileLayout as {enabled: boolean}).enabled = false;
		limits.discover = false;
		root = createRoot(container);
		render();
		expect(shownTimeline()).toBe('home');
		expect(emptyTitle()).toBeNull();
		expect(button('Go to Discover')).toBeUndefined();
	});

	it('keeps the tabs on the phone layout', () => {
		(MobileLayout as {enabled: boolean}).enabled = true;
		render();
		expect(tabs().map((element) => element.textContent)).toEqual(['Discover', 'People you follow']);
		expect(shownTimeline()).toBe('discover');
		act(() => tab('People you follow').click());
		expect(shownTimeline()).toBe('home');
	});

	it('Your posts view keeps its title and no tabs', () => {
		render();
		act(() => openYourPosts()!.click());
		expect(title()).toBe('Your posts');
		expect(tabs()).toEqual([]);
		expect(shownTimeline()).toBe('user:1');
		act(() => button('Home feed')!.click());
		expect(shownTimeline()).toBe('discover');
		expect(tab('Discover').getAttribute('aria-selected')).toBe('true');
	});

	// Premium and the shop, listed and opened as in the DM list (DirectMessageList), under the feed items.
	const sidebarItems = () =>
		Array.from(
			container.querySelectorAll('[data-flx="feed.feed-page.feed-sidebar-nav.nav-list"] button'),
			(element) => element.textContent,
		);
	const sidebarItem = (label: string) =>
		Array.from(
			container.querySelectorAll<HTMLButtonElement>('[data-flx="feed.feed-page.feed-sidebar-nav.nav-list"] button'),
		).find((element) => element.textContent === label);
	// The gates are read on render; a fresh root picks up changed gates.
	const renderAgain = () => {
		act(() => root.unmount());
		root = createRoot(container);
		render();
	};

	it('lists premium and the shop under Your posts', () => {
		render();
		expect(sidebarItems()).toEqual(['Home feed', 'Your posts', 'sanalyer Plus', 'Shop', 'Bot System']);
		expect(sidebarItem('sanalyer Plus')!.getAttribute('aria-current')).toBeNull();
		expect(sidebarItem('Shop')!.getAttribute('aria-current')).toBeNull();
		expect(sidebarItem('Home feed')!.getAttribute('aria-current')).toBe('page');
	});

	it('opens premium the way the DM list does and goes to the shop page', () => {
		render();
		act(() => sidebarItem('sanalyer Plus')!.click());
		expect(premiumModalCommands.open).toHaveBeenCalledTimes(1);
		act(() => sidebarItem('Shop')!.click());
		expect(routerUtils.transitionTo).toHaveBeenCalledWith('/shop');
		// Leaving for another page does not switch the feed view.
		expect(shownTimeline()).toBe('discover');
	});

	it('hides premium and the shop where the DM list hides them', () => {
		nav.premium = false;
		render();
		expect(sidebarItems()).toEqual(['Home feed', 'Your posts', 'Shop', 'Bot System']);
		nav.shop = false;
		renderAgain();
		expect(sidebarItems()).toEqual(['Home feed', 'Your posts', 'Bot System']);
	});

	it('opens Bot System from the feed sidebar without changing the selected feed', () => {
		render();
		expect(sidebarItem('Bot System')).toBeDefined();
		expect(sidebarItem('Bot System')?.getAttribute('aria-current')).toBeNull();
		act(() => sidebarItem('Bot System')?.click());
		expect(routerUtils.transitionTo).toHaveBeenCalledWith('/bots');
		expect(shownTimeline()).toBe('discover');
	});

	// /feed/premium, /feed/shop and /feed/bots: the page in place of the feed, beside the same sidebar.
	const renderPage = (pathname: string) => {
		nav.pathname = pathname;
		act(() => root.render(createElement(FeedPage, null, createElement('div', {'data-testid': 'page'}, pathname))));
	};
	const page = () => container.querySelector('[data-testid="page"]');

	it.each([
		['/feed/premium', 'sanalyer Plus'],
		['/feed/bots', 'Bot System'],
		['/feed/shop', 'Shop'],
	])('shows %s in the main column beside the sidebar, with %s as the current page', (pathname, label) => {
		renderPage(pathname);
		expect(page()?.textContent).toBe(pathname);
		expect(container.querySelector('[data-flx="feed.feed-page.guild-main-content"]')!.contains(page())).toBe(true);
		expect(shownTimeline()).toBeNull();
		expect(container.querySelector('[data-testid="composer"]')).toBeNull();
		expect(sidebarItem(label)!.getAttribute('aria-current')).toBe('page');
		expect(sidebarItem('Home feed')!.getAttribute('aria-current')).toBeNull();
		expect(sidebarItem('Your posts')!.getAttribute('aria-current')).toBeNull();
	});

	it('leaves a page for the list picked in the sidebar', () => {
		renderPage('/feed/shop');
		act(() => sidebarItem('Your posts')!.click());
		expect(FeedTabs.showMine).toBe(true);
		expect(RouterUtils.transitionTo).toHaveBeenLastCalledWith('/feed');
		act(() => sidebarItem('Home feed')!.click());
		expect(FeedTabs.showMine).toBe(false);
		expect(RouterUtils.transitionTo).toHaveBeenLastCalledWith('/feed');
	});

	it('shows only the page on the phone layout', () => {
		(MobileLayout as {enabled: boolean}).enabled = true;
		renderPage('/feed/premium');
		expect(page()?.textContent).toBe('/feed/premium');
		expect(sidebarItem('Home feed')).toBeUndefined();
		expect(shownTimeline()).toBeNull();
	});

	it('keeps the composer out of the scroller the virtual list measures', () => {
		act(() => root.render(createElement(FeedPage)));
		const composer = container.querySelector('[data-testid="composer"]');
		expect(composer).not.toBeNull();
		expect(container.querySelector('[data-testid="scroller"]')!.contains(composer)).toBe(false);
	});

	it('shows the post in the main column beside the same sidebar, with no feed list or composer', () => {
		navigate('42');
		expect(detail()).toBe('42');
		expect(button('Home feed')!.getAttribute('aria-current')).toBe('page');
		expect(shownTimeline()).toBeNull();
		expect(tabs()).toEqual([]);
		expect(container.querySelector('[data-testid="composer"]')).toBeNull();
	});

	it('renders the same detail on a narrow screen', () => {
		(MobileLayout as {enabled: boolean}).enabled = true;
		navigate('42');
		expect(detail()).toBe('42');
		expect(button('Home feed')).toBeUndefined();
		expect(shownTimeline()).toBeNull();
		expect(tabs()).toEqual([]);
	});

	it('leaves a post page for the list picked in the sidebar', () => {
		navigate('42');
		act(() => button('Your posts')!.click());
		expect(FeedTabs.showMine).toBe(true);
		expect(RouterUtils.transitionTo).toHaveBeenCalledWith('/feed');
	});

	it('comes back to Your posts after a post page', () => {
		render();
		act(() => openYourPosts()!.click());
		navigate('42');
		expect(button('Your posts')!.getAttribute('aria-current')).toBe('page');
		navigate();
		expect(title()).toBe('Your posts');
		expect(shownTimeline()).toBe('user:1');
	});

	// FeedTimelineList puts a list back where it was only while the store still holds its posts, so the page keeps
	// the timeline loaded and does not reload it under the restored place; the new posts button offers the reload.
	it('comes back to the same list after a post page without loading it again', async () => {
		render();
		act(() => openYourPosts()!.click());
		FeedTimeline.handleFetchSuccess('user:1', [wirePost('9')], true);
		vi.mocked(FeedCommands.refresh).mockClear();
		const tenMinutesLater = Date.now() + 10 * 60 * 1000;
		vi.spyOn(Date, 'now').mockReturnValue(tenMinutesLater);
		navigate('42');
		navigate();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(shownTimeline()).toBe('user:1');
		expect(FeedTimeline.getTimeline('user:1')!.posts.map((post) => post.id)).toEqual(['9']);
		expect(FeedCommands.refresh).not.toHaveBeenCalled();
		expect(button('Show new posts')).toBeDefined();
		vi.restoreAllMocks();
	});

	// The signed video URLs of its posts run out 2 to 3 hours after they were loaded (FeedVideoUrls on the server).
	it('loads a list again once its posts are more than an hour old', () => {
		render();
		FeedTimeline.handleFetchSuccess('discover', [wirePost('9')], true, '1.1');
		const fetchedAt = FeedTimeline.getTimeline('discover')!.fetchedAt!;
		const reopenAfter = (ms: number) => {
			act(() => root.unmount());
			vi.mocked(FeedCommands.refresh).mockClear();
			vi.spyOn(Date, 'now').mockReturnValue(fetchedAt + ms);
			root = createRoot(container);
			render();
		};
		expect(FEED_TIMELINE_STALE_MS).toBe(3_600_000);
		reopenAfter(FEED_TIMELINE_STALE_MS);
		expect(FeedCommands.refresh).not.toHaveBeenCalled();
		reopenAfter(FEED_TIMELINE_STALE_MS + 1);
		expect(FeedCommands.refresh).toHaveBeenCalledExactlyOnceWith('discover');
		vi.restoreAllMocks();
	});

	it('loads a timeline that holds nothing yet when its list opens', () => {
		render();
		expect(FeedCommands.refresh).toHaveBeenCalledWith('discover');
	});
});

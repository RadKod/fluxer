// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ScrollerHandle} from '@app/features/ui/components/Scroller';
import type {FeedPostResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {useVirtualizer} from '@tanstack/react-virtual';
import {act, createElement, type ReactNode, type RefObject, useImperativeHandle} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@tanstack/react-virtual', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@tanstack/react-virtual')>();
	return {...actual, useVirtualizer: vi.fn(actual.useVirtualizer)};
});
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'micup.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => 1000}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/feed/commands/FeedCommands', () => ({loadNextPage: vi.fn(), retry: vi.fn()}));
vi.mock('@app/features/feed/components/FeedPostCard', () => ({FeedPostCard: vi.fn(() => null)}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick}: {children: ReactNode; onClick: () => void}) =>
		createElement('button', {type: 'button', onClick}, children),
}));
vi.mock('@app/features/ui/components/Spinner', () => ({Spinner: () => null}));
vi.mock('@app/features/ui/utils/AppZoomUtils', () => ({getAppRemScale: () => 1}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {enabled: false}}));

const FeedCommands = await import('@app/features/feed/commands/FeedCommands');
const {default: MobileLayout} = await import('@app/features/ui/state/MobileLayout');
const {FeedPostCard} = await import('@app/features/feed/components/FeedPostCard');
const {default: FeedTimeline, HOME_TIMELINE, userTimelineKey} = await import('@app/features/feed/state/FeedTimeline');

function wirePost(id: number): FeedPostResponse {
	return {
		id: String(id),
		author: {
			id: '7',
			username: 'user7',
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
	};
}
const {FeedTimelineList} = await import('@app/features/feed/components/FeedTimelineList');

describe('FeedTimelineList', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.mocked(FeedPostCard).mockClear();
		vi.mocked(useVirtualizer).mockClear();
		(MobileLayout as {enabled: boolean}).enabled = false;
		FeedTimeline.reset();
		FeedTimeline.open(HOME_TIMELINE);
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it('offers older posts once the automatic paging past empty pages paused, and goes on from there', () => {
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [], false, '900');
		FeedTimeline.handleFetchFailure(HOME_TIMELINE, 'paused');
		act(() =>
			root.render(
				createElement(FeedTimelineList, {timelineKey: HOME_TIMELINE, scrollerRef: {current: null}, emptyText: 'Boş'}),
			),
		);

		const button = Array.from(container.querySelectorAll('button')).find(
			(entry) => entry.textContent === 'Show older posts',
		);
		expect(button).toBeDefined();
		expect(container.textContent).not.toContain('Boş');
		act(() => button!.click());
		expect(FeedCommands.retry).toHaveBeenCalledWith(HOME_TIMELINE);
	});

	const renderEmpty = (props: {emptyTitle?: string; emptyAction?: {label: string; onClick: () => void}}) => {
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [], true);
		act(() =>
			root.render(
				createElement(FeedTimelineList, {
					timelineKey: HOME_TIMELINE,
					scrollerRef: {current: null},
					emptyText: 'Posts from the accounts you follow show up here.',
					...props,
				}),
			),
		);
	};

	it('shows the empty title, text and action', () => {
		const onClick = vi.fn();
		renderEmpty({emptyTitle: 'No posts from people you follow yet', emptyAction: {label: 'Go to Discover', onClick}});
		const empty = container.querySelector('[data-flx="feed.feed-timeline-list.empty"]')!;
		expect(empty.querySelector('[data-flx="feed.feed-timeline-list.empty-icon"]')!.getAttribute('aria-hidden')).toBe(
			'true',
		);
		expect(empty.querySelector('h2')!.textContent).toBe('No posts from people you follow yet');
		expect(empty.querySelector('p')!.textContent).toBe('Posts from the accounts you follow show up here.');
		const button = empty.querySelector('button')!;
		expect(button.textContent).toBe('Go to Discover');
		act(() => button.click());
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	// The icon and the title are the desktop layout's; the phone keeps its text, and the button is content.
	it('shows the text and the action without the icon and title on the phone layout', () => {
		(MobileLayout as {enabled: boolean}).enabled = true;
		const onClick = vi.fn();
		renderEmpty({emptyTitle: 'No posts from people you follow yet', emptyAction: {label: 'Go to Discover', onClick}});
		const empty = container.querySelector('[data-flx="feed.feed-timeline-list.empty"]')!;
		expect(empty.querySelector('[data-flx="feed.feed-timeline-list.empty-icon"]')).toBeNull();
		expect(empty.querySelector('h2')).toBeNull();
		expect(empty.querySelector('p')!.textContent).toBe('Posts from the accounts you follow show up here.');
		act(() => empty.querySelector('button')!.click());
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it('shows only the text when no title is given', () => {
		renderEmpty({});
		expect(container.querySelector('[data-flx="feed.feed-timeline-list.empty"]')).toBeNull();
		expect(container.querySelector('h2')).toBeNull();
		expect(container.querySelector('button')).toBeNull();
		expect(container.querySelector('[data-flx="feed.feed-timeline-list.status--4"]')!.textContent).toBe(
			'Posts from the accounts you follow show up here.',
		);
	});

	// A 600px scroll element the virtualizer can read and move, as the Scroller gives it (happy-dom has no layout).
	const scrollerFor = (viewport: HTMLElement) => {
		Object.defineProperty(viewport, 'offsetHeight', {value: 600});
		Object.defineProperty(viewport, 'offsetWidth', {value: 600});
		return {current: {getViewportElement: () => viewport}} as never;
	};
	const renderList = (timelineKey: string, viewport: HTMLElement, onOpenPost?: () => void) =>
		act(() =>
			root.render(
				createElement(FeedTimelineList, {timelineKey, scrollerRef: scrollerFor(viewport), emptyText: '', onOpenPost}),
			),
		);

	it('preserves post measurements through scroll and unrelated rerenders when posts stay the same', () => {
		FeedTimeline.handleFetchSuccess(
			HOME_TIMELINE,
			Array.from({length: 200}, (_, index) => wirePost(300 - index)),
			true,
		);
		const viewport = document.createElement('div');
		renderList(HOME_TIMELINE, viewport);
		const virtualizer = vi.mocked(useVirtualizer).mock.results.at(-1)!.value;
		const getItemKey = virtualizer.options.getItemKey;
		const measurements = virtualizer.measurementsCache;
		act(() => {
			viewport.scrollTop = 900;
			viewport.dispatchEvent(new Event('scroll'));
		});
		expect(virtualizer.options.getItemKey).toBe(getItemKey);
		expect(virtualizer.measurementsCache).toBe(measurements);
		renderList(HOME_TIMELINE, viewport, vi.fn());
		expect(virtualizer.options.getItemKey).toBe(getItemKey);
		expect(virtualizer.measurementsCache).toBe(measurements);
		expect(virtualizer.options.overscan).toBe(4);
	});

	it('refreshes keys for prepends, removals, reordered replacements and a different timeline', () => {
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost(3), wirePost(2)], true);
		const viewport = document.createElement('div');
		renderList(HOME_TIMELINE, viewport);
		const virtualizer = vi.mocked(useVirtualizer).mock.results.at(-1)!.value;
		const keys = () => virtualizer.measurementsCache.map((item: {key: string | number}) => item.key);
		expect(keys()).toEqual(['3', '2']);
		act(() => FeedTimeline.handlePostCreated(wirePost(4)));
		expect(keys()).toEqual(['4', '3', '2']);
		act(() => FeedTimeline.handlePostRemoved('3'));
		expect(keys()).toEqual(['4', '2']);
		act(() => FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost(2), wirePost(4)], true));
		expect(keys()).toEqual(['2', '4']);
		const other = userTimelineKey('7');
		FeedTimeline.open(other);
		FeedTimeline.handleFetchSuccess(other, [wirePost(9)], true);
		renderList(other, viewport);
		expect(keys()).toEqual(['9']);
		expect(virtualizer.options.getItemKey(1)).toBe(1);
	});

	it('passes onOpenPost to its cards', () => {
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost(3), wirePost(2)], false);
		const onOpenPost = vi.fn();
		renderList(HOME_TIMELINE, document.createElement('div'), onOpenPost);
		const cards = vi
			.mocked(FeedPostCard)
			.mock.calls.map(([props]) => props as {post: {id: string}; onOpenPost?: unknown});
		expect(cards.map((props) => props.post.id)).toContain('3');
		expect(cards.every((props) => props.onOpenPost === onOpenPost)).toBe(true);
	});

	// The Scroller sets its handle after the list inside it ran its layout effects, so the list mounts with an empty ref.
	const renderInScroller = (timelineKey: string, viewport: HTMLElement) => {
		Object.defineProperty(viewport, 'offsetHeight', {value: 600});
		Object.defineProperty(viewport, 'offsetWidth', {value: 600});
		const scrollerRef: RefObject<ScrollerHandle | null> = {current: null};
		const Scroller = ({children}: {children: ReactNode}) => {
			useImperativeHandle(scrollerRef, () => ({getViewportElement: () => viewport}) as unknown as ScrollerHandle);
			return children;
		};
		act(() =>
			root.render(
				createElement(Scroller, null, createElement(FeedTimelineList, {timelineKey, scrollerRef, emptyText: ''})),
			),
		);
	};

	it('shows the posts already in the store when the scroller sets its handle after the list mounts', () => {
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost(3), wirePost(2), wirePost(1)], false);
		renderInScroller(HOME_TIMELINE, document.createElement('div'));
		expect(container.querySelectorAll('[data-flx="feed.feed-timeline-list.row"]')).toHaveLength(3);
	});

	it('restores the scroll position when the scroller sets its handle after the list mounts', () => {
		const key = userTimelineKey('7');
		FeedTimeline.open(key);
		FeedTimeline.handleFetchSuccess(
			key,
			Array.from({length: 20}, (_, index) => wirePost(100 - index)),
			false,
		);
		const first = document.createElement('div');
		renderInScroller(key, first);
		act(() => {
			first.scrollTop = 900;
			first.dispatchEvent(new Event('scroll'));
		});
		act(() => root.unmount());

		root = createRoot(container);
		const again = document.createElement('div');
		renderInScroller(key, again);
		expect(again.scrollTop).toBe(900);
	});

	it('restores the scroll position of a timeline it is mounted again for', () => {
		const key = userTimelineKey('7');
		FeedTimeline.open(key);
		FeedTimeline.handleFetchSuccess(
			key,
			Array.from({length: 20}, (_, index) => wirePost(100 - index)),
			false,
		);
		const first = document.createElement('div');
		renderList(key, first);
		act(() => {
			first.scrollTop = 900;
			first.dispatchEvent(new Event('scroll'));
		});
		act(() => root.unmount());

		root = createRoot(container);
		const again = document.createElement('div');
		renderList(key, again);
		expect(again.scrollTop).toBe(900);
		act(() => root.unmount());

		// Once the timeline was closed and loads again from the top, the old place means nothing.
		FeedTimeline.close(key);
		FeedTimeline.open(key);
		root = createRoot(container);
		const fresh = document.createElement('div');
		renderList(key, fresh);
		expect(fresh.scrollTop).toBe(0);
	});

	// Micup: on the profile page the list sits under the profile header in the same scroller, so its
	// rows start scrollMargin pixels below the scroller's top.
	it('draws the rows a list under other content shows, from its scroll margin', () => {
		const key = userTimelineKey('7');
		FeedTimeline.open(key);
		FeedTimeline.handleFetchSuccess(
			key,
			Array.from({length: 20}, (_, index) => wirePost(100 - index)),
			false,
		);
		// Every post measures 180 px (happy-dom has no layout); the scroller keeps its own 600 px.
		const rowHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(180);
		const viewport = document.createElement('div');
		act(() =>
			root.render(
				createElement(FeedTimelineList, {
					timelineKey: key,
					scrollerRef: scrollerFor(viewport),
					emptyText: '',
					scrollMargin: 400,
				}),
			),
		);
		const rows = () => [...container.querySelectorAll<HTMLElement>('[data-flx="feed.feed-timeline-list.row"]')];
		expect(rows()[0]!.style.transform).toBe('translateY(0px)');
		expect(container.querySelector<HTMLElement>('[role="feed"]')!.style.height).toBe('3600px');
		// 2200 px down the scroller is 1800 px into the list: posts 10 to 13 show, 6 to 17 with the overscan.
		act(() => {
			viewport.scrollTop = 2200;
			viewport.dispatchEvent(new Event('scroll'));
		});
		const shown = rows().map((row) => Number(row.dataset.index));
		expect(Math.min(...shown)).toBe(6);
		expect(Math.max(...shown)).toBe(17);
		rowHeight.mockRestore();
	});

	// FeedMain loads a list again once its posts are 6 hours old (their video URLs run out), so it starts at the top.
	it('starts a stale timeline at the top instead of its old place', () => {
		const key = userTimelineKey('7');
		FeedTimeline.open(key);
		FeedTimeline.handleFetchSuccess(
			key,
			Array.from({length: 20}, (_, index) => wirePost(100 - index)),
			true,
		);
		const first = document.createElement('div');
		renderList(key, first);
		act(() => {
			first.scrollTop = 900;
			first.dispatchEvent(new Event('scroll'));
		});
		act(() => root.unmount());

		const later = Date.now() + 6 * 3_600_000 + 1;
		vi.spyOn(Date, 'now').mockReturnValue(later);
		root = createRoot(container);
		const again = document.createElement('div');
		renderList(key, again);
		expect(again.scrollTop).toBe(0);
		vi.restoreAllMocks();
	});
});

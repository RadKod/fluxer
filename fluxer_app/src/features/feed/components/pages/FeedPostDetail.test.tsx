// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {HttpError} from '@app/features/platform/types/EndpointError';
import type {FeedPostResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {act, cloneElement, createElement, forwardRef, type ReactElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/app/Routes', () => ({Routes: {FEED: '/feed'}}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'micup.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => 1000}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/platform/utils/MobXPersistence', () => ({makePersistent: async () => {}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({
	http: {get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn()},
}));
vi.mock('@app/features/feed/commands/FeedCommands', () => ({loadComments: vi.fn()}));
// Draws the two slots where the card does: beforeActions above its action row, actionsEnd at the row's end.
vi.mock('@app/features/feed/components/FeedPostCard', () => ({
	FeedPostCard: ({
		post,
		variant,
		beforeActions,
		actionsEnd,
	}: {
		post: {content: string};
		variant?: string;
		beforeActions?: ReactNode;
		actionsEnd?: ReactNode;
	}) =>
		createElement(
			'article',
			{'data-testid': 'card', 'data-variant': variant},
			createElement('p', {'data-testid': 'card-text'}, post.content),
			beforeActions,
			createElement('footer', {'data-testid': 'card-actions'}, actionsEnd),
		),
}));
vi.mock('@app/features/feed/components/FeedComments', () => ({
	FeedComments: ({post, layout}: {post: {id: string}; layout?: string}) =>
		createElement('section', {'data-testid': 'comments', 'data-layout': layout, 'data-post-id': post.id}),
}));
vi.mock('@app/features/feed/components/FeedLikers', () => ({
	FeedLikers: ({postId}: {postId: string}) => createElement('div', {'data-testid': 'likers', 'data-post-id': postId}),
}));
vi.mock('@app/features/feed/components/FeedProfileAside', () => ({FeedProfileAside: () => null}));
vi.mock('@app/features/platform/components/router/NavigationAdapter', () => ({goBackOr: vi.fn()}));
vi.mock('@app/features/theme/layout/RemFromPx', () => ({remFromPx: (px: number) => px}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({push: vi.fn(), modal: (render: unknown) => render}));
vi.mock('@app/features/ui/components/Scroller', () => ({
	Scroller: forwardRef<HTMLDivElement, {children: ReactNode}>(({children}, ref) =>
		createElement('div', {ref, 'data-testid': 'scroller'}, children),
	),
}));
vi.mock('@app/features/ui/components/Spinner', () => ({Spinner: () => createElement('span', {role: 'status'})}));
// The FocusRing mock marks the element it wraps, so a test can see which controls get Fluxer's focus ring.
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({
	default: ({children}: {children: ReactElement<Record<string, unknown>>}) =>
		cloneElement(children, {'data-focus-ring': ''}),
}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {enabled: false}}));
vi.mock('@app/features/user/utils/DateFormatting', () => ({
	getFormattedTime: () => '21:14',
	getFormattedShortDate: () => '27 Eyl 2026',
}));

const {http} = await import('@app/features/platform/transport/RestTransport');
const FeedCommands = await import('@app/features/feed/commands/FeedCommands');
const ModalCommands = await import('@app/features/ui/commands/ModalCommands');
const {goBackOr} = await import('@app/features/platform/components/router/NavigationAdapter');
const {default: FeedTimeline} = await import('@app/features/feed/state/FeedTimeline');
const {FeedPostDetail} = await import('@app/features/feed/components/pages/FeedPostDetail');
const {default: MobileLayout} = await import('@app/features/ui/state/MobileLayout');

const wirePost = (overrides: Partial<FeedPostResponse> = {}): FeedPostResponse => ({
	id: '100',
	author: {
		id: '7',
		username: 'user7',
		discriminator: '0001',
		global_name: null,
		avatar: null,
		avatar_color: null,
		flags: 0,
	},
	content: 'post',
	attachments: [],
	edited_at: null,
	like_count: 3,
	comment_count: 2,
	liked: false,
	public: true,
	...overrides,
});

describe('FeedPostDetail', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const find = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);
	const button = (label: string) =>
		Array.from(container.querySelectorAll('button')).find(
			(element) => element.textContent === label || element.getAttribute('aria-label') === label,
		);
	const open = async (postId: string) => {
		await act(async () => {
			root.render(createElement(FeedPostDetail, {postId}));
		});
	};

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		(MobileLayout as {enabled: boolean}).enabled = false;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it('opens /feed/posts/:id directly with the post, likers and comments', async () => {
		vi.mocked(http.get).mockResolvedValue({body: wirePost()} as never);
		await open('100');
		expect(http.get).toHaveBeenCalledWith('/feed/posts/100');
		expect(container.querySelector('h1')?.textContent).toBe('Post');
		expect(find('card')?.getAttribute('data-variant')).toBe('page');
		expect(find('card-text')?.textContent).toBe('post');
		expect(container.querySelector('time')?.textContent).toBe('21:14 · 27 Eyl 2026');
		expect(container.textContent).toContain('Public post');
		expect(find('comments')?.getAttribute('data-layout')).toBe('page');
		expect(FeedCommands.loadComments).toHaveBeenCalledWith('100');

		act(() => button('See who liked')!.click());
		const render = vi.mocked(ModalCommands.push).mock.calls[0]![0] as unknown as () => ReactElement;
		act(() => root.render(render()));
		expect(find('likers')?.getAttribute('data-post-id')).toBe('100');
	});

	it('goes back, or to the feed when the page was opened on its own', async () => {
		vi.mocked(http.get).mockResolvedValue({body: wirePost()} as never);
		await open('100');
		act(() => button('Go back')!.click());
		expect(goBackOr).toHaveBeenCalledWith('/feed');
	});

	it('on the desktop layout draws the time line inside the card above the actions and See who liked at the end of the actions', async () => {
		vi.mocked(http.get).mockResolvedValue({body: wirePost()} as never);
		await open('100');
		const stamp = find('card')!.querySelector('[data-flx="feed.feed-post-detail.card-stamp"]');
		expect(stamp?.querySelector('time')?.textContent).toBe('21:14 · 27 Eyl 2026');
		expect(stamp?.textContent).toContain('Public post');
		expect(stamp?.nextElementSibling).toBe(find('card-actions'));
		expect(find('card-actions')!.contains(button('See who liked')!)).toBe(true);
		expect(container.querySelector('[data-flx="feed.feed-post-detail.meta"]')).toBeNull();
	});

	it('on the phone layout keeps the time line and See who liked under the card', async () => {
		(MobileLayout as {enabled: boolean}).enabled = true;
		vi.mocked(http.get).mockResolvedValue({body: wirePost()} as never);
		await open('100');
		expect(find('card')!.querySelector('time')).toBeNull();
		expect(find('card-actions')!.children).toHaveLength(0);
		const meta = container.querySelector('[data-flx="feed.feed-post-detail.meta"]');
		expect(find('card')!.nextElementSibling).toBe(meta);
		expect(meta?.querySelector('time')?.textContent).toBe('21:14 · 27 Eyl 2026');
		expect(meta?.textContent).toContain('Public post');
		expect(meta!.contains(button('See who liked')!)).toBe(true);
	});

	it("gives See who liked Fluxer's focus ring in the card and under it", async () => {
		for (const phone of [false, true]) {
			(MobileLayout as {enabled: boolean}).enabled = phone;
			vi.mocked(http.get).mockResolvedValue({body: wirePost()} as never);
			await open('100');
			expect(button('See who liked')!.hasAttribute('data-focus-ring')).toBe(true);
			act(() => root.unmount());
			root = createRoot(container);
		}
	});

	it('has no likers button while nobody likes the post', async () => {
		for (const phone of [false, true]) {
			(MobileLayout as {enabled: boolean}).enabled = phone;
			vi.mocked(http.get).mockResolvedValue({body: wirePost({like_count: 0, public: false})} as never);
			await open('100');
			expect(find('card')).not.toBeNull();
			expect(container.querySelector('time')).not.toBeNull();
			expect(button('See who liked')).toBeUndefined();
			expect(container.textContent).not.toContain('Public post');
			act(() => root.unmount());
			root = createRoot(container);
		}
	});

	it('shows the unavailable text for 404 and 403', async () => {
		for (const status of [404, 403]) {
			vi.mocked(http.get).mockRejectedValue(new HttpError({method: 'GET', path: '/feed/posts/100', status}));
			await open(String(status));
			expect(container.textContent).toContain("This post can't be shown.");
			expect(find('card')).toBeNull();
			expect(find('comments')).toBeNull();
		}
	});

	it('shows the unavailable text for an address that is not a post id, without asking the server', async () => {
		await open('..%2F..%2Fusers%2F@me');
		expect(container.textContent).toContain("This post can't be shown.");
		expect(http.get).not.toHaveBeenCalled();
		expect(container.querySelector('[role="status"]')).toBeNull();
	});

	// The page opens the comments; the same post's card in the feed gets its panel back as it was.
	it('leaves the comments of the post in the feed as they were', async () => {
		FeedTimeline.open('home');
		FeedTimeline.handleFetchSuccess('home', [wirePost()], true);
		vi.mocked(http.get).mockResolvedValue({body: wirePost()} as never);
		await open('100');
		expect(FeedTimeline.getThread('100')).not.toBeNull();
		act(() => root.unmount());
		root = createRoot(container);
		expect(FeedTimeline.getThread('100')).toBeNull();

		FeedTimeline.openThread('100');
		await open('100');
		act(() => root.unmount());
		root = createRoot(container);
		expect(FeedTimeline.getThread('100')).not.toBeNull();
		FeedTimeline.closeThread('100');
		FeedTimeline.close('home');
	});

	it('closes the post timeline when the page goes', async () => {
		vi.mocked(http.get).mockResolvedValue({body: wirePost()} as never);
		await open('100');
		expect(FeedTimeline.getTimeline('post:100')?.posts).toHaveLength(1);
		act(() => root.unmount());
		root = createRoot(container);
		expect(FeedTimeline.getTimeline('post:100')).toBeNull();
	});
});

// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {HttpError} from '@app/features/platform/types/EndpointError';
import type {RestResponse} from '@app/features/platform/types/TransportTypes';
import {PublicUserFlags} from '@fluxer/constants/src/UserConstants';
import type {FeedPostResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {observer} from 'mobx-react-lite';
import {act, cloneElement, createElement, type ReactElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Fills {name} and the branches of a "{count, plural, one {…} other {…}}" message (# is the count), enough to read the
// rendered text; a message without values stays as it is.
function format(message: string, values?: Record<string, unknown>): string {
	if (!values) return message;
	return message
		.replace(/^\{count, plural, one \{(.*?)\} other \{(.*)\}\}$/, (_, one: string, other: string) =>
			(values.count === 1 ? one : other).replace('#', String(values.count)),
		)
		.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]));
}

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({
		i18n: {
			_: (descriptor: {message: string}, values?: Record<string, unknown>) => format(descriptor.message, values),
			number: (value: number, options?: Intl.NumberFormatOptions) =>
				new Intl.NumberFormat('en-US', options).format(value),
		},
	}),
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'micup.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => 1000}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: '1', userId: '1'}}));
vi.mock('@app/features/platform/state/AuthSession', () => ({
	default: {currentAccountKey: 'micup-test-account', userId: '1'},
}));
vi.mock('@app/features/app/components/dialogs/ConfirmModal', () => ({ConfirmModal: () => null}));
vi.mock('@app/features/channel/components/embeds/attachments/AttachmentMosaic', () => ({
	AttachmentMosaic: vi.fn(() => null),
}));
vi.mock('@app/features/channel/components/TimestampWithTooltip', () => ({
	TimestampWithTooltip: ({children}: {children: ReactNode}) => createElement('time', null, children),
}));
vi.mock('@app/features/feed/commands/FeedCommands', () => ({setLiked: vi.fn(async () => 'ok'), loadComments: vi.fn()}));
// The card's own measure (isHalfVisible) is real; the view it records and the observer are watched.
vi.mock('@app/features/feed/commands/FeedViewCommands', async (importOriginal) => ({
	...(await importOriginal<typeof import('@app/features/feed/commands/FeedViewCommands')>()),
	recordView: vi.fn(),
}));
vi.mock('@app/features/platform/utils/SharedIntersectionObserver', () => ({observeIntersection: vi.fn()}));
vi.mock('@app/features/feed/components/FeedComments', () => ({
	FeedComments: vi.fn(() => null),
	feedCommentBoxId: (postId: string) => `comment-box-${postId}`,
}));
vi.mock('@app/features/feed/components/FeedItemMenu', () => ({FeedItemMenu: () => null, toastFeedFailure: vi.fn()}));
vi.mock('@app/features/feed/components/FeedLinkPreview', () => ({
	FeedLinkPreview: vi.fn(() => createElement('div', {'data-testid': 'link-preview'})),
}));
vi.mock('@app/features/feed/components/FeedPollView', () => ({
	FeedPollView: vi.fn(() => createElement('div', {'data-testid': 'poll'})),
}));
vi.mock('@app/features/feed/components/FeedPostContent', () => ({
	FeedPostContent: ({content}: {content: string}) =>
		createElement('p', null, content, ' ', createElement('a', {href: '#mention'}, 'a mention')),
}));
vi.mock('@app/features/feed/components/FeedVideo', () => ({
	FeedVideo: vi.fn(() => createElement('div', {'data-testid': 'feed-video'})),
}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => ({transitionTo: vi.fn()}));
vi.mock('@app/features/feed/components/FeedReportModal', () => ({FeedReportModal: () => null}));
vi.mock('@app/features/i18n/utils/CommonMessageDescriptors', () => ({
	CANCEL_DESCRIPTOR: {message: 'Cancel'},
	TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR: {message: 'Try again in a moment.'},
}));
// The follow pill runs the real FollowCommands and store path; only the request and the toast are watched.
vi.mock('@app/features/platform/transport/RestTransport', () => ({
	http: {get: vi.fn(), put: vi.fn(), delete: vi.fn()},
}));
vi.mock('@app/features/analytics/commands/AnalyticsCommands', () => ({track: vi.fn()}));
vi.mock('@app/features/follow/components/FollowListModal', () => ({FollowListModal: () => null}));
vi.mock('@app/features/follow/components/ProfileFollowActions', async (importOriginal) => ({
	...(await importOriginal<typeof import('@app/features/follow/components/ProfileFollowActions')>()),
	toastFollowFailure: vi.fn(),
}));
vi.mock('@app/features/premium/commands/PremiumModalCommands', () => ({open: vi.fn()}));
vi.mock('@app/features/premium/utils/PremiumUtils', () => ({shouldShowPremiumFeatures: () => true}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({error: vi.fn()}));
vi.mock('@app/features/ui/action_menu/ContextMenuIcons', () => ({MoreIcon: () => null}));
vi.mock('@app/features/ui/commands/ContextMenuCommands', () => ({openFromElementBottomRight: vi.fn()}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({push: vi.fn(), modal: (render: unknown) => render}));
vi.mock('@app/features/ui/components/Avatar', () => ({Avatar: () => null}));
vi.mock('@app/features/ui/components/icons/VerifiedBadgeIcon', () => ({VerifiedBadgeIcon: () => null}));
// The FocusRing mock marks the element it wraps, so a test can see which controls get Fluxer's focus ring.
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({
	default: ({children}: {children: ReactElement<Record<string, unknown>>}) =>
		cloneElement(children, {'data-focus-ring': ''}),
}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: vi.fn(({children}: {children: ReactNode}) => children)}));
vi.mock('@app/features/user/commands/UserProfileCommands', () => ({
	openProfilePage: vi.fn(),
	openUserProfile: vi.fn(),
}));
vi.mock('@app/features/user/utils/DateFormatting', () => ({getRelativeDateString: () => '12 dk'}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({
	getNickname: (user: {username: string}) => user.username,
	formatTagForStreamerMode: vi.fn((tag: string) => tag),
}));

const {AttachmentMosaic} = await import('@app/features/channel/components/embeds/attachments/AttachmentMosaic');
const FeedCommands = await import('@app/features/feed/commands/FeedCommands');
const FeedViewCommands = await import('@app/features/feed/commands/FeedViewCommands');
const {observeIntersection} = await import('@app/features/platform/utils/SharedIntersectionObserver');
const {Tooltip} = await import('@app/features/ui/tooltip/Tooltip');
const {FeedLinkPreview} = await import('@app/features/feed/components/FeedLinkPreview');
const {FeedPollView} = await import('@app/features/feed/components/FeedPollView');
const {FeedComments} = await import('@app/features/feed/components/FeedComments');
const {FeedVideo} = await import('@app/features/feed/components/FeedVideo');
const RouterUtils = await import('@app/features/navigation/utils/RouterUtils');
const UserProfileCommands = await import('@app/features/user/commands/UserProfileCommands');
const ContextMenuCommands = await import('@app/features/ui/commands/ContextMenuCommands');
const NicknameUtils = await import('@app/features/user/utils/NicknameUtils');
const {default: FeedTimeline, DISCOVER_TIMELINE, HOME_TIMELINE} = await import('@app/features/feed/state/FeedTimeline');
const {FeedPostCard} = await import('@app/features/feed/components/FeedPostCard');
const {http} = await import('@app/features/platform/transport/RestTransport');
const {toastFollowFailure} = await import('@app/features/follow/components/ProfileFollowActions');
const {default: styles} = await import('@app/features/feed/components/FeedPostCard.module.css');
const {default: Users} = await import('@app/features/user/state/Users');

// The signed-in viewer (id 1, years old): a verified email on a claimed account, so the server lets it follow a stranger
// through a post.
function signIn(fields: {verified?: boolean; email?: string | null} = {}): void {
	Users.handleGatewayReady('micup-test-account', {
		...wirePost('0', '1').author,
		verified: true,
		email: 'me@micup.test',
		...fields,
	} as Parameters<typeof Users.handleGatewayReady>[1]);
}

function wirePost(id: string, authorId: string, flags = 0, extra: Partial<FeedPostResponse> = {}): FeedPostResponse {
	return {
		id,
		author: {
			id: authorId,
			username: `user${authorId}`,
			discriminator: '0001',
			global_name: null,
			avatar: null,
			avatar_color: null,
			flags,
		},
		content: `post ${id}`,
		attachments: [],
		edited_at: null,
		like_count: 24,
		comment_count: 8,
		liked: true,
		...extra,
	};
}

const VIDEO = {
	id: '500',
	filename: 'clip.mp4',
	size: 1024,
	url: 'https://media.micup.test/feed/500/clip.mp4',
	proxy_url: 'https://media.micup.test/feed/500/clip.mp4',
	content_type: 'video/mp4',
	width: 640,
	height: 360,
	duration: 12,
	flags: 0,
} as unknown as FeedPostResponse['attachments'][number];

const STREAM_VIDEO = {
	id: '4f5c2b8e-8a8e-4b53-9a3a-6f1d8b2c7e10',
	width: 1080,
	height: 1920,
	duration: 42,
	poster_url: 'https://vz.micup.test/4f5c/thumbnail.jpg?token=a',
	hls_url: 'https://vz.micup.test/4f5c/playlist.m3u8?token=a',
	mp4_url: null,
	expires_at: '2026-09-28T12:00:00.000Z',
};

describe('FeedPostCard', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		vi.mocked(NicknameUtils.formatTagForStreamerMode).mockImplementation((tag: string) => tag);
		signIn();
		FeedTimeline.reset();
		FeedTimeline.open(HOME_TIMELINE);
		FeedTimeline.handleFetchSuccess(
			HOME_TIMELINE,
			[wirePost('100', '7', PublicUserFlags.VERIFIED), wirePost('101', '1'), wirePost('102', '9')],
			false,
		);
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const renderPost = (
		id: string,
		props: {
			variant?: 'timeline' | 'page';
			onOpenPost?: () => void;
			beforeActions?: ReactNode;
			actionsEnd?: ReactNode;
		} = {},
	) => act(() => root.render(createElement(FeedPostCard, {post: FeedTimeline.getPost(id)!, ...props})));
	const byFlx = (flx: string) => container.querySelector<HTMLElement>(`[data-flx="${flx}"]`);

	// Micup: the feed opens the full profile page, not the modal.
	it('opens the author profile page from the name and the avatar, not the profile modal', () => {
		renderPost('100');
		act(() => byFlx('feed.feed-post-card.author-button.open-profile')!.click());
		act(() => byFlx('feed.feed-post-card.avatar-button.open-profile')!.click());
		expect(vi.mocked(UserProfileCommands.openProfilePage).mock.calls).toEqual([['7'], ['7']]);
		expect(UserProfileCommands.openUserProfile).not.toHaveBeenCalled();
	});

	it('puts the like button before the comment button and keeps their states and handler', () => {
		renderPost('100');
		const like = byFlx('feed.feed-post-card.action-button.toggle-like')!;
		const comments = byFlx('feed.feed-post-card.action-button.toggle-comments')!;
		expect(like.compareDocumentPosition(comments) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(like.getAttribute('aria-pressed')).toBe('true');
		expect(comments.getAttribute('aria-expanded')).toBe('false');
		act(() => like.click());
		expect(FeedCommands.setLiked).toHaveBeenCalledWith('100', false);
	});

	it('gives the like button its own class and aria-pressed when liked', () => {
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost('109', '9', 0, {liked: false})], false);
		renderPost('100');
		const like = byFlx('feed.feed-post-card.action-button.toggle-like')!;
		const comments = byFlx('feed.feed-post-card.action-button.toggle-comments')!;
		expect(like.classList).toContain(styles.likeButton);
		expect(like.classList).toContain(styles.actionButtonActive);
		expect(like.getAttribute('aria-pressed')).toBe('true');
		expect(comments.classList).not.toContain(styles.likeButton);
		renderPost('109');
		const notLiked = byFlx('feed.feed-post-card.action-button.toggle-like')!;
		expect(notLiked.classList).toContain(styles.likeButton);
		expect(notLiked.classList).not.toContain(styles.actionButtonActive);
		expect(notLiked.getAttribute('aria-pressed')).toBe('false');
	});

	it('renders beforeActions above the action row and actionsEnd at its end', () => {
		renderPost('100', {
			beforeActions: createElement('div', {'data-testid': 'before'}),
			actionsEnd: createElement('button', {type: 'button', 'data-testid': 'end'}),
		});
		const actions = byFlx('feed.feed-post-card.actions')!;
		expect(container.querySelector('[data-testid="before"]')!.nextElementSibling).toBe(actions);
		const end = byFlx('feed.feed-post-card.actions-end')!;
		expect(actions.lastElementChild).toBe(end);
		expect(end.classList).toContain(styles.actionsEnd);
		expect(end.querySelector('[data-testid="end"]')).not.toBeNull();
		// Without them the card adds nothing.
		renderPost('100');
		expect(container.querySelector('[data-testid="before"]')).toBeNull();
		expect(byFlx('feed.feed-post-card.actions-end')).toBeNull();
		expect(byFlx('feed.feed-post-card.actions')!.previousElementSibling?.getAttribute('data-flx')).toBe(
			'feed.feed-post-card.content',
		);
	});

	it('marks the page variant', () => {
		renderPost('100', {variant: 'page'});
		expect(byFlx('feed.feed-post-card.post')!.classList).toContain(styles.pageVariant);
		renderPost('100');
		expect(byFlx('feed.feed-post-card.post')!.classList).not.toContain(styles.pageVariant);
	});

	it('shows the verified tick and the legacy name#discriminator tag while the author has not selected', () => {
		renderPost('100');
		expect(container.querySelector('[aria-label="Verified account"]')).not.toBeNull();
		expect(byFlx('feed.feed-post-card.tag')?.textContent).toBe('user7#0001');
		expect(NicknameUtils.formatTagForStreamerMode).toHaveBeenCalledWith('user7#0001');
		expect(container.textContent).not.toContain('@user7');
		expect(container.textContent).toContain('12 dk');
	});

	it('shows selected human authors as @username while bots remain tagged', () => {
		const selected = wirePost('110', '11', PublicUserFlags.VERIFIED);
		selected.author = {...selected.author, discriminator: '0000'};
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [selected], false);
		renderPost('110');
		expect(byFlx('feed.feed-post-card.tag')?.textContent).toBe('@user11');
		const bot = wirePost('111', '12');
		bot.author = {...bot.author, bot: true};
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [bot], false);
		renderPost('111');
		expect(byFlx('feed.feed-post-card.tag')?.textContent).toBe('user12#0001');
	});

	it('shows no tick for an account that is not verified', () => {
		renderPost('102');
		expect(container.querySelector('[aria-label="Verified account"]')).toBeNull();
	});

	it('shows the premium crown next to the author name only when the author has the bit', () => {
		FeedTimeline.handleFetchSuccess(
			HOME_TIMELINE,
			[wirePost('110', '11', PublicUserFlags.VERIFIED | PublicUserFlags.PREMIUM_BADGE)],
			false,
		);
		renderPost('110');
		const crown = byFlx('feed.feed-post-card.premium-user-badge');
		expect(crown?.getAttribute('aria-label')).toBe('sanalyer Plus');
		expect(crown!.previousElementSibling?.getAttribute('aria-label')).toBe('Verified account');
		expect(crown!.nextElementSibling).toBe(byFlx('feed.feed-post-card.tag'));
		renderPost('100');
		expect(byFlx('feed.feed-post-card.premium-user-badge')).toBeNull();
	});

	it('shows the streamer-mode tag instead of the full name#discriminator', () => {
		vi.mocked(NicknameUtils.formatTagForStreamerMode).mockReturnValue('u…');
		renderPost('100');
		expect(byFlx('feed.feed-post-card.tag')?.textContent).toBe('u…');
		expect(container.textContent).not.toContain('user7#0001');
	});

	it('offers delete on your own post and report on everyone else', () => {
		const menuFor = (id: string) => {
			renderPost(id);
			act(() => byFlx('feed.feed-post-card.more-button.open-menu')!.click());
			const render = vi
				.mocked(ContextMenuCommands.openFromElementBottomRight)
				.mock.calls.at(-1)![1] as unknown as (props: {
				onClose: () => void;
			}) => ReactElement<{onDelete: unknown; onReport: unknown}>;
			return render({onClose: () => {}}).props;
		};
		const own = menuFor('101');
		expect(own.onDelete).toBeTypeOf('function');
		expect(own.onReport).toBeNull();
		const other = menuFor('102');
		expect(other.onDelete).toBeNull();
		expect(other.onReport).toBeTypeOf('function');
	});

	it('shows the poll, the preview and a globe on public posts', () => {
		const poll = {options: ['Tea', 'Coffee'], expires_at: '2999-01-01T00:00:00.000Z', votes: null, voted: null};
		const linkPreview = {
			kind: 'twitch' as const,
			url: 'https://www.twitch.tv/somechannel',
			invite_code: null,
			embed: null,
		};
		FeedTimeline.handleFetchSuccess(
			HOME_TIMELINE,
			[
				wirePost('103', '9', 0, {public: true, poll}),
				wirePost('104', '9', 0, {public: true, link_preview: linkPreview}),
			],
			false,
		);
		renderPost('103');
		expect(container.querySelector('[data-testid="poll"]')).not.toBeNull();
		expect(vi.mocked(FeedPollView).mock.lastCall![0]).toMatchObject({post: FeedTimeline.getPost('103')});
		expect(container.querySelector('[data-testid="link-preview"]')).toBeNull();
		expect(container.querySelector('[role="img"][aria-label="Public post"]')).not.toBeNull();
		renderPost('104');
		expect(container.querySelector('[data-testid="link-preview"]')).not.toBeNull();
		expect(vi.mocked(FeedLinkPreview).mock.lastCall![0]).toMatchObject({preview: linkPreview});
		expect(container.querySelector('[data-testid="poll"]')).toBeNull();
		// A post that is not public has no globe, and one without a poll or link shows neither.
		renderPost('102');
		expect(container.querySelector('[aria-label="Public post"]')).toBeNull();
		expect(container.querySelector('[data-testid="poll"]')).toBeNull();
		expect(container.querySelector('[data-testid="link-preview"]')).toBeNull();
	});

	it('passes a video attachment to AttachmentMosaic', () => {
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost('105', '9', 0, {attachments: [VIDEO]})], false);
		renderPost('105');
		const props = vi.mocked(AttachmentMosaic).mock.lastCall![0];
		expect(props.attachments).toHaveLength(1);
		expect(props.attachments[0]).toMatchObject({content_type: 'video/mp4', duration: 12});
	});

	it("shows no follow pill on a stranger's Discover post without author_following (an older server)", () => {
		FeedTimeline.open(DISCOVER_TIMELINE);
		FeedTimeline.handleFetchSuccess(DISCOVER_TIMELINE, [wirePost('106', '42', 0, {public: true})], false, '1.20');
		renderPost('106');
		const labels = [...container.querySelectorAll('button')].map(
			(button) => `${button.textContent} ${button.getAttribute('aria-label') ?? ''}`,
		);
		expect(labels.length).toBeGreaterThan(0);
		expect(labels.filter((label) => /follow/i.test(label))).toEqual([]);
	});

	it('shows a post video with FeedVideo, not the attachment mosaic', () => {
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost('107', '9', 0, {video: STREAM_VIDEO})], false);
		renderPost('107');
		expect(vi.mocked(FeedVideo).mock.lastCall![0]).toMatchObject({postId: '107', video: STREAM_VIDEO});
		expect(AttachmentMosaic).not.toHaveBeenCalled();
	});

	it('opens the post page when its body is clicked', () => {
		renderPost('100');
		act(() => byFlx('feed.feed-post-card.post')!.click());
		expect(RouterUtils.transitionTo).toHaveBeenCalledWith('/feed/posts/100');
		act(() => container.querySelector('p')!.click());
		expect(RouterUtils.transitionTo).toHaveBeenCalledTimes(2);
	});

	it('does not open it from links, buttons, media, the poll or selected text', () => {
		const poll = {options: ['Tea', 'Coffee'], expires_at: '2999-01-01T00:00:00.000Z', votes: null, voted: null};
		const linkPreview = {
			kind: 'twitch' as const,
			url: 'https://www.twitch.tv/somechannel',
			invite_code: null,
			embed: null,
		};
		FeedTimeline.handleFetchSuccess(
			HOME_TIMELINE,
			[wirePost('108', '9', 0, {video: STREAM_VIDEO, poll, link_preview: linkPreview})],
			false,
		);
		renderPost('108');
		const clickOn = (element: Element) =>
			act(() => {
				element.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
			});
		clickOn(container.querySelector('a[href="#mention"]')!);
		clickOn(byFlx('feed.feed-post-card.action-button.toggle-like')!);
		clickOn(byFlx('feed.feed-post-card.author-button.open-profile')!);
		clickOn(container.querySelector('[data-testid="feed-video"]')!);
		clickOn(container.querySelector('[data-testid="poll"]')!);
		clickOn(container.querySelector('[data-testid="link-preview"]')!);
		const text = container.querySelector('p')!;
		document.getSelection()!.selectAllChildren(text);
		clickOn(text);
		document.getSelection()!.removeAllRanges();
		expect(RouterUtils.transitionTo).not.toHaveBeenCalled();
		clickOn(text);
		expect(RouterUtils.transitionTo).toHaveBeenCalledWith('/feed/posts/108');
	});

	it('links the timestamp to the post page', () => {
		renderPost('100');
		const link = container.querySelector<HTMLAnchorElement>('a[href="/feed/posts/100"]')!;
		expect(link.textContent).toContain('12 dk');
		// Records whether the card let the browser follow the link, then stops happy-dom from navigating.
		const clickLink = (init: MouseEventInit) => {
			let prevented = false;
			const observe = (event: Event) => {
				prevented = event.defaultPrevented;
				event.preventDefault();
			};
			document.addEventListener('click', observe, {once: true});
			act(() => {
				link.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, ...init}));
			});
			return prevented;
		};
		expect(clickLink({})).toBe(true);
		expect(RouterUtils.transitionTo).toHaveBeenCalledTimes(1);
		expect(RouterUtils.transitionTo).toHaveBeenCalledWith('/feed/posts/100');
		// A new tab or window stays with the browser.
		expect(clickLink({ctrlKey: true})).toBe(false);
		expect(clickLink({metaKey: true})).toBe(false);
		expect(RouterUtils.transitionTo).toHaveBeenCalledTimes(1);
	});

	it('closes the modal first when opened from a card inside a modal', () => {
		const onOpenPost = vi.fn();
		renderPost('100', {onOpenPost});
		act(() => container.querySelector('p')!.click());
		expect(onOpenPost).toHaveBeenCalledTimes(1);
		expect(onOpenPost.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(RouterUtils.transitionTo).mock.invocationCallOrder[0]!,
		);
		act(() => container.querySelector<HTMLAnchorElement>('a[href="/feed/posts/100"]')!.click());
		expect(onOpenPost).toHaveBeenCalledTimes(2);
	});

	it('on the post page the card does not open itself and leaves the comments to the page', () => {
		renderPost('100', {variant: 'page'});
		act(() => container.querySelector('p')!.click());
		expect(RouterUtils.transitionTo).not.toHaveBeenCalled();
		act(() => byFlx('feed.feed-post-card.action-button.toggle-comments')!.click());
		expect(FeedComments).not.toHaveBeenCalled();
	});

	// The page lists the comments under the card with their own box (FeedComments, layout 'page').
	it("on the post page the comment button puts focus in the page's comment box and keeps the comments open", () => {
		FeedTimeline.openThread('100');
		const box = document.createElement('textarea');
		box.id = 'comment-box-100';
		document.body.append(box);
		renderPost('100', {variant: 'page'});
		const comments = byFlx('feed.feed-post-card.action-button.toggle-comments')!;
		expect(comments.hasAttribute('aria-expanded')).toBe(false);
		act(() => comments.click());
		expect(document.activeElement).toBe(box);
		expect(FeedTimeline.getThread('100')).not.toBeNull();
		expect(FeedCommands.loadComments).not.toHaveBeenCalled();
		box.remove();
	});

	it('on the post page the timestamp link stays put instead of adding the same page to the history', () => {
		renderPost('100', {variant: 'page'});
		const link = container.querySelector<HTMLAnchorElement>('a[href="/feed/posts/100"]')!;
		const click = new MouseEvent('click', {bubbles: true, cancelable: true});
		act(() => {
			link.dispatchEvent(click);
		});
		expect(click.defaultPrevented).toBe(true);
		expect(RouterUtils.transitionTo).not.toHaveBeenCalled();
	});

	it("gives the name, the time link and the action buttons Fluxer's focus ring", () => {
		renderPost('100');
		for (const flx of [
			'feed.feed-post-card.author-button.open-profile',
			'feed.feed-post-card.timestamp-link.open-post',
			'feed.feed-post-card.action-button.toggle-like',
			'feed.feed-post-card.action-button.toggle-comments',
		]) {
			expect(byFlx(flx)?.hasAttribute('data-focus-ring'), flx).toBe(true);
		}
	});

	it('sends focus to the reply box when the comments open from the keyboard, not from a pointer', () => {
		renderPost('100');
		const comments = byFlx('feed.feed-post-card.action-button.toggle-comments')!;
		// A keyboard press on a button clicks with detail 0; a mouse or touch click counts from 1.
		const clickWith = (detail: number) =>
			act(() => comments.dispatchEvent(new MouseEvent('click', {bubbles: true, detail})));
		const lastAutoFocus = () => (vi.mocked(FeedComments).mock.lastCall![0] as {autoFocus?: boolean}).autoFocus;
		clickWith(0);
		expect(lastAutoFocus()).toBe(true);
		clickWith(1);
		clickWith(1);
		expect(comments.getAttribute('aria-expanded')).toBe('true');
		expect(lastAutoFocus()).toBe(false);
	});

	it('shows an eye icon with the view count shortened, the full count as its accessible name and tooltip, and nothing when the post has none', () => {
		FeedTimeline.handleFetchSuccess(
			HOME_TIMELINE,
			[wirePost('110', '9', 0, {view_count: 1234, view_token: 't-110'}), wirePost('111', '9', 0, {view_count: 1})],
			false,
		);
		renderPost('110', {actionsEnd: createElement('button', {type: 'button', 'data-testid': 'end'})});
		const count = byFlx('feed.feed-post-card.view-count')!;
		expect(count.classList).toContain(styles.viewCount);
		expect(count.getAttribute('role')).toBe('img');
		expect(count.getAttribute('aria-label')).toBe('1,234 views');
		expect(count.textContent).toBe('1.2K');
		const icon = count.querySelector('svg')!;
		expect(icon.getAttribute('aria-hidden')).toBe('true');
		expect(icon.classList).toContain(styles.actionIcon);
		expect(vi.mocked(Tooltip).mock.calls.map(([props]) => props.text)).toContain('1,234 views');
		// After the comment button, before the end slot (the post page's likers button).
		const comments = byFlx('feed.feed-post-card.action-button.toggle-comments')!;
		expect(comments.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(count.nextElementSibling).toBe(byFlx('feed.feed-post-card.actions-end'));
		renderPost('111');
		expect(byFlx('feed.feed-post-card.view-count')!.getAttribute('aria-label')).toBe('1 view');
		// View counts off: the post has none, and the row shows nothing for it.
		renderPost('102');
		expect(byFlx('feed.feed-post-card.view-count')).toBeNull();
	});

	it('records a view when half of the card is on screen and not before', () => {
		FeedTimeline.handleFetchSuccess(
			HOME_TIMELINE,
			[wirePost('112', '9', 0, {view_count: 5, view_token: 't-112'})],
			false,
		);
		const unobserve = vi.fn();
		vi.mocked(observeIntersection).mockReturnValue(unobserve);
		renderPost('112');
		expect(observeIntersection).toHaveBeenCalledTimes(1);
		const [element, onChange, options] = vi.mocked(observeIntersection).mock.calls[0]!;
		expect(element).toBe(byFlx('feed.feed-post-card.post'));
		expect(options).toEqual({threshold: FeedViewCommands.FEED_VIEW_THRESHOLDS});
		// `visible` px of the 300 px card on an 800 px screen.
		const entry = (visible: number) =>
			({
				isIntersecting: visible > 0,
				intersectionRatio: visible / 300,
				intersectionRect: {height: visible},
				rootBounds: {height: 800},
			}) as unknown as IntersectionObserverEntry;
		onChange(entry(90));
		onChange(entry(149));
		expect(FeedViewCommands.recordView).not.toHaveBeenCalled();
		onChange(entry(150));
		expect(FeedViewCommands.recordView).toHaveBeenCalledWith('112', 't-112');
		// Another post in the card (no view token): the watch ends and none starts.
		renderPost('102');
		expect(unobserve).toHaveBeenCalledTimes(1);
		expect(observeIntersection).toHaveBeenCalledTimes(1);
	});

	it('keeps watching a reloaded post without a new watch, and records with its newer token', () => {
		FeedTimeline.handleFetchSuccess(
			HOME_TIMELINE,
			[wirePost('114', '9', 0, {view_count: 1, view_token: 't-a'})],
			false,
		);
		vi.mocked(observeIntersection).mockReturnValue(vi.fn());
		renderPost('114');
		act(() => FeedTimeline.handlePostUpdated(wirePost('114', '9', 0, {view_count: 2, view_token: 't-b'})));
		renderPost('114');
		expect(observeIntersection).toHaveBeenCalledTimes(1);
		const [, onChange] = vi.mocked(observeIntersection).mock.calls[0]!;
		onChange({
			isIntersecting: true,
			intersectionRatio: 1,
			intersectionRect: {height: 300},
			rootBounds: {height: 800},
		} as unknown as IntersectionObserverEntry);
		expect(FeedViewCommands.recordView).toHaveBeenCalledWith('114', 't-b');
	});

	it('renders a card once when it mounts, with view counts off too', () => {
		renderPost('102');
		expect(vi.mocked(Tooltip).mock.calls.filter(([props]) => props.text === 'Post options')).toHaveLength(1);
	});

	it('does not watch the card when the post has no view token', () => {
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost('113', '9', 0, {view_count: 7})], false);
		renderPost('113');
		renderPost('102');
		expect(observeIntersection).not.toHaveBeenCalled();
		expect(FeedViewCommands.recordView).not.toHaveBeenCalled();
	});
	describe('the follow pill on Discover posts', () => {
		const PILL = 'feed.feed-post-card.follow-pill.toggle-follow';
		const pill = () => byFlx(PILL) as HTMLButtonElement | null;
		const answer = (): RestResponse<null> => ({ok: true, status: 204, statusText: '', headers: {}, body: null});
		// Like the list: an observer that passes the store's current copy of the post to the card.
		const LivePost = observer(({id}: {id: string}) => createElement(FeedPostCard, {post: FeedTimeline.getPost(id)!}));
		const renderLive = (id: string) => act(() => root.render(createElement(LivePost, {id})));

		beforeEach(() => {
			FeedTimeline.open(DISCOVER_TIMELINE);
			FeedTimeline.handleFetchSuccess(
				DISCOVER_TIMELINE,
				[
					wirePost('120', '42', 0, {public: true, author_following: false}),
					// The server leaves the field off your own posts; a false here shows the card checks you too.
					wirePost('121', '1', 0, {public: true, author_following: false}),
					wirePost('122', '43', 0, {public: true, author_following: true}),
				],
				true,
				'1.3',
			);
			vi.mocked(http.put).mockResolvedValue(answer());
			vi.mocked(http.delete).mockResolvedValue(answer());
		});

		it('shows a Follow pill before the menu on a post whose author the viewer does not follow, and none on own posts, followed authors or posts without author_following', () => {
			renderLive('120');
			expect(pill()!.textContent).toBe('Follow');
			expect(pill()!.classList).toContain(styles.followPill);
			expect(pill()!.classList).not.toContain(styles.followPillFollowing);
			expect(pill()!.nextElementSibling).toBe(byFlx('feed.feed-post-card.more-button.open-menu'));
			expect(pill()!.hasAttribute('data-focus-ring')).toBe(true);
			for (const id of ['121', '122', '102']) {
				renderLive(id);
				expect(pill(), id).toBeNull();
			}
		});

		it('a tap follows through the post with its id, turns into Following and a second tap unfollows', async () => {
			renderLive('120');
			await act(async () => pill()!.click());
			expect(http.put).toHaveBeenCalledWith(Endpoints.USER_FOLLOW('42'), {body: {post_id: '120'}});
			expect(FeedTimeline.getPost('120')!.authorFollowing).toBe(true);
			expect(pill()!.classList).toContain(styles.followPillFollowing);
			expect(pill()!.querySelector(`.${styles.followIdleLabel}`)!.textContent).toBe('Following');
			expect(vi.mocked(toastFollowFailure).mock.lastCall!.slice(1)).toEqual(['ok', false]);
			await act(async () => pill()!.click());
			expect(http.delete).toHaveBeenCalledWith(Endpoints.USER_FOLLOW('42'));
			expect(FeedTimeline.getPost('120')!.authorFollowing).toBe(false);
			expect(pill()!.textContent).toBe('Follow');
			expect(vi.mocked(toastFollowFailure).mock.lastCall!.slice(1)).toEqual(['ok', true]);
		});

		it('rolls the pill back and shows the toast on 403, 400 and other errors', async () => {
			renderLive('120');
			for (const [status, outcome] of [
				[403, 'forbidden'],
				[400, 'limit'],
				[500, 'failed'],
			] as const) {
				let refuse: (error: unknown) => void = () => {};
				vi.mocked(http.put).mockReturnValueOnce(new Promise((_, reject) => (refuse = reject)));
				act(() => pill()!.click());
				// At once, before the server answers; the pill waits for the answer.
				expect(pill()!.getAttribute('aria-label')).toBe('Following user42');
				expect(pill()!.disabled).toBe(true);
				await act(async () => refuse(new HttpError({method: 'PUT', path: '/users/42/follow', status})));
				expect(FeedTimeline.getPost('120')!.authorFollowing).toBe(false);
				expect(pill()!.getAttribute('aria-label')).toBe('Follow user42');
				expect(pill()!.disabled).toBe(false);
				expect(vi.mocked(toastFollowFailure).mock.lastCall!.slice(1)).toEqual([outcome, false]);
			}
		});

		it('offers no pill to a viewer the server would refuse: an unverified email or an unclaimed account', () => {
			// The pill is decided when the card mounts, so each viewer gets a fresh card.
			const mountFor = (fields: {verified?: boolean; email?: string | null}) => {
				act(() => root.unmount());
				root = createRoot(container);
				signIn(fields);
				renderLive('120');
			};
			for (const fields of [{verified: false}, {email: null}]) {
				mountFor(fields);
				expect(pill(), JSON.stringify(fields)).toBeNull();
			}
			mountFor({});
			expect(pill()).not.toBeNull();
		});

		it('a card mounted after the follow offers no pill', () => {
			renderLive('120');
			expect(pill()).not.toBeNull();
			// The list drops a card that scrolls away and mounts it again on the way back.
			act(() => root.unmount());
			root = createRoot(container);
			act(() => FeedTimeline.handleAuthorFollowing('42', true));
			renderLive('120');
			expect(pill()).toBeNull();
		});

		it("names the author in the pill's accessible name, which contains its visible text", () => {
			renderLive('120');
			expect(pill()!.getAttribute('aria-label')).toBe('Follow user42');
			expect(pill()!.getAttribute('aria-label')).toContain(pill()!.textContent);
			act(() => FeedTimeline.handleAuthorFollowing('42', true));
			const idle = pill()!.querySelector(`.${styles.followIdleLabel}`)!;
			const hover = pill()!.querySelector(`.${styles.followHoverLabel}`)!;
			expect(pill()!.getAttribute('aria-label')).toBe('Following user42');
			expect(pill()!.getAttribute('aria-label')).toContain(idle.textContent);
			// Unfollow shows on pointer hover only and is not read out.
			expect(hover.textContent).toBe('Unfollow');
			expect(hover.getAttribute('aria-hidden')).toBe('true');
		});

		it('a tap on the pill does not open the post', async () => {
			renderLive('120');
			await act(async () => pill()!.click());
			await act(async () => {
				pill()!
					.querySelector(`.${styles.followIdleLabel}`)!
					.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
			});
			expect(http.put).toHaveBeenCalledTimes(1);
			expect(http.delete).toHaveBeenCalledTimes(1);
			expect(RouterUtils.transitionTo).not.toHaveBeenCalled();
		});
	});
});

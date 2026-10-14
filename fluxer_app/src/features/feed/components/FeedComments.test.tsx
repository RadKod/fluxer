// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {PublicUserFlags} from '@fluxer/constants/src/UserConstants';
import type {FeedCommentResponse, FeedPostResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {act, cloneElement, createElement, forwardRef, type ReactElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const BLOCKED_USER_ID = '8';

// Fills a "{count, plural, one {# x} other {# y}}" message, enough to read the rendered text.
function format(message: string, values: Record<string, unknown> = {}): string {
	return message.replace(/\{count, plural, one \{# ([^}]+)\} other \{# ([^}]+)\}\}/, (_, one: string, other: string) =>
		values.count === 1 ? `1 ${one}` : `${values.count} ${other}`,
	);
}

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({
		i18n: {_: (descriptor: {message: string}, values?: Record<string, unknown>) => format(descriptor.message, values)},
	}),
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'micup.test'}}));
const limits = vi.hoisted((): Record<string, number> => ({}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({
	LimitResolver: {resolve: ({key}: {key: string}) => limits[key] ?? 1000},
}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/relationship/state/Relationships', () => ({
	default: {isBlocked: (userId: string) => userId === BLOCKED_USER_ID},
}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: '1'}}));
vi.mock('@app/features/feed/commands/FeedCommands', () => ({loadComments: vi.fn()}));
vi.mock('@app/features/feed/commands/FeedReplyCommands', () => ({
	openReplies: vi.fn(),
	deleteReply: vi.fn(async () => 'ok'),
	reportReply: vi.fn(),
}));
vi.mock('@app/features/platform/utils/SharedIntersectionObserver', () => ({
	observeIntersection: vi.fn(() => () => {}),
}));
vi.mock('@app/features/feed/components/FeedItemMenu', () => ({FeedItemMenu: () => null, toastFeedFailure: vi.fn()}));
vi.mock('@app/features/feed/components/FeedExpressionButtons', () => ({FeedExpressionButtons: () => null}));
vi.mock('@app/features/feed/components/FeedReportModal', () => ({FeedReportModal: () => null}));
vi.mock('@app/features/feed/components/FeedPostContent', () => ({
	FeedPostContent: ({content, inlineGifs}: {content: string; inlineGifs?: boolean}) =>
		createElement('p', {'data-inline-gifs': String(inlineGifs)}, content),
}));
vi.mock('@app/features/ui/action_menu/ContextMenuIcons', () => ({MoreIcon: () => null}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children}: {children: ReactNode}) => createElement('button', {type: 'button'}, children),
}));
vi.mock('@app/features/ui/commands/ContextMenuCommands', () => ({openFromElementBottomRight: vi.fn()}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({push: vi.fn(), modal: (render: unknown) => render}));
vi.mock('@app/features/ui/components/Avatar', () => ({
	Avatar: ({user, size}: {user: {id: string}; size: number}) =>
		createElement('span', {'data-avatar-user': user.id, 'data-avatar-size': size}),
}));
vi.mock('@app/features/user/state/Users', () => ({default: {currentUser: {id: '1'}}}));
vi.mock('@app/features/ui/components/form/FormInput', () => ({
	Textarea: forwardRef<
		HTMLTextAreaElement,
		{'aria-label': string; autoFocus?: boolean; value?: string; id?: string; innerActionButton?: ReactNode}
	>(({'aria-label': label, autoFocus, value, id, innerActionButton}, ref) =>
		createElement(
			'div',
			{'data-textarea-box': ''},
			createElement('textarea', {'aria-label': label, autoFocus, value, id, readOnly: true, ref}),
			innerActionButton,
		),
	),
}));
vi.mock('@app/features/ui/components/Spinner', () => ({Spinner: () => null}));
// The tick shows for a verified account only (VerifiedUserBadge reads User.isVerified()).
vi.mock('@app/features/user/components/VerifiedUserBadge', () => ({
	VerifiedUserBadge: ({user}: {user: {id: string; isVerified: () => boolean}}) =>
		user.isVerified() ? createElement('span', {'data-verified-badge': user.id}) : null,
}));
vi.mock('@app/features/user/commands/UserProfileCommands', () => ({
	openProfilePage: vi.fn(),
	openUserProfile: vi.fn(),
}));
vi.mock('@app/features/channel/components/TimestampWithTooltip', () => ({
	TimestampWithTooltip: ({children}: {children: ReactNode}) => createElement('time', null, children),
}));
vi.mock('@app/features/user/utils/DateFormatting', () => ({getRelativeDateString: () => '2 sa'}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({
	getNickname: (user: {username: string}) => user.username,
}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {enabled: false}}));
// The FocusRing mock marks the element it wraps, so a test can see which controls get Fluxer's focus ring.
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({
	default: ({children}: {children: ReactElement<Record<string, unknown>>}) =>
		cloneElement(children, {'data-focus-ring': ''}),
}));

const {
	default: FeedTimeline,
	HOME_TIMELINE,
	MAX_LOADED_FEED_POSTS,
} = await import('@app/features/feed/state/FeedTimeline');
const {FeedComments, feedCommentBoxId} = await import('@app/features/feed/components/FeedComments');
const FeedCommands = await import('@app/features/feed/commands/FeedCommands');
const FeedReplyCommands = await import('@app/features/feed/commands/FeedReplyCommands');
const ContextMenuCommands = await import('@app/features/ui/commands/ContextMenuCommands');
const ModalCommands = await import('@app/features/ui/commands/ModalCommands');
const UserProfileCommands = await import('@app/features/user/commands/UserProfileCommands');
const {observeIntersection} = await import('@app/features/platform/utils/SharedIntersectionObserver');
const {default: MobileLayout} = await import('@app/features/ui/state/MobileLayout');

function wireUser(id: string) {
	return {
		id,
		username: `user${id}`,
		discriminator: '0001',
		global_name: null,
		avatar: null,
		avatar_color: null,
		flags: 0,
	};
}

const wirePost: FeedPostResponse = {
	id: '100',
	author: wireUser('7'),
	content: 'post',
	attachments: [],
	edited_at: null,
	like_count: 0,
	comment_count: 2,
	liked: false,
};

function wireComment(id: string, authorId: string): FeedCommentResponse {
	return {id, post_id: '100', author: wireUser(authorId), content: `comment by ${authorId}`, edited_at: null};
}

function wireReply(id: string, authorId: string): FeedCommentResponse {
	return {...wireComment(id, authorId), content: `reply ${id}`, parent_id: '201'};
}

// The comment 201 by user 9 with its replies open, as FeedReplyCommands.openReplies leaves it once they load.
function openRepliesOf201(replies: Array<FeedCommentResponse>) {
	FeedTimeline.handleThreadRestart('100');
	FeedTimeline.handleThreadSuccess('100', [
		{...wireComment('201', '9'), reply_count: replies.length},
		wireComment('200', BLOCKED_USER_ID),
	]);
	FeedTimeline.openReplies('100', '201');
	FeedTimeline.handleRepliesSuccess('100', '201', replies);
}

describe('FeedComments', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		for (const key of Object.keys(limits)) delete limits[key];
		(MobileLayout as {enabled: boolean}).enabled = false;
		FeedTimeline.reset();
		FeedTimeline.open(HOME_TIMELINE);
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost], false);
		FeedTimeline.openThread('100');
		FeedTimeline.handleThreadSuccess('100', [wireComment('201', '9'), wireComment('200', BLOCKED_USER_ID)]);
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const inlineGifs = () => container.querySelector('[data-inline-gifs]')?.getAttribute('data-inline-gifs');

	// Micup: the feed opens the full profile page, not the modal.
	it('opens the commenter profile page from the name and the avatar, not the profile modal', () => {
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		const row = container.querySelector('[data-flx="feed.feed-comments.comment-row.comment"]')!;
		act(() =>
			row
				.querySelector<HTMLButtonElement>('[data-flx="feed.feed-comments.comment-row.comment-author.open-profile"]')!
				.click(),
		);
		act(() =>
			row
				.querySelector<HTMLButtonElement>('[data-flx="feed.feed-comments.comment-row.avatar-button.open-profile"]')!
				.click(),
		);
		expect(vi.mocked(UserProfileCommands.openProfilePage).mock.calls).toEqual([['9'], ['9']]);
		expect(UserProfileCommands.openUserProfile).not.toHaveBeenCalled();
	});

	it('lets comments draw their GIFs inline on a post outside Discover', () => {
		limits.feature_feed_discover_media = 0;
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		expect(inlineGifs()).toBe('true');
	});

	// with Discover media off, a stranger's Discover post must not show media, comment GIFs included.
	it('keeps comment GIFs as links on a Discover post while Discover media is off', () => {
		const discoverPost = {...FeedTimeline.getPost('100')!, authorFollowing: false};
		limits.feature_feed_discover_media = 0;
		act(() => root.render(createElement(FeedComments, {post: discoverPost})));
		expect(inlineGifs()).toBe('false');
		limits.feature_feed_discover_media = 1;
		act(() => root.render(createElement(FeedComments, {post: {...discoverPost}})));
		expect(inlineGifs()).toBe('true');
	});

	it("gives the blocked comment's show button Fluxer's focus ring", () => {
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		const toggle = Array.from(container.querySelectorAll('button')).find(
			(button) => button.textContent === 'Blocked comment',
		);
		expect(toggle?.hasAttribute('data-focus-ring')).toBe(true);
	});

	it('collapses a comment by a blocked account, like a blocked message, until it is shown', () => {
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		expect(container.textContent).toContain('comment by 9');
		expect(container.textContent).not.toContain(`comment by ${BLOCKED_USER_ID}`);
		expect(container.textContent).not.toContain(`user${BLOCKED_USER_ID}`);
		const toggle = Array.from(container.querySelectorAll('button')).find(
			(button) => button.textContent === 'Blocked comment',
		);
		expect(toggle?.getAttribute('aria-expanded')).toBe('false');
		act(() => toggle!.click());
		expect(container.textContent).toContain(`comment by ${BLOCKED_USER_ID}`);
	});

	it('lists the comments oldest first, the older-comments button above them and the reply box below', () => {
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		const html = container.innerHTML;
		const older = html.indexOf('Show older comments');
		const oldest = html.indexOf('Blocked comment');
		const newest = html.indexOf('comment by 9');
		const replyBox = html.indexOf('<textarea');
		expect(older).toBeGreaterThanOrEqual(0);
		expect(older).toBeLessThan(oldest);
		expect(oldest).toBeLessThan(newest);
		expect(newest).toBeLessThan(replyBox);
	});

	it('shows when each comment was written', () => {
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		// The blocked comment stays collapsed, so only the other one shows its time.
		expect(container.querySelectorAll('time')).toHaveLength(1);
		expect(container.textContent).toContain('2 sa');
	});

	it('keeps the back-to-newest button between the newest loaded comment and the reply box', () => {
		// One comment past the cap: the store drops the newest one (5000) and offers to reload from it.
		const page = Array.from({length: MAX_LOADED_FEED_POSTS + 1}, (_, index) => ({
			...wireComment(String(5000 - index), '9'),
			content: `numbered ${5000 - index}`,
		}));
		FeedTimeline.handleThreadRestart('100');
		FeedTimeline.handleThreadSuccess('100', page);
		expect(FeedTimeline.getThread('100')!.droppedCount).toBe(1);
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		const html = container.innerHTML;
		const newest = html.indexOf('numbered 4999');
		const back = html.indexOf('Back to the newest comments');
		const replyBox = html.indexOf('<textarea');
		expect(html).not.toContain('numbered 5000');
		expect(newest).toBeGreaterThanOrEqual(0);
		expect(newest).toBeLessThan(back);
		expect(back).toBeLessThan(replyBox);
	});

	it('puts focus in the reply box only when asked to', () => {
		(document.activeElement as HTMLElement | null)?.blur();
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		expect(document.activeElement).not.toBe(container.querySelector('textarea'));
		act(() => root.unmount());
		root = createRoot(container);
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!, autoFocus: true})));
		expect(document.activeElement).toBe(container.querySelector('textarea'));
	});

	const buttonNamed = (name: string) =>
		Array.from(container.querySelectorAll('button')).find((button) => button.textContent === name);
	// The row of a comment or reply holds the rows of its replies, so the nearest row around the "..." button is its own.
	const menuButtonOf = (text: string) =>
		Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label="Comment options"]')).find(
			(button) =>
				button.closest('[data-flx="feed.feed-comments.comment-row.comment"]')?.textContent?.includes(text) &&
				!button.closest('[data-flx="feed.feed-comments.comment-row.comment"]')?.textContent?.includes('comment by 9'),
		);

	it('shows N replies and loads them when opened', () => {
		FeedTimeline.handleThreadRestart('100');
		FeedTimeline.handleThreadSuccess('100', [{...wireComment('201', '9'), reply_count: 2}]);
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		const toggle = buttonNamed('2 replies');
		expect(toggle?.getAttribute('aria-expanded')).toBe('false');

		act(() => toggle!.click());
		expect(FeedReplyCommands.openReplies).toHaveBeenCalledWith('100', expect.objectContaining({id: '201'}));
		act(() => {
			FeedTimeline.openReplies('100', '201');
			FeedTimeline.handleRepliesSuccess('100', '201', [wireReply('302', '7'), wireReply('301', '9')]);
		});

		expect(toggle!.getAttribute('aria-expanded')).toBe('true');
		const html = container.innerHTML;
		expect(html.indexOf('comment by 9')).toBeLessThan(html.indexOf('reply 301'));
		expect(html.indexOf('reply 301')).toBeLessThan(html.indexOf('reply 302'));
		act(() => toggle!.click());
		expect(container.textContent).not.toContain('reply 301');
	});

	it('the reply button opens the replies of a comment and puts focus in their reply box', () => {
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		act(() => buttonNamed('Reply')!.click());
		expect(FeedReplyCommands.openReplies).toHaveBeenCalledWith('100', expect.objectContaining({id: '201'}));
		act(() => {
			FeedTimeline.openReplies('100', '201');
			FeedTimeline.handleRepliesSuccess('100', '201', []);
		});

		expect(document.activeElement).toBe(container.querySelector('textarea[aria-label="Write a reply"]'));
	});

	// GIF and emoji inside the comment box (Textarea's innerActionButton).
	it('puts GIF and emoji inside the comment box', () => {
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		expect(container.querySelector('[data-textarea-box] [data-flx="feed.feed-comments.tools"]')).not.toBeNull();
	});

	// the verified tick beside the name, as on the post card, on comments and replies.
	it('shows the verified tick beside the name of a verified comment or reply author only', () => {
		const verified = {...wireComment('202', '11'), author: {...wireUser('11'), flags: PublicUserFlags.VERIFIED}};
		FeedTimeline.handleThreadSuccess('100', [verified, wireComment('201', '9')]);
		FeedTimeline.openReplies('100', '202');
		FeedTimeline.handleRepliesSuccess('100', '202', [
			{...wireReply('302', '11'), parent_id: '202', author: verified.author},
			{...wireReply('303', '9'), parent_id: '202'},
		]);
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		const ticks = Array.from(container.querySelectorAll('[data-verified-badge]'));
		expect(ticks.map((tick) => tick.getAttribute('data-verified-badge'))).toEqual(['11', '11']);
		for (const tick of ticks) {
			expect(tick.closest('[data-flx="feed.feed-comments.comment-row.comment-header"]')).not.toBeNull();
		}
	});

	it('tags the comments and replies of the post author', () => {
		openRepliesOf201([wireReply('301', '7')]);
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		const tags = Array.from(container.querySelectorAll('span')).filter((span) => span.textContent === 'Author');
		expect(tags).toHaveLength(1);
		expect(tags[0]!.closest('[data-flx="feed.feed-comments.comment-row.comment"]')?.textContent).toContain('reply 301');
	});

	it('reports a reply with its parent comment id and deletes one through the reply route', async () => {
		openRepliesOf201([wireReply('302', '9'), wireReply('301', '1')]);
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		const openMenuOf = (text: string) => {
			act(() => menuButtonOf(text)!.click());
			const render = vi.mocked(ContextMenuCommands.openFromElementBottomRight).mock.calls.at(-1)![1] as (props: {
				onClose: () => void;
			}) => ReactElement<{onDelete: (() => Promise<void>) | null; onReport: (() => void) | null}>;
			return render({onClose: vi.fn()}).props;
		};

		const theirs = openMenuOf('reply 302');
		expect(theirs.onDelete).toBeNull();
		theirs.onReport!();
		const reportModal = (
			vi.mocked(ModalCommands.push).mock.calls.at(-1)![0] as unknown as () => ReactElement<{
				onSubmit: (category: string) => Promise<void>;
			}>
		)();
		await reportModal.props.onSubmit('spam');
		expect(FeedReplyCommands.reportReply).toHaveBeenCalledWith('100', '201', '302', 'spam');

		const mine = openMenuOf('reply 301');
		expect(mine.onReport).toBeNull();
		await mine.onDelete!();
		expect(FeedReplyCommands.deleteReply).toHaveBeenCalledWith('100', '201', '301');
	});

	it('deleting a comment removes its replies from view', () => {
		openRepliesOf201([wireReply('301', '9')]);
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		expect(container.textContent).toContain('reply 301');

		act(() => FeedTimeline.handleCommentRemoved('100', '201'));

		expect(container.textContent).not.toContain('comment by 9');
		expect(container.textContent).not.toContain('reply 301');
	});

	it('the page layout lists newest first and loads older comments when the end comes into view', () => {
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!, layout: 'page'})));
		const html = container.innerHTML;
		const replyBox = html.indexOf('<textarea');
		const newest = html.indexOf('comment by 9');
		const oldest = html.indexOf('Blocked comment');
		expect(replyBox).toBeGreaterThanOrEqual(0);
		expect(replyBox).toBeLessThan(newest);
		expect(newest).toBeLessThan(oldest);
		expect(html).not.toContain('Show older comments');

		const [sentinel, onIntersect] = vi.mocked(observeIntersection).mock.calls.at(-1)!;
		expect(container.contains(sentinel)).toBe(true);
		expect(html.indexOf('Blocked comment')).toBeLessThan(html.indexOf((sentinel as Element).outerHTML));
		onIntersect({isIntersecting: false} as IntersectionObserverEntry);
		expect(FeedCommands.loadComments).not.toHaveBeenCalled();
		onIntersect({isIntersecting: true} as IntersectionObserverEntry);
		expect(FeedCommands.loadComments).toHaveBeenCalledWith('100');
	});

	it('offers older comments when an empty page carries continuation', () => {
		FeedTimeline.handleThreadRestart('100');
		FeedTimeline.handleThreadSuccess('100', [], '150');
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		expect(
			Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Show older comments'),
		).toBe(true);
	});

	// The comment button of the post card above it puts focus there (FeedPostCard, variant 'page').
	it('names the comment box of the page layout for its post, and no box of the inline panel', () => {
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!, layout: 'page'})));
		expect(container.querySelector('textarea')!.id).toBe(feedCommentBoxId('100'));
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		expect(container.querySelector('textarea')!.id).toBe('');
	});

	const avatarSizeOf = (text: string) =>
		Array.from(container.querySelectorAll('[data-flx="feed.feed-comments.comment-row.comment"]'))
			.find((row) => row.querySelector('p')?.textContent === text)
			?.querySelector('[data-avatar-user]')
			?.getAttribute('data-avatar-size');

	it('the page comment box shows your avatar', () => {
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!, layout: 'page'})));
		const box = container.querySelector('[data-flx="feed.feed-comments.comment-composer"]')!;
		const avatar = box.querySelector('[data-avatar-user]');
		expect(avatar?.getAttribute('data-avatar-user')).toBe('1');
		expect(avatar?.getAttribute('data-avatar-size')).toBe('32');
		expect(box.firstElementChild).toBe(avatar);

		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		expect(container.querySelector('[data-flx="feed.feed-comments.comment-composer"] [data-avatar-user]')).toBeNull();
	});

	it('top-level comments on the page use 32px avatars, replies and the inline panel 24px', () => {
		openRepliesOf201([wireReply('301', '9')]);
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!, layout: 'page'})));
		expect(avatarSizeOf('comment by 9')).toBe('32');
		expect(avatarSizeOf('reply 301')).toBe('24');

		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		expect(avatarSizeOf('comment by 9')).toBe('24');
		expect(avatarSizeOf('reply 301')).toBe('24');
	});

	// The phone layout of the post page stays as it was: the design's bigger avatars are for the desktop layout only.
	it('keeps 24px avatars and no avatar in the comment box on the phone layout of the page', () => {
		(MobileLayout as {enabled: boolean}).enabled = true;
		openRepliesOf201([wireReply('301', '9')]);
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!, layout: 'page'})));
		expect(avatarSizeOf('comment by 9')).toBe('24');
		expect(avatarSizeOf('reply 301')).toBe('24');
		expect(container.querySelector('[data-flx="feed.feed-comments.comment-composer"] [data-avatar-user]')).toBeNull();
	});

	it("gives the name, Reply, N replies and the comment menu button Fluxer's focus ring", () => {
		FeedTimeline.handleThreadRestart('100');
		FeedTimeline.handleThreadSuccess('100', [{...wireComment('201', '9'), reply_count: 2}]);
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		const row = container.querySelector('[data-flx="feed.feed-comments.comment-row.comment"]')!;
		for (const flx of [
			'feed.feed-comments.comment-row.comment-author.open-profile',
			'feed.feed-comments.comment-row.button.reply',
			'feed.feed-comments.comment-row.button.toggle-replies',
			'feed.feed-comments.comment-row.more-button.open-menu',
		]) {
			expect(row.querySelector(`[data-flx="${flx}"]`)?.hasAttribute('data-focus-ring'), flx).toBe(true);
		}
	});

	it('Reply and N replies carry their icons', () => {
		FeedTimeline.handleThreadRestart('100');
		FeedTimeline.handleThreadSuccess('100', [{...wireComment('201', '9'), reply_count: 2}]);
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!})));
		const reply = buttonNamed('Reply')!.querySelector('svg');
		const replies = buttonNamed('2 replies')!.querySelector('svg');
		expect(reply?.getAttribute('data-flx')).toBe('feed.feed-comments.comment-row.reply-icon');
		expect(replies?.getAttribute('data-flx')).toBe('feed.feed-comments.comment-row.replies-icon');
		for (const icon of [reply, replies]) expect(icon?.getAttribute('aria-hidden')).toBe('true');
	});

	it('the page layout opens the comments of its post by itself', () => {
		FeedTimeline.closeThread('100');
		act(() => root.render(createElement(FeedComments, {post: FeedTimeline.getPost('100')!, layout: 'page'})));
		expect(FeedTimeline.getThread('100')).not.toBeNull();
		expect(container.querySelector('textarea')).not.toBeNull();
	});
});

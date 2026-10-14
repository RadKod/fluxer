// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {FeedComment} from '@app/features/feed/state/FeedTimeline';
import type {FeedCommentResponse, FeedPostResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {act, cloneElement, createElement, forwardRef, type ReactElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

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
vi.mock('@app/features/feed/commands/FeedReplyCommands', () => ({
	loadReplies: vi.fn(),
	retryReplies: vi.fn(),
	createReply: vi.fn(async () => 'ok'),
}));
vi.mock('@app/features/feed/components/FeedItemMenu', () => ({toastFeedFailure: vi.fn()}));
vi.mock('@app/features/feed/components/FeedExpressionButtons', () => ({FeedExpressionButtons: () => null}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick, disabled}: {children: ReactNode; onClick?: () => void; disabled?: boolean}) =>
		createElement('button', {type: 'button', onClick, disabled}, children),
}));
vi.mock('@app/features/ui/components/form/FormInput', () => ({
	Textarea: forwardRef<
		HTMLTextAreaElement,
		{
			'aria-label': string;
			value?: string;
			onChange?: (event: unknown) => void;
			onKeyDown?: (event: unknown) => void;
			innerActionButton?: ReactNode;
		}
	>(({'aria-label': label, value, onChange, onKeyDown, innerActionButton}, ref) =>
		createElement(
			'div',
			{'data-textarea-box': ''},
			createElement('textarea', {'aria-label': label, value, onChange, onKeyDown, ref}),
			innerActionButton,
		),
	),
}));
vi.mock('@app/features/ui/components/Spinner', () => ({Spinner: () => null}));
// The FocusRing mock marks the element it wraps, so a test can see which controls get Fluxer's focus ring.
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({
	default: ({children}: {children: ReactElement<Record<string, unknown>>}) =>
		cloneElement(children, {'data-focus-ring': ''}),
}));

const {default: FeedTimeline, HOME_TIMELINE} = await import('@app/features/feed/state/FeedTimeline');
const {FeedReplies} = await import('@app/features/feed/components/FeedReplies');
const FeedReplyCommands = await import('@app/features/feed/commands/FeedReplyCommands');

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
	comment_count: 4,
	liked: false,
};

function wireComment(id: string, authorId: string, fields: Partial<FeedCommentResponse> = {}): FeedCommentResponse {
	return {id, post_id: '100', author: wireUser(authorId), content: `reply ${id}`, edited_at: null, ...fields};
}

// Stands in for the comment row FeedComments draws for each reply: a button that answers the reply.
const renderReply = (reply: FeedComment, replyTo: () => void) =>
	createElement('button', {type: 'button', onClick: replyTo}, `answer ${reply.content}`);

describe('FeedReplies', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		FeedTimeline.reset();
		FeedTimeline.open(HOME_TIMELINE);
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost], false);
		FeedTimeline.openThread('100');
		FeedTimeline.handleThreadSuccess('100', [wireComment('201', '9', {content: 'comment', reply_count: 3})]);
		FeedTimeline.openReplies('100', '201');
		FeedTimeline.handleRepliesSuccess('100', '201', [
			wireComment('303', '9', {parent_id: '201'}),
			wireComment('302', '8', {parent_id: '201'}),
		]);
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const draw = (focusRequest = 0) => {
		const post = FeedTimeline.getPost('100')!;
		const comment = FeedTimeline.getThread('100')!.comments[0]!;
		act(() => root.render(createElement(FeedReplies, {post, comment, focusRequest, renderReply})));
	};
	const buttonNamed = (name: string) =>
		Array.from(container.querySelectorAll('button')).find((button) => button.textContent === name);
	const replyBox = () => container.querySelector('textarea')!;
	const type = (value: string) =>
		act(() => {
			Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(replyBox(), value);
			replyBox().dispatchEvent(new Event('input', {bubbles: true}));
		});

	// GIF and emoji inside the reply box, as in the comment box.
	it('puts GIF and emoji inside the reply box', () => {
		draw();
		expect(container.querySelector('[data-textarea-box] [data-flx="feed.feed-replies.tools"]')).not.toBeNull();
	});

	it('lists the replies oldest first under the earlier replies button, above its reply box', () => {
		draw();
		const html = container.innerHTML;
		const earlier = html.indexOf('Show earlier replies');
		expect(earlier).toBeGreaterThanOrEqual(0);
		expect(earlier).toBeLessThan(html.indexOf('reply 302'));
		expect(html.indexOf('reply 302')).toBeLessThan(html.indexOf('reply 303'));
		expect(html.indexOf('reply 303')).toBeLessThan(html.indexOf('<textarea'));
		expect(replyBox().getAttribute('aria-label')).toBe('Write a reply');

		act(() => buttonNamed('Show earlier replies')!.click());
		expect(FeedReplyCommands.loadReplies).toHaveBeenCalledWith('100', '201');
	});

	it('offers older replies when an empty page carries continuation', () => {
		FeedTimeline.closeReplies('100', '201');
		FeedTimeline.openReplies('100', '201');
		FeedTimeline.handleRepliesSuccess('100', '201', [], '300');
		draw();
		expect(buttonNamed('Show earlier replies')).toBeDefined();
		act(() => buttonNamed('Show earlier replies')!.click());
		expect(FeedReplyCommands.loadReplies).toHaveBeenCalledWith('100', '201');
	});

	it("gives Show earlier replies Fluxer's focus ring", () => {
		draw();
		expect(buttonNamed('Show earlier replies')!.hasAttribute('data-focus-ring')).toBe(true);
	});

	it('offers no earlier replies once every reply of the comment is shown', () => {
		FeedTimeline.handleThreadRestart('100');
		FeedTimeline.handleThreadSuccess('100', [wireComment('201', '9', {content: 'comment', reply_count: 2})]);
		draw();
		expect(container.innerHTML).toContain('reply 302');
		expect(buttonNamed('Show earlier replies')).toBeUndefined();
	});

	it('replying to a reply prefills @name in the same thread', () => {
		draw();
		act(() => buttonNamed('answer reply 303')!.click());
		expect(replyBox().value).toBe('@user9 ');
		expect(document.activeElement).toBe(replyBox());

		act(() => buttonNamed('answer reply 303')!.click());
		expect(replyBox().value).toBe('@user9 ');
	});

	it('sends a reply to the comment with Enter and empties the box', async () => {
		draw();
		type('@user9 same here');
		await act(async () => {
			replyBox().dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
		});
		expect(FeedReplyCommands.createReply).toHaveBeenCalledWith('100', '201', '@user9 same here');
		expect(replyBox().value).toBe('');
	});

	it('puts focus in the reply box only when asked to', () => {
		(document.activeElement as HTMLElement | null)?.blur();
		draw();
		expect(document.activeElement).not.toBe(replyBox());
		draw(1);
		expect(document.activeElement).toBe(replyBox());
	});

	it('offers to try again when the replies fail to load', () => {
		FeedTimeline.handleRepliesFailure('100', '201', 'error');
		draw();
		expect(container.textContent).toContain("Couldn't load the replies.");
		expect(buttonNamed('Show earlier replies')).toBeUndefined();
		act(() => buttonNamed('Try again')!.click());
		expect(FeedReplyCommands.retryReplies).toHaveBeenCalledWith('100', '201');
	});
});

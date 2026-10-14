// SPDX-License-Identifier: AGPL-3.0-or-later

import * as FeedReplyCommands from '@app/features/feed/commands/FeedReplyCommands';
import composerStyles from '@app/features/feed/components/FeedComposer.module.css';
import {FeedExpressionButtons} from '@app/features/feed/components/FeedExpressionButtons';
import {toastFeedFailure} from '@app/features/feed/components/FeedItemMenu';
import cardStyles from '@app/features/feed/components/FeedPostCard.module.css';
import styles from '@app/features/feed/components/FeedReplies.module.css';
import FeedTimeline, {type FeedComment, type FeedPost} from '@app/features/feed/state/FeedTimeline';
import {TRY_AGAIN_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import {Textarea} from '@app/features/ui/components/form/FormInput';
import {Spinner} from '@app/features/ui/components/Spinner';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {Fragment, useEffect, useRef, useState} from 'react';

// Same limit as a comment: a reply is a comment one level down.
const REPLY_MAX_LENGTH = 1000;

const WRITE_A_REPLY_DESCRIPTOR = msg({
	message: 'Write a reply',
	comment: 'Placeholder and accessible label of the reply box under a comment on a feed post.',
});
const SEND_DESCRIPTOR = msg({
	message: 'Send',
	comment: 'Button that posts the reply typed under a comment on a feed post. Keep it concise.',
});
const SHOW_EARLIER_REPLIES_DESCRIPTOR = msg({
	message: 'Show earlier replies',
	comment:
		'Button at the top of the replies under a comment on a feed post that loads the next, earlier page of replies above them.',
});
const COULDN_T_LOAD_REPLIES_DESCRIPTOR = msg({
	message: "Couldn't load the replies.",
	comment: 'Error under a comment on a feed post when its replies fail to load. A retry button follows.',
});
const YOU_CAN_T_VIEW_REPLIES_DESCRIPTOR = msg({
	message: "You can't view these replies.",
	comment:
		'Shown under a comment on a feed post when the server hides its replies from you. Keep tone plain and not blaming.',
});

interface FeedRepliesProps {
	post: FeedPost;
	comment: FeedComment;
	// Raised by the comment's Reply button: focus goes to the reply box, also when the replies are open already.
	focusRequest: number;
	// Draws one reply; replyTo starts an answer to it in this thread.
	renderReply: (reply: FeedComment, replyTo: () => void) => React.ReactNode;
}

// The replies under a top-level comment, oldest first like the comments, with their own reply box at the bottom.
export const FeedReplies = observer(({post, comment, focusRequest, renderReply}: FeedRepliesProps) => {
	const {i18n} = useLingui();
	const [draft, setDraft] = useState('');
	const [isSending, setIsSending] = useState(false);
	const replyBoxRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (focusRequest > 0) replyBoxRef.current?.focus();
	}, [focusRequest]);
	const thread = FeedTimeline.getReplies(post.id, comment.id);
	if (!thread) return null;
	const canSend = !isSending && draft.trim().length > 0;
	const send = async () => {
		if (!canSend) return;
		setIsSending(true);
		const outcome = await FeedReplyCommands.createReply(post.id, comment.id, draft);
		setIsSending(false);
		if (outcome === 'ok') setDraft('');
		else toastFeedFailure(i18n, outcome);
	};
	const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			void send();
		}
	};
	// Replies are one level deep: an answer to a reply goes under the same comment and names whom it answers.
	const replyTo = (reply: FeedComment) => {
		const mention = `@${reply.author.username} `;
		setDraft((current) => (current.startsWith(mention) ? current : `${mention}${current}`));
		replyBoxRef.current?.focus();
	};
	const placeholder = i18n._(WRITE_A_REPLY_DESCRIPTOR);
	const oldestFirst = [...thread.comments].reverse();
	return (
		<div className={styles.thread} data-flx="feed.feed-replies.thread">
			{!thread.isLoading &&
				!thread.failure &&
				thread.hasMore &&
				(thread.comments.length > 0 || thread.nextBefore !== undefined) &&
				thread.comments.length < comment.replyCount && (
					<FocusRing offset={-2} data-flx="feed.feed-replies.load-earlier-focus-ring">
						<button
							type="button"
							className={styles.textButton}
							onClick={() => void FeedReplyCommands.loadReplies(post.id, comment.id)}
							data-flx="feed.feed-replies.button.load-earlier"
						>
							{i18n._(SHOW_EARLIER_REPLIES_DESCRIPTOR)}
						</button>
					</FocusRing>
				)}
			{thread.isLoading && (
				<div className={cardStyles.status} data-flx="feed.feed-replies.status">
					<Spinner size="small" data-flx="feed.feed-replies.spinner" />
				</div>
			)}
			{thread.failure === 'forbidden' && (
				<p className={cardStyles.status} data-flx="feed.feed-replies.status--2">
					{i18n._(YOU_CAN_T_VIEW_REPLIES_DESCRIPTOR)}
				</p>
			)}
			{thread.failure === 'error' && (
				<div className={cardStyles.status} data-flx="feed.feed-replies.status--3">
					{i18n._(COULDN_T_LOAD_REPLIES_DESCRIPTOR)}
					<Button
						small
						variant="secondary"
						onClick={() => void FeedReplyCommands.retryReplies(post.id, comment.id)}
						data-flx="feed.feed-replies.button.retry"
					>
						{i18n._(TRY_AGAIN_DESCRIPTOR)}
					</Button>
				</div>
			)}
			{oldestFirst.map((reply) => (
				<Fragment key={reply.id}>{renderReply(reply, () => replyTo(reply))}</Fragment>
			))}
			<div className={cardStyles.commentComposer} data-flx="feed.feed-replies.reply-composer">
				<div className={cardStyles.commentComposerInput} data-flx="feed.feed-replies.reply-composer-input">
					<Textarea
						ref={replyBoxRef}
						label={null}
						aria-label={placeholder}
						placeholder={placeholder}
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={handleKeyDown}
						maxLength={REPLY_MAX_LENGTH}
						minRows={1}
						maxRows={4}
						disabled={isSending}
						data-flx="feed.feed-replies.textarea"
						innerActionButton={
							<div className={composerStyles.tools} data-flx="feed.feed-replies.tools">
								<FeedExpressionButtons
									textareaRef={replyBoxRef}
									value={draft}
									onChange={setDraft}
									maxLength={REPLY_MAX_LENGTH}
									disabled={isSending}
									buttonClassName={composerStyles.toolButton}
									iconClassName={composerStyles.toolIcon}
									data-flx="feed.feed-replies.feed-expression-buttons"
								/>
							</div>
						}
					/>
				</div>
				<Button
					small
					fitContent
					className={cardStyles.sendButton}
					onClick={send}
					disabled={!canSend}
					submitting={isSending}
					data-flx="feed.feed-replies.button.send"
				>
					{i18n._(SEND_DESCRIPTOR)}
				</Button>
			</div>
		</div>
	);
});

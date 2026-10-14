// SPDX-License-Identifier: AGPL-3.0-or-later

import Authentication from '@app/features/auth/state/Authentication';
import {TimestampWithTooltip} from '@app/features/channel/components/TimestampWithTooltip';
import * as FeedCommands from '@app/features/feed/commands/FeedCommands';
import * as FeedReplyCommands from '@app/features/feed/commands/FeedReplyCommands';
import composerStyles from '@app/features/feed/components/FeedComposer.module.css';
import {FeedExpressionButtons} from '@app/features/feed/components/FeedExpressionButtons';
import {FeedItemMenu, toastFeedFailure} from '@app/features/feed/components/FeedItemMenu';
import styles from '@app/features/feed/components/FeedPostCard.module.css';
import {FeedPostContent} from '@app/features/feed/components/FeedPostContent';
import {FeedReplies} from '@app/features/feed/components/FeedReplies';
import replyStyles from '@app/features/feed/components/FeedReplies.module.css';
import {FeedReportModal} from '@app/features/feed/components/FeedReportModal';
import FeedTimeline, {type FeedComment, type FeedPost} from '@app/features/feed/state/FeedTimeline';
import {isFeedDiscoverMediaEnabled} from '@app/features/feed/utils/FeedUtils';
import {REPLY_DESCRIPTOR, TRY_AGAIN_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {observeIntersection} from '@app/features/platform/utils/SharedIntersectionObserver';
import Relationships from '@app/features/relationship/state/Relationships';
import {remFromPx} from '@app/features/theme/layout/RemFromPx';
import {MoreIcon} from '@app/features/ui/action_menu/ContextMenuIcons';
import {Button} from '@app/features/ui/button/Button';
import * as ContextMenuCommands from '@app/features/ui/commands/ContextMenuCommands';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {Avatar} from '@app/features/ui/components/Avatar';
import {Textarea} from '@app/features/ui/components/form/FormInput';
import {Spinner} from '@app/features/ui/components/Spinner';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import * as UserProfileCommands from '@app/features/user/commands/UserProfileCommands';
import {VerifiedUserBadge} from '@app/features/user/components/VerifiedUserBadge';
import Users from '@app/features/user/state/Users';
import {getRelativeDateString} from '@app/features/user/utils/DateFormatting';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import {extractTimestamp} from '@fluxer/snowflake/src/SnowflakeUtils';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {ArrowBendUpLeftIcon, ChatCircleIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useEffect, useRef, useState} from 'react';

const COMMENT_MAX_LENGTH = 1000;

const WRITE_A_COMMENT_DESCRIPTOR = msg({
	message: 'Write a comment',
	comment: 'Placeholder and accessible label of the comment box under a feed post.',
});
const SEND_DESCRIPTOR = msg({
	message: 'Send',
	comment: 'Button that posts the comment typed under a feed post. Keep it concise.',
});
const COMMENT_OPTIONS_DESCRIPTOR = msg({
	message: 'Comment options',
	comment: 'Accessible label of the "..." button on a feed comment that opens its menu.',
});
const DELETE_COMMENT_DESCRIPTOR = msg({
	message: 'Delete comment',
	comment: 'Menu action that deletes a comment under a feed post (your comment, or any comment on your post).',
});
const REPORT_COMMENT_DESCRIPTOR = msg({
	message: 'Report comment',
	comment: 'Menu action and report dialog title for reporting a comment under a feed post.',
});
const BLOCKED_COMMENT_DESCRIPTOR = msg({
	message: 'Blocked comment',
	comment:
		'Collapsed row in place of a feed comment written by an account you blocked. Clicking it shows the comment, like blocked messages in a channel.',
});
const LOAD_OLDER_COMMENTS_DESCRIPTOR = msg({
	message: 'Show older comments',
	comment:
		'Button at the top of the comments under a feed post that loads the next, older page of comments above them.',
});
const BACK_TO_NEWEST_COMMENTS_DESCRIPTOR = msg({
	message: 'Back to the newest comments',
	comment:
		'Button at the bottom of a long comment list, above the reply box, after its newest comments were unloaded to save memory. Reloads the list from the newest comment.',
});
const COULDN_T_LOAD_COMMENTS_DESCRIPTOR = msg({
	message: "Couldn't load the comments.",
	comment: 'Error under a feed post when its comments fail to load. A retry button follows.',
});
const YOU_CAN_T_VIEW_COMMENTS_DESCRIPTOR = msg({
	message: "You can't view these comments.",
	comment: 'Shown under a feed post when the server hides its comments from you. Keep tone plain and not blaming.',
});
const REPLIES_DESCRIPTOR = msg({
	message: '{count, plural, one {# reply} other {# replies}}',
	comment: 'Button under a comment on a feed post that shows or hides its replies. count is how many replies it has.',
});
const AUTHOR_DESCRIPTOR = msg({
	message: 'Author',
	comment: 'Small tag next to the name on a comment or reply written by the author of the feed post. Keep it short.',
});

interface CommentRowProps {
	comment: FeedComment;
	post: FeedPost;
	// Set on a reply: the top-level comment it answers, whose routes delete and report it, and whose thread its Reply
	// button answers in (onReply).
	parentId?: string;
	onReply?: () => void;
	// 'page' draws a top-level comment with a 32px avatar on the desktop layout, like the design's post page; replies,
	// the panel and the phone layout keep 24px.
	layout?: 'inline' | 'page';
}

const CommentRow = observer(({comment, post, parentId, onReply, layout}: CommentRowProps) => {
	const {i18n} = useLingui();
	const [revealed, setRevealed] = useState(false);
	const [replyFocusRequest, setReplyFocusRequest] = useState(0);
	const currentUserId = Authentication.currentUserId;
	const canDelete = comment.author.id === currentUserId || post.author.id === currentUserId;
	const repliesOpen = parentId === undefined && FeedTimeline.getReplies(post.id, comment.id) != null;
	const openProfile = () => UserProfileCommands.openProfilePage(comment.author.id);
	const writtenAt = new Date(extractTimestamp(comment.id));
	const avatarSize = layout === 'page' && parentId === undefined && !MobileLayout.enabled ? 32 : 24;
	const reply =
		onReply ??
		(() => {
			void FeedReplyCommands.openReplies(post.id, comment);
			setReplyFocusRequest((count) => count + 1);
		});
	const toggleReplies = () => {
		setReplyFocusRequest(0);
		if (repliesOpen) FeedTimeline.closeReplies(post.id, comment.id);
		else void FeedReplyCommands.openReplies(post.id, comment);
	};
	const remove = async () => {
		toastFeedFailure(
			i18n,
			await (parentId
				? FeedReplyCommands.deleteReply(post.id, parentId, comment.id)
				: FeedCommands.deleteComment(post.id, comment.id)),
		);
	};
	const report = () => {
		ModalCommands.push(
			modal(() => (
				<FeedReportModal
					title={i18n._(REPORT_COMMENT_DESCRIPTOR)}
					onSubmit={(category) =>
						parentId
							? FeedReplyCommands.reportReply(post.id, parentId, comment.id, category)
							: FeedCommands.reportComment(post.id, comment.id, category)
					}
					data-flx="feed.feed-comments.comment-row.report.feed-report-modal"
				/>
			)),
		);
	};
	const openMenu = (event: React.MouseEvent) => {
		ContextMenuCommands.openFromElementBottomRight(event, ({onClose}) => (
			<FeedItemMenu
				onClose={onClose}
				deleteLabel={DELETE_COMMENT_DESCRIPTOR}
				reportLabel={REPORT_COMMENT_DESCRIPTOR}
				onDelete={canDelete ? remove : null}
				onReport={comment.author.id === currentUserId ? null : report}
				data-flx="feed.feed-comments.comment-row.open-menu.feed-item-menu"
			/>
		));
	};
	// The server still returns comments by accounts you blocked (2a.8); they stay collapsed until you show them.
	if (!revealed && Relationships.isBlocked(comment.author.id)) {
		return (
			<FocusRing offset={-2} data-flx="feed.feed-comments.comment-row.blocked-comment-focus-ring">
				<button
					type="button"
					className={styles.blockedComment}
					aria-expanded={false}
					onClick={() => setRevealed(true)}
					data-flx="feed.feed-comments.comment-row.blocked-comment.reveal"
				>
					{i18n._(BLOCKED_COMMENT_DESCRIPTOR)}
				</button>
			</FocusRing>
		);
	}
	return (
		<div className={styles.comment} data-flx="feed.feed-comments.comment-row.comment">
			<button
				type="button"
				className={styles.avatarButton}
				onClick={openProfile}
				tabIndex={-1}
				aria-hidden
				data-flx="feed.feed-comments.comment-row.avatar-button.open-profile"
			>
				<Avatar user={comment.author} size={avatarSize} data-flx="feed.feed-comments.comment-row.avatar" />
			</button>
			<div className={styles.commentBody} data-flx="feed.feed-comments.comment-row.comment-body">
				<div className={styles.commentHeader} data-flx="feed.feed-comments.comment-row.comment-header">
					<FocusRing offset={-2} data-flx="feed.feed-comments.comment-row.author-focus-ring">
						<button
							type="button"
							className={styles.commentAuthor}
							onClick={openProfile}
							data-flx="feed.feed-comments.comment-row.comment-author.open-profile"
						>
							{NicknameUtils.getNickname(comment.author, null)}
						</button>
					</FocusRing>
					<VerifiedUserBadge
						user={comment.author}
						size={14}
						className={styles.commentBadge}
						data-flx="feed.feed-comments.comment-row.verified-user-badge"
					/>
					{comment.author.id === post.author.id && (
						<span className={replyStyles.authorTag} data-flx="feed.feed-comments.comment-row.author-tag">
							{i18n._(AUTHOR_DESCRIPTOR)}
						</span>
					)}
					<TimestampWithTooltip
						date={writtenAt}
						className={styles.timestamp}
						data-flx="feed.feed-comments.comment-row.timestamp"
					>
						{getRelativeDateString(writtenAt, i18n)}
					</TimestampWithTooltip>
				</div>
				<div className={styles.content} data-flx="feed.feed-comments.comment-row.content">
					{/* K23: authorFollowing is set only on Discover posts, where media waits for the Discover media switch. */}
					<FeedPostContent
						content={comment.content}
						postId={post.id}
						inlineGifs={post.authorFollowing === null || isFeedDiscoverMediaEnabled()}
						data-flx="feed.feed-comments.comment-row.feed-post-content"
					/>
				</div>
				<div className={replyStyles.actions} data-flx="feed.feed-comments.comment-row.actions">
					<FocusRing offset={-2} data-flx="feed.feed-comments.comment-row.reply-focus-ring">
						<button
							type="button"
							className={replyStyles.textButton}
							onClick={reply}
							data-flx="feed.feed-comments.comment-row.button.reply"
						>
							<ArrowBendUpLeftIcon
								size={remFromPx(14)}
								weight="bold"
								aria-hidden
								data-flx="feed.feed-comments.comment-row.reply-icon"
							/>
							{i18n._(REPLY_DESCRIPTOR)}
						</button>
					</FocusRing>
					{parentId === undefined && comment.replyCount > 0 && (
						<FocusRing offset={-2} data-flx="feed.feed-comments.comment-row.replies-focus-ring">
							<button
								type="button"
								className={replyStyles.textButton}
								aria-expanded={repliesOpen}
								onClick={toggleReplies}
								data-flx="feed.feed-comments.comment-row.button.toggle-replies"
							>
								<ChatCircleIcon
									size={remFromPx(14)}
									weight="bold"
									aria-hidden
									data-flx="feed.feed-comments.comment-row.replies-icon"
								/>
								{i18n._(REPLIES_DESCRIPTOR, {count: comment.replyCount})}
							</button>
						</FocusRing>
					)}
				</div>
				{repliesOpen && (
					<FeedReplies
						post={post}
						comment={comment}
						focusRequest={replyFocusRequest}
						renderReply={(entry, replyTo) => (
							<CommentRow
								comment={entry}
								post={post}
								parentId={comment.id}
								onReply={replyTo}
								data-flx="feed.feed-comments.comment-row.reply-row"
							/>
						)}
						data-flx="feed.feed-comments.comment-row.feed-replies"
					/>
				)}
			</div>
			<FocusRing offset={-2} data-flx="feed.feed-comments.comment-row.more-focus-ring">
				<button
					type="button"
					className={styles.moreButton}
					onClick={openMenu}
					aria-label={i18n._(COMMENT_OPTIONS_DESCRIPTOR)}
					data-flx="feed.feed-comments.comment-row.more-button.open-menu"
				>
					<MoreIcon size={16} data-flx="feed.feed-comments.comment-row.more-icon" />
				</button>
			</FocusRing>
		</div>
	);
});

// The comment box of a post page, where the comment button of the post card above it puts focus.
export function feedCommentBoxId(postId: string): string {
	return `feed-comment-box-${postId}`;
}

interface FeedCommentsProps {
	post: FeedPost;
	autoFocus?: boolean;
	// 'inline' is the panel under a post in a list: oldest first, older pages behind a button at the top. 'page' is the
	// post page: the reply box on top, newest first, and older pages load by themselves when the end comes into view.
	layout?: 'inline' | 'page';
}

export const FeedComments = observer(({post, autoFocus = false, layout = 'inline'}: FeedCommentsProps) => {
	const {i18n} = useLingui();
	const [draft, setDraft] = useState('');
	const [isSending, setIsSending] = useState(false);
	const commentBoxRef = useRef<HTMLTextAreaElement>(null);
	const [endOfList, setEndOfList] = useState<HTMLDivElement | null>(null);
	const thread = FeedTimeline.getThread(post.id);
	const canLoadOlder = thread != null && !thread.isLoading && !thread.failure && thread.hasMore;
	// The page shows its comments without a button to open them; the thread goes when the post's timeline closes.
	useEffect(() => {
		if (layout === 'page') FeedTimeline.openThread(post.id);
	}, [layout, post.id]);
	useEffect(() => {
		if (!endOfList || !canLoadOlder) return undefined;
		return observeIntersection(endOfList, (entry) => {
			if (entry.isIntersecting) void FeedCommands.loadComments(post.id);
		});
	}, [endOfList, canLoadOlder, post.id]);
	if (!thread) return null;
	const canSend = !isSending && draft.trim().length > 0;
	const send = async () => {
		if (!canSend) return;
		setIsSending(true);
		const outcome = await FeedCommands.createComment(post.id, draft);
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
	const placeholder = i18n._(WRITE_A_COMMENT_DESCRIPTOR);
	const currentUser = Users.currentUser;
	const status = (
		<>
			{thread.isLoading && (
				<div className={styles.status} data-flx="feed.feed-comments.status">
					<Spinner size="small" data-flx="feed.feed-comments.spinner" />
				</div>
			)}
			{thread.failure === 'forbidden' && (
				<p className={styles.status} data-flx="feed.feed-comments.status--2">
					{i18n._(YOU_CAN_T_VIEW_COMMENTS_DESCRIPTOR)}
				</p>
			)}
			{thread.failure === 'error' && (
				<div className={styles.status} data-flx="feed.feed-comments.status--3">
					{i18n._(COULDN_T_LOAD_COMMENTS_DESCRIPTOR)}
					<Button
						small
						variant="secondary"
						onClick={() => void FeedCommands.retryComments(post.id)}
						data-flx="feed.feed-comments.button.retry"
					>
						{i18n._(TRY_AGAIN_DESCRIPTOR)}
					</Button>
				</div>
			)}
		</>
	);
	const backToNewest = thread.droppedCount > 0 && (
		<Button
			small
			variant="secondary"
			onClick={() => void FeedCommands.restartComments(post.id)}
			disabled={thread.isLoading}
			data-flx="feed.feed-comments.button.restart"
		>
			{i18n._(BACK_TO_NEWEST_COMMENTS_DESCRIPTOR)}
		</Button>
	);
	const composer = (
		<div className={styles.commentComposer} data-flx="feed.feed-comments.comment-composer">
			{layout === 'page' && currentUser && !MobileLayout.enabled && (
				<Avatar user={currentUser} size={32} data-flx="feed.feed-comments.composer-avatar" />
			)}
			<div className={styles.commentComposerInput} data-flx="feed.feed-comments.comment-composer-input">
				<Textarea
					ref={commentBoxRef}
					label={null}
					aria-label={placeholder}
					placeholder={placeholder}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={handleKeyDown}
					maxLength={COMMENT_MAX_LENGTH}
					minRows={1}
					maxRows={4}
					disabled={isSending}
					autoFocus={autoFocus}
					id={layout === 'page' ? feedCommentBoxId(post.id) : undefined}
					data-flx="feed.feed-comments.textarea"
					innerActionButton={
						<div className={composerStyles.tools} data-flx="feed.feed-comments.tools">
							<FeedExpressionButtons
								textareaRef={commentBoxRef}
								value={draft}
								onChange={setDraft}
								maxLength={COMMENT_MAX_LENGTH}
								disabled={isSending}
								buttonClassName={composerStyles.toolButton}
								iconClassName={composerStyles.toolIcon}
								data-flx="feed.feed-comments.feed-expression-buttons"
							/>
						</div>
					}
				/>
			</div>
			<Button
				small
				fitContent
				className={styles.sendButton}
				onClick={send}
				disabled={!canSend}
				submitting={isSending}
				data-flx="feed.feed-comments.button.send"
			>
				{i18n._(SEND_DESCRIPTOR)}
			</Button>
		</div>
	);
	const rows = (comments: ReadonlyArray<FeedComment>) =>
		comments.map((comment) => (
			<CommentRow
				key={comment.id}
				comment={comment}
				post={post}
				layout={layout}
				data-flx="feed.feed-comments.comment-row"
			/>
		));
	if (layout === 'page') {
		// The store keeps the newest comment first, as the page shows them: a sent comment lands right under the box.
		return (
			<section className={styles.comments} data-flx="feed.feed-comments.comments">
				{composer}
				{backToNewest}
				{rows(thread.comments)}
				{status}
				<div ref={setEndOfList} aria-hidden data-flx="feed.feed-comments.end-of-list" />
			</section>
		);
	}
	// The panel reads oldest first like the design, so a sent comment lands right above the reply box  and older
	// pages load in at the top.
	return (
		<section className={styles.comments} data-flx="feed.feed-comments.comments">
			{!thread.isLoading &&
				!thread.failure &&
				thread.hasMore &&
				(thread.comments.length > 0 || thread.nextBefore !== undefined) && (
					<Button
						small
						variant="secondary"
						onClick={() => void FeedCommands.loadComments(post.id)}
						data-flx="feed.feed-comments.button.load-older"
					>
						{i18n._(LOAD_OLDER_COMMENTS_DESCRIPTOR)}
					</Button>
				)}
			{status}
			{rows([...thread.comments].reverse())}
			{backToNewest}
			{composer}
		</section>
	);
});

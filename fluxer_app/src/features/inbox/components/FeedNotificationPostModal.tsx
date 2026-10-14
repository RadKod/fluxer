// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Modal from '@app/features/app/components/dialogs/Modal';
import Authentication from '@app/features/auth/state/Authentication';
import {FeedPostCard} from '@app/features/feed/components/FeedPostCard';
import FeedTimeline from '@app/features/feed/state/FeedTimeline';
import * as FeedNotificationCommands from '@app/features/inbox/commands/FeedNotificationCommands';
import styles from '@app/features/inbox/components/FeedActivityContent.module.css';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {Spinner} from '@app/features/ui/components/Spinner';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useEffect} from 'react';

const YOUR_POST_DESCRIPTOR = msg({
	message: 'Your post',
	comment: 'Title of the modal that opens one of your feed posts from a like or comment notification in the inbox.',
});
const POST_DESCRIPTOR = msg({
	message: 'Post',
	context: 'feed-post-title',
	comment:
		'Title of the modal that opens a feed post from an inbox notification while it loads or when the post is not yours, for example a reply to your comment. A noun.',
});
const POST_UNAVAILABLE_DESCRIPTOR = msg({
	message: "This post can't be shown.",
	comment: 'Shown in place of a feed post that was deleted or failed to load, opened from an inbox notification.',
});

export const FeedNotificationPostModal = observer(({postId, showComments}: {postId: string; showComments: boolean}) => {
	const {i18n} = useLingui();
	const timelineKey = FeedNotificationCommands.feedPostTimelineKey(postId);
	useEffect(() => {
		FeedTimeline.open(timelineKey);
		void FeedNotificationCommands.loadPost(postId, showComments);
		return () => FeedTimeline.close(timelineKey);
	}, [timelineKey, postId, showComments]);
	const timeline = FeedTimeline.getTimeline(timelineKey);
	const post = timeline?.posts[0];
	const unavailable = !post && (timeline?.failure != null || timeline?.fetchedAt != null);
	// A reply notification can open someone else's post.
	const title = post?.author.id === Authentication.currentUserId ? YOUR_POST_DESCRIPTOR : POST_DESCRIPTOR;
	return (
		<Modal.Root size="medium" data-flx="inbox.feed-notification-post-modal.modal-root">
			<Modal.Header title={i18n._(title)} data-flx="inbox.feed-notification-post-modal.modal-header" />
			<Modal.Content data-flx="inbox.feed-notification-post-modal.content">
				{post && (
					<FeedPostCard
						post={post}
						onOpenPost={ModalCommands.popAll}
						data-flx="inbox.feed-notification-post-modal.feed-post-card"
					/>
				)}
				{unavailable && (
					<p className={styles.status} data-flx="inbox.feed-notification-post-modal.status">
						{i18n._(POST_UNAVAILABLE_DESCRIPTOR)}
					</p>
				)}
				{!post && !unavailable && (
					<div className={styles.status} data-flx="inbox.feed-notification-post-modal.status--2">
						<Spinner data-flx="inbox.feed-notification-post-modal.spinner" />
					</div>
				)}
			</Modal.Content>
		</Modal.Root>
	);
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Modal from '@app/features/app/components/dialogs/Modal';
import * as FeedCommands from '@app/features/feed/commands/FeedCommands';
import {FeedTimelineList} from '@app/features/feed/components/FeedTimelineList';
import FeedTimeline, {userTimelineKey} from '@app/features/feed/state/FeedTimeline';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import type {ScrollerHandle} from '@app/features/ui/components/Scroller';
import Users from '@app/features/user/state/Users';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useEffect, useRef} from 'react';

const POSTS_DESCRIPTOR = msg({
	message: 'Posts',
	comment: 'Title of the modal listing the feed posts of a user, when the user name is not known yet.',
});
const NO_POSTS_YET_DESCRIPTOR = msg({
	message: 'No posts yet.',
	comment: 'Empty state of the posts list of a user.',
});
const USER_POSTS_TITLE_DESCRIPTOR = msg({
	message: 'Posts · {displayName}',
	comment:
		'Title of the modal listing the feed posts of a user. {displayName} is the user name; keep it after the separator.',
});

export const FeedUserPostsModal = observer(({userId}: {userId: string}) => {
	const {i18n} = useLingui();
	const scrollerRef = useRef<ScrollerHandle>(null);
	const timelineKey = userTimelineKey(userId);
	useEffect(() => {
		FeedTimeline.open(timelineKey);
		if (FeedTimeline.isStale(timelineKey)) void FeedCommands.refresh(timelineKey);
		return () => FeedTimeline.close(timelineKey);
	}, [timelineKey]);
	const user = Users.getUser(userId);
	const title = user
		? i18n._(USER_POSTS_TITLE_DESCRIPTOR, {displayName: NicknameUtils.getNickname(user, null)})
		: i18n._(POSTS_DESCRIPTOR);
	return (
		<Modal.Root size="medium" data-flx="feed.feed-user-posts-modal.modal-root">
			<Modal.Header title={title} data-flx="feed.feed-user-posts-modal.modal-header" />
			<Modal.Content ref={scrollerRef} data-flx="feed.feed-user-posts-modal.content">
				<FeedTimelineList
					timelineKey={timelineKey}
					scrollerRef={scrollerRef}
					emptyText={i18n._(NO_POSTS_YET_DESCRIPTOR)}
					onOpenPost={ModalCommands.popAll}
					data-flx="feed.feed-user-posts-modal.feed-timeline-list"
				/>
			</Modal.Content>
		</Modal.Root>
	);
});

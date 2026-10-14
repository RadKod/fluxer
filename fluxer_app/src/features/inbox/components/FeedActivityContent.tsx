// SPDX-License-Identifier: AGPL-3.0-or-later

import previewStyles from '@app/features/app/components/shared/MessagePreview.module.css';
import {TimestampWithTooltip} from '@app/features/channel/components/TimestampWithTooltip';
import {TRY_AGAIN_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import * as FeedNotificationCommands from '@app/features/inbox/commands/FeedNotificationCommands';
import styles from '@app/features/inbox/components/FeedActivityContent.module.css';
import {FeedNotificationPostModal} from '@app/features/inbox/components/FeedNotificationPostModal';
import FeedNotifications, {type FeedNotification} from '@app/features/inbox/state/FeedNotifications';
import {describeFeedNotification} from '@app/features/inbox/utils/FeedNotificationText';
import {AvatarStack} from '@app/features/ui/avatars/AvatarStack';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {MentionBadge} from '@app/features/ui/components/MentionBadge';
import {Scroller, type ScrollerHandle} from '@app/features/ui/components/Scroller';
import {Spinner} from '@app/features/ui/components/Spinner';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import Popout from '@app/features/ui/state/Popout';
import {getAppRemScale} from '@app/features/ui/utils/AppZoomUtils';
import * as UserProfileCommands from '@app/features/user/commands/UserProfileCommands';
import {getRelativeDateString} from '@app/features/user/utils/DateFormatting';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import {
	FEED_NOTIFICATION_UNREAD_CAP,
	type FeedNotificationType,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {ArrowBendDownRightIcon, ChatCircleIcon, HeartIcon, type Icon, UserPlusIcon} from '@phosphor-icons/react';
import {useVirtualizer} from '@tanstack/react-virtual';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {useEffect, useRef} from 'react';

const ESTIMATED_ROW_HEIGHT_PX = 72;
const OVERSCAN_ROWS = 6;

const NO_ACTIVITY_YET_DESCRIPTOR = msg({
	message: 'No activity yet',
	comment: 'Empty-state title of the activity tab in the inbox popout.',
});
const ACTIVITY_EMPTY_DESCRIPTOR = msg({
	message: 'Likes, comments and new followers show up here.',
	comment: 'Empty-state text of the activity tab in the inbox popout, which lists feed notifications.',
});
const COULDN_T_LOAD_ACTIVITY_DESCRIPTOR = msg({
	message: "Couldn't load your activity.",
	comment: 'Error in the activity tab of the inbox popout when notifications fail to load. A retry button follows.',
});

const TYPE_ICONS: Record<FeedNotificationType, {icon: Icon; className: string}> = {
	post_like: {icon: HeartIcon, className: styles.typeLike},
	post_comment: {icon: ChatCircleIcon, className: styles.typeComment},
	follow: {icon: UserPlusIcon, className: styles.typeFollow},
	comment_reply: {icon: ArrowBendDownRightIcon, className: styles.typeComment},
};

export const FeedActivityTabIcon = observer(({className}: {className?: string}) => {
	const unreadCount = FeedNotifications.unreadCount;
	return (
		<span className={styles.tabIcon} data-flx="inbox.feed-activity-tab-icon.tab-icon">
			<HeartIcon weight="fill" className={className} data-flx="inbox.feed-activity-tab-icon.icon" />
			{unreadCount > 0 && (
				<span className={styles.tabBadge} data-flx="inbox.feed-activity-tab-icon.tab-badge">
					<MentionBadge
						mentionCount={unreadCount}
						size="small"
						max={FEED_NOTIFICATION_UNREAD_CAP - 1}
						data-flx="inbox.feed-activity-tab-icon.mention-badge"
					/>
				</span>
			)}
		</span>
	);
});

function openNotification(notification: FeedNotification): void {
	Popout.close('inbox');
	const {postId} = notification;
	if (postId) {
		ModalCommands.push(
			modal(() => (
				<FeedNotificationPostModal
					postId={postId}
					showComments={notification.type === 'post_comment' || notification.type === 'comment_reply'}
					data-flx="inbox.feed-activity-content.open-notification.feed-notification-post-modal"
				/>
			)),
		);
		return;
	}
	const actor = notification.actors[0];
	if (actor) UserProfileCommands.openUserProfile(actor.id);
}

const FeedNotificationRow = observer(({notification}: {notification: FeedNotification}) => {
	const {i18n} = useLingui();
	const lead = notification.actors[0];
	if (!lead) return null;
	const {icon: TypeIcon, className: typeClassName} = TYPE_ICONS[notification.type];
	const updatedAt = new Date(notification.updatedAt);
	const unread = FeedNotifications.isUnread(notification);
	return (
		<FocusRing offset={-2} data-flx="inbox.feed-notification-row.focus-ring">
			<button
				type="button"
				className={styles.row}
				onClick={() => openNotification(notification)}
				data-flx="inbox.feed-notification-row.row.open-notification"
			>
				<span className={clsx(styles.typeIcon, typeClassName)} data-flx="inbox.feed-notification-row.type-icon">
					<TypeIcon weight="fill" data-flx="inbox.feed-notification-row.type-icon-glyph" />
				</span>
				<span className={styles.body} data-flx="inbox.feed-notification-row.body">
					<AvatarStack
						users={notification.actors}
						size={24}
						maxVisible={3}
						enableProfileModal={false}
						showTooltips={false}
						data-flx="inbox.feed-notification-row.avatar-stack"
					/>
					<span className={styles.text} data-flx="inbox.feed-notification-row.text">
						{describeFeedNotification(
							i18n,
							notification.type,
							NicknameUtils.getNickname(lead, null),
							notification.actorCount,
						)}
					</span>
					<TimestampWithTooltip date={updatedAt} className={styles.time} data-flx="inbox.feed-notification-row.time">
						{getRelativeDateString(updatedAt, i18n)}
					</TimestampWithTooltip>
				</span>
				{unread && <span className={styles.unreadDot} data-flx="inbox.feed-notification-row.unread-dot" />}
			</button>
		</FocusRing>
	);
});

// Virtualized like the feed; the store holds at most 200 rows.
export const FeedActivityContent = observer(() => {
	const {i18n} = useLingui();
	const scrollerRef = useRef<ScrollerHandle>(null);
	useEffect(() => {
		FeedNotifications.openView();
		void FeedNotificationCommands.refresh();
		return () => void FeedNotificationCommands.markRead();
	}, []);
	const {notifications, fetched, isLoading, failed} = FeedNotifications;
	const virtualizer = useVirtualizer({
		count: notifications.length,
		getScrollElement: () => scrollerRef.current?.getViewportElement() ?? null,
		estimateSize: () => ESTIMATED_ROW_HEIGHT_PX * getAppRemScale(),
		getItemKey: (index) => notifications[index]?.id ?? index,
		overscan: OVERSCAN_ROWS,
	});
	const virtualRows = virtualizer.getVirtualItems();
	const lastVisibleIndex = virtualRows.at(-1)?.index ?? -1;
	useEffect(() => {
		if (lastVisibleIndex >= notifications.length - OVERSCAN_ROWS) void FeedNotificationCommands.loadMore();
	}, [lastVisibleIndex, notifications.length]);
	if (fetched && !isLoading && !failed && notifications.length === 0) {
		return (
			<div className={previewStyles.emptyState} data-flx="inbox.feed-activity-content.empty-state">
				<div className={previewStyles.emptyStateContent} data-flx="inbox.feed-activity-content.empty-state-content">
					<HeartIcon className={previewStyles.emptyStateIcon} data-flx="inbox.feed-activity-content.empty-state-icon" />
					<div
						className={previewStyles.emptyStateTextContainer}
						data-flx="inbox.feed-activity-content.empty-state-text-container"
					>
						<h3 className={previewStyles.emptyStateTitle} data-flx="inbox.feed-activity-content.empty-state-title">
							{i18n._(NO_ACTIVITY_YET_DESCRIPTOR)}
						</h3>
						<p
							className={previewStyles.emptyStateDescription}
							data-flx="inbox.feed-activity-content.empty-state-description"
						>
							{i18n._(ACTIVITY_EMPTY_DESCRIPTOR)}
						</p>
					</div>
				</div>
			</div>
		);
	}
	return (
		<Scroller className={styles.scroller} ref={scrollerRef} data-flx="inbox.feed-activity-content.scroller">
			<div
				className={styles.rows}
				style={{height: virtualizer.getTotalSize()}}
				role="feed"
				aria-busy={isLoading}
				data-flx="inbox.feed-activity-content.rows"
			>
				{virtualRows.map((virtualRow) => {
					const notification = notifications[virtualRow.index];
					if (!notification) return null;
					return (
						<div
							key={notification.id}
							ref={virtualizer.measureElement}
							data-index={virtualRow.index}
							className={styles.rowSlot}
							style={{transform: `translateY(${virtualRow.start}px)`}}
							data-flx="inbox.feed-activity-content.row-slot"
						>
							<FeedNotificationRow
								notification={notification}
								data-flx="inbox.feed-activity-content.feed-notification-row"
							/>
						</div>
					);
				})}
			</div>
			{isLoading && (
				<div className={styles.status} data-flx="inbox.feed-activity-content.status">
					<Spinner
						size={notifications.length === 0 ? 'medium' : 'small'}
						data-flx="inbox.feed-activity-content.spinner"
					/>
				</div>
			)}
			{failed && (
				<div className={styles.status} data-flx="inbox.feed-activity-content.status--2">
					{i18n._(COULDN_T_LOAD_ACTIVITY_DESCRIPTOR)}
					<Button
						small
						variant="secondary"
						onClick={() => void FeedNotificationCommands.retry()}
						data-flx="inbox.feed-activity-content.button.retry"
					>
						{i18n._(TRY_AGAIN_DESCRIPTOR)}
					</Button>
				</div>
			)}
		</Scroller>
	);
});

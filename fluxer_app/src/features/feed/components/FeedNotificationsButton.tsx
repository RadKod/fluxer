// SPDX-License-Identifier: AGPL-3.0-or-later

import {ChannelHeaderIcon} from '@app/features/channel/components/channel_header_components/ChannelHeaderIcon';
import styles from '@app/features/feed/components/FeedNotificationsButton.module.css';
import {INBOX_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import * as InboxCommands from '@app/features/inbox/commands/InboxCommands';
import {FeedActivityContent} from '@app/features/inbox/components/FeedActivityContent';
import FeedNotifications from '@app/features/inbox/state/FeedNotifications';
import {getInboxBadge} from '@app/features/inbox/utils/InboxBadge';
import {InboxPopout} from '@app/features/messaging/components/popouts/InboxPopout';
import {BottomSheet} from '@app/features/ui/bottom_sheet/BottomSheet';
import {InboxIcon} from '@app/features/ui/components/icons/InboxIcon';
import {MentionBadge} from '@app/features/ui/components/MentionBadge';
import {usePopout} from '@app/features/ui/hooks/usePopout';
import {Popout} from '@app/features/ui/popover/PopoverPopout';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import {FEED_NOTIFICATION_UNREAD_CAP} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useState} from 'react';

// The same messages as the DM list's screen-reader fragment and the inbox's activity tab, so their translations apply.
const UNREAD_DESCRIPTOR = msg({
	message: 'unread',
	comment: 'Lowercase screen-reader fragment after "Inbox" on the feed page inbox button when activity is unread.',
});
const ACTIVITY_DESCRIPTOR = msg({
	message: 'Activity',
	context: 'feed-activity',
	comment: 'Title of the bottom sheet listing likes and comments on your feed posts and your new followers.',
});

// Micup: the channel header's inbox button (InboxButton) at the end of the feed header, with the same badge (unread
// mentions plus the server's unread feed count). The phone sheet lists only the activity, so there it counts only that.
export const FeedNotificationsButton = observer(() => {
	const {i18n} = useLingui();
	const {isOpen, openProps} = usePopout('inbox');
	const [isSheetOpen, setIsSheetOpen] = useState(false);
	const {count: unreadCount, max} = MobileLayout.enabled
		? {count: FeedNotifications.unreadCount, max: FEED_NOTIFICATION_UNREAD_CAP - 1}
		: getInboxBadge();
	const hasUnread = unreadCount > 0;
	const label = hasUnread ? [i18n._(INBOX_DESCRIPTOR), i18n._(UNREAD_DESCRIPTOR)].join(', ') : i18n._(INBOX_DESCRIPTOR);
	return (
		<div className={styles.wrapper} data-flx="feed.feed-notifications-button.wrapper">
			{MobileLayout.enabled ? (
				// Fluxer has no inbox popout on the phone layout (its Notifications page); the activity list opens in a sheet.
				<>
					<ChannelHeaderIcon
						icon={InboxIcon}
						label={label}
						className={styles.button}
						isSelected={isSheetOpen}
						aria-haspopup="dialog"
						aria-expanded={isSheetOpen}
						onClick={() => setIsSheetOpen(true)}
						data-flx="feed.feed-notifications-button.channel-header-icon.open-sheet"
					/>
					<BottomSheet
						isOpen={isSheetOpen}
						onClose={() => setIsSheetOpen(false)}
						title={i18n._(ACTIVITY_DESCRIPTOR)}
						snapPoints={[0, 1]}
						initialSnap={1}
						data-flx="feed.feed-notifications-button.bottom-sheet"
					>
						<FeedActivityContent data-flx="feed.feed-notifications-button.feed-activity-content" />
					</BottomSheet>
				</>
			) : (
				// InboxButton's popout ('inbox', so opening a notification closes it) and keybind, on the activity tab, or on
				// the unread channels tab when only mentions (DMs included) are unread.
				<Popout
					data-flx="feed.feed-notifications-button.popout"
					{...openProps}
					render={() => <InboxPopout data-flx="feed.feed-notifications-button.inbox-popout" />}
					position="bottom-end"
					subscribeTo="INBOX_OPEN"
					onOpen={() => {
						const {mentionCount, count} = getInboxBadge();
						InboxCommands.setTab(mentionCount > 0 && count === mentionCount ? 'unreadChannels' : 'activity');
					}}
				>
					<ChannelHeaderIcon
						icon={InboxIcon}
						label={label}
						className={styles.button}
						isSelected={isOpen}
						aria-haspopup={true}
						aria-expanded={isOpen}
						keybindAction="chat_toggle_inbox"
						data-flx="feed.feed-notifications-button.channel-header-icon"
					/>
				</Popout>
			)}
			{hasUnread && (
				<span className={styles.badge} aria-hidden="true" data-flx="feed.feed-notifications-button.unread-badge">
					<MentionBadge
						mentionCount={unreadCount}
						size="small"
						max={max}
						data-flx="feed.feed-notifications-button.mention-badge"
					/>
				</span>
			)}
		</div>
	);
});

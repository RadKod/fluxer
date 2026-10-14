// SPDX-License-Identifier: AGPL-3.0-or-later

import type {FeedOutcome} from '@app/features/feed/commands/FeedCommands';
import {TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {DeleteIcon, ReportMessageIcon} from '@app/features/ui/action_menu/ContextMenuIcons';
import {MenuGroup} from '@app/features/ui/action_menu/MenuGroup';
import {MenuItem} from '@app/features/ui/action_menu/MenuItem';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import type {I18n, MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';

const POST_UNAVAILABLE_DESCRIPTOR = msg({
	message: 'This post is no longer available.',
	comment: 'Toast when acting on a feed post that was deleted or is hidden from you.',
});
const FEED_ACTION_NOT_ALLOWED_DESCRIPTOR = msg({
	message: "You can't do that here.",
	comment: 'Toast when the server refuses a feed action, for example because the feed is off or an account is blocked.',
});
const FEED_INPUT_REFUSED_DESCRIPTOR = msg({
	message: 'Check what you wrote and try again.',
	comment:
		'Toast when a new feed post is refused as it is, for example poll answers that turn out to repeat. Nothing was posted.',
});

// One toast per failed feed action; 'ok' stays silent.
export function toastFeedFailure(i18n: I18n, outcome: FeedOutcome): void {
	if (outcome === 'gone') ToastCommands.error(i18n._(POST_UNAVAILABLE_DESCRIPTOR));
	else if (outcome === 'forbidden') ToastCommands.error(i18n._(FEED_ACTION_NOT_ALLOWED_DESCRIPTOR));
	else if (outcome === 'failed') ToastCommands.error(i18n._(TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR));
	else if (outcome === 'invalid') ToastCommands.error(i18n._(FEED_INPUT_REFUSED_DESCRIPTOR));
}

interface FeedItemMenuProps {
	onClose: () => void;
	deleteLabel: MessageDescriptor;
	reportLabel: MessageDescriptor;
	onDelete: (() => void) | null;
	onReport: (() => void) | null;
}

// The "..." menu of a post or a comment: delete for whoever may delete it, report for everyone else.
export const FeedItemMenu = observer(({onClose, deleteLabel, reportLabel, onDelete, onReport}: FeedItemMenuProps) => {
	const {i18n} = useLingui();
	const run = (action: () => void) => () => ModalCommands.runAfterBottomSheetClose(onClose, action);
	return (
		<MenuGroup data-flx="feed.feed-item-menu.menu-group">
			{onDelete && (
				<MenuItem
					icon={<DeleteIcon data-flx="feed.feed-item-menu.delete-icon" />}
					onClick={run(onDelete)}
					danger
					data-flx="feed.feed-item-menu.menu-item.delete"
				>
					{i18n._(deleteLabel)}
				</MenuItem>
			)}
			{onReport && (
				<MenuItem
					icon={<ReportMessageIcon data-flx="feed.feed-item-menu.report-message-icon" />}
					onClick={run(onReport)}
					danger
					data-flx="feed.feed-item-menu.menu-item.report"
				>
					{i18n._(reportLabel)}
				</MenuItem>
			)}
		</MenuGroup>
	);
});

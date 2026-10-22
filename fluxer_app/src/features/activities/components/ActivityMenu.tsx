// SPDX-License-Identifier: AGPL-3.0-or-later

import {leaveVoiceActivity} from '@app/features/activities/commands/VoiceActivityCommands';
import {END_ACTIVITY_DESCRIPTOR, LEAVE_ACTIVITY_DESCRIPTOR} from '@app/features/activities/components/ActivityMessages';
import VoiceActivities from '@app/features/activities/state/VoiceActivities';
import {remFromPx} from '@app/features/theme/layout/RemFromPx';
import {MenuGroup} from '@app/features/ui/action_menu/MenuGroup';
import {MenuItem} from '@app/features/ui/action_menu/MenuItem';
import * as ContextMenuCommands from '@app/features/ui/commands/ContextMenuCommands';
import {useLingui} from '@lingui/react/macro';
import {SignOutIcon, StopCircleIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';

// Leave for whoever takes part; ending is open to everyone in the channel, as the server allows it.
const ActivityMenu = observer(function ActivityMenu({channelId}: {readonly channelId: string}) {
	const {i18n} = useLingui();
	const live = VoiceActivities.getLive(channelId);
	const joined = VoiceActivities.isJoined(channelId);
	return (
		<MenuGroup data-flx="activities.activity-menu.menu-group">
			{joined && (
				<MenuItem
					icon={<SignOutIcon size={remFromPx(16)} weight="bold" data-flx="activities.activity-menu.leave-icon" />}
					onClick={() => leaveVoiceActivity(channelId)}
					data-flx="activities.activity-menu.leave"
				>
					{i18n._(LEAVE_ACTIVITY_DESCRIPTOR)}
				</MenuItem>
			)}
			<MenuItem
				icon={<StopCircleIcon size={remFromPx(16)} weight="fill" data-flx="activities.activity-menu.end-icon" />}
				danger
				disabled={!live || VoiceActivities.request === 'end'}
				onClick={() => void live?.end()}
				data-flx="activities.activity-menu.end"
			>
				{i18n._(END_ACTIVITY_DESCRIPTOR)}
			</MenuItem>
		</MenuGroup>
	);
});

export function openActivityMenu(event: React.MouseEvent<HTMLElement>, channelId: string): void {
	const open =
		event.type === 'contextmenu' ? ContextMenuCommands.openFromEvent : ContextMenuCommands.openFromElementBottomRight;
	open(event, () => <ActivityMenu channelId={channelId} data-flx="activities.activity-menu.open.activity-menu" />);
}

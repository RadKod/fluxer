// SPDX-License-Identifier: AGPL-3.0-or-later

import {showVoiceMemberModerationFailedModal} from '@app/features/app/components/alerts/VoiceMemberModerationFailedModal';
import type {DragItem} from '@app/features/app/components/layout/types/DndTypes';
import * as GuildMemberCommands from '@app/features/member/commands/GuildMemberCommands';
import Permission from '@app/features/permissions/state/Permission';
import Users from '@app/features/user/state/Users';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {msg} from '@lingui/core/macro';

const MOVE_TO_DESCRIPTOR = msg({
	message: 'Move to…',
	comment: 'Submenu label that moves the selected participant or content into another channel.',
});

export function moveVoiceParticipantToChannel(item: DragItem, guildId: string, channelId: string): void {
	if (item.currentChannelId === channelId) return;
	const currentUserId = Users.getCurrentUser()?.id ?? null;
	if (currentUserId && item.userId === currentUserId) {
		if (Permission.can(Permissions.CONNECT, {guildId, channelId})) {
			void MediaEngine.connectToVoiceChannel(guildId, channelId);
		}
		return;
	}
	if (!Permission.can(Permissions.MOVE_MEMBERS, {guildId, channelId})) return;
	GuildMemberCommands.update(guildId, item.userId!, {channel_id: channelId}).catch((error) =>
		showVoiceMemberModerationFailedModal(error, MOVE_TO_DESCRIPTOR),
	);
}

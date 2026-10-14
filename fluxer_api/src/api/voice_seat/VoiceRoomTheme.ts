// SPDX-License-Identifier: AGPL-3.0-or-later

import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {isVoiceRoomTheme, type VoiceRoomTheme} from '@fluxer/constants/src/VoiceRoomThemes';
import type {VoiceRoomConfig} from '@fluxer/schema/src/domains/admin/VoiceRoomConfigSchemas';

export function resolveEffectiveVoiceRoomTheme(
	roomTheme: string | null | undefined,
	config: Pick<VoiceRoomConfig, 'default_room_theme'>,
	channelType: number,
): VoiceRoomTheme | null {
	const theme = roomTheme ?? (channelType === ChannelTypes.GUILD_VOICE ? config.default_room_theme : null);
	return isVoiceRoomTheme(theme) ? theme : null;
}

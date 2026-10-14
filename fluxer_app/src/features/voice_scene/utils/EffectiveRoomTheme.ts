// SPDX-License-Identifier: AGPL-3.0-or-later

import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {isVoiceRoomTheme, type VoiceRoomTheme} from '@fluxer/constants/src/VoiceRoomThemes';

// Null/absent guild voice overrides inherit; explicit 'none' remains flat, including on older clients.
export function effectiveRoomTheme(
	channelTheme: string | null | undefined,
	defaultTheme: string | null | undefined,
	channelType: number,
): VoiceRoomTheme | null {
	const theme = channelTheme ?? (channelType === ChannelTypes.GUILD_VOICE ? defaultTheme : null);
	return isVoiceRoomTheme(theme) ? theme : null;
}

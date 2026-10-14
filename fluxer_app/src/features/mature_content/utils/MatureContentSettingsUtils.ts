// SPDX-License-Identifier: AGPL-3.0-or-later

import {LimitResolver} from '@app/features/app/utils/LimitResolverAdapter';
import type {Channel} from '@app/features/channel/models/Channel';
import type {Guild} from '@app/features/guild/models/Guild';
import {
	getEffectiveChannelContentWarning,
	getEffectiveChannelMatureContent,
} from '@app/features/messaging/utils/ContentWarningUtils';
import {ContentWarningLevel} from '@fluxer/constants/src/GuildConstants';

// Off: no mature content or content warning settings are offered. Stored values, age gates and media filters still apply.
function isMatureContentSettingsEnabled(): boolean {
	return LimitResolver.resolve({key: 'feature_mature_content_settings', fallback: 0}) > 0;
}

// A channel that has one of these settings, or inherits one, keeps them visible so a moderator can still change it.
export function shouldShowChannelMatureContentSettings(channel: Channel, guild: Guild | null | undefined): boolean {
	return (
		isMatureContentSettingsEnabled() ||
		channel.nsfwOverride !== null ||
		getEffectiveChannelMatureContent(channel, guild) ||
		getEffectiveChannelContentWarning(channel, guild).level !== ContentWarningLevel.INHERIT
	);
}

export function shouldShowGuildMatureContentSettings(guild: Guild): boolean {
	return isMatureContentSettingsEnabled() || guild.nsfw || guild.contentWarningLevel !== ContentWarningLevel.INHERIT;
}

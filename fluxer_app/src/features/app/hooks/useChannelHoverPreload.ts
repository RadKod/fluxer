// SPDX-License-Identifier: AGPL-3.0-or-later

import {useHoverPreload} from '@app/features/app/hooks/useHoverPreload';
import type {Channel} from '@app/features/channel/models/Channel';
import GatewaySessions from '@app/features/gateway/transport/GatewaySessionPool';
import type {Guild} from '@app/features/guild/models/Guild';
import {ensureMembersForMessages} from '@app/features/messaging/commands/MessageCommands';
import Messages from '@app/features/messaging/state/MessagingMessages';
import ThreadGuilds from '@app/features/threads/state/ThreadGuilds';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {useCallback} from 'react';

const CHANNEL_HOVER_PRELOAD_DELAY_MS = 220;

interface UseChannelHoverPreloadOptions {
	channel: Channel | null | undefined;
	guild?: Guild | null;
	defaultHiddenForChannel?: boolean;
	enabled?: boolean;
	preloadMemberList?: boolean;
}

function ensureMembersForCachedChannelMessages(channelId: string): void {
	const messages = Messages.getCachedMessages(channelId);
	if (!messages || messages.length === 0) {
		return;
	}
	void ensureMembersForMessages(messages.toArray());
}

export function useChannelHoverPreload({channel, guild = null, enabled = true}: UseChannelHoverPreloadOptions): {
	scheduleChannelPreload: () => void;
	cancelChannelPreload: () => void;
	preloadChannelNow: () => void;
} {
	const preload = useCallback(() => {
		if (
			!enabled ||
			!GatewaySessions.foregroundConnection.isConnected ||
			!channel ||
			channel.type === ChannelTypes.GUILD_CATEGORY ||
			channel.type === ChannelTypes.GUILD_LINK
		) {
			return;
		}
		if (channel.isThreadOnly() || (channel.isThread() && !ThreadGuilds.isActive(channel.guildId))) {
			return;
		}
		if (!Messages.preloadLatestPage(channel.id, guild?.id ?? channel.guildId ?? null)) {
			ensureMembersForCachedChannelMessages(channel.id);
		}
	}, [channel, enabled, guild]);
	const {schedule, cancel, preloadNow} = useHoverPreload(
		'channel',
		preload,
		CHANNEL_HOVER_PRELOAD_DELAY_MS,
		enabled && channel != null,
	);
	return {scheduleChannelPreload: schedule, cancelChannelPreload: cancel, preloadChannelNow: preloadNow};
}

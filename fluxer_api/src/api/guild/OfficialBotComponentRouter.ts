// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, GuildID} from '@app/api/BrandedTypes';
import type {AuthenticatedChannel} from '@app/api/channel/services/AuthenticatedChannel';
import type {ChannelService} from '@app/api/channel/services/ChannelService';
import type {ThreadViewer} from '@app/api/experiment/ChannelThreadsGate';
import {isGuildRosterLive, rosterBotUserId} from '@app/api/guild/roster/GuildRosterBot';
import {handleGuildRosterComponent} from '@app/api/guild/roster/GuildRosterComponents';
import type {RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {getLimitConfigService} from '@app/api/middleware/ServiceSingletons';
import type {Message} from '@app/api/models/Message';
import type {User} from '@app/api/models/User';
import type {MessageComponentReplyCode} from '@fluxer/constants/src/MessageComponentConstants';
import type {GuildMemberResponse} from '@fluxer/schema/src/domains/guild/GuildMemberSchemas';

export interface OfficialBotComponentClick {
	viewer: ThreadViewer;
	user: User;
	guildId: GuildID;
	channelId: ChannelID;
	message: Message;
	customId: string;
	member: GuildMemberResponse;
	authChannel: AuthenticatedChannel;
	channelService: ChannelService;
	requestCache: RequestCache;
	atMs: number;
}

export type OfficialBotComponentReply = {code: MessageComponentReplyCode; channel_id?: string | null};

// The message author picks the bot, the custom_id prefix must belong to that bot and a bot whose feature flag is 0
// handles nothing. MicupBOT writes no buttons yet (a later step), so its messages route nowhere.
export async function routeOfficialBotComponent(click: OfficialBotComponentClick): Promise<OfficialBotComponentReply> {
	const authorId = click.message.authorId;
	if (
		authorId !== null &&
		authorId === rosterBotUserId() &&
		click.customId.startsWith('roster:') &&
		isGuildRosterLive(getLimitConfigService())
	)
		return handleGuildRosterComponent(click);
	return {code: 'component_unavailable'};
}

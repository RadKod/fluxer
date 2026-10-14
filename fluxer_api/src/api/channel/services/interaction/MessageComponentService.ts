// SPDX-License-Identifier: AGPL-3.0-or-later

import {requireEmailVerified} from '@app/api/auth/EmailVerificationUtils';
import type {ChannelID, MessageID} from '@app/api/BrandedTypes';
import type {IChannelRepositoryAggregate} from '@app/api/channel/repositories/IChannelRepositoryAggregate';
import type {ChannelService} from '@app/api/channel/services/ChannelService';
import {MessageInteractionBase} from '@app/api/channel/services/interaction/MessageInteractionBase';
import {findClickableButton} from '@app/api/channel/services/message/MessageComponentRules';
import {assertThreadInteractionAllowed} from '@app/api/channel/services/thread/ThreadInteractionGuards';
import type {ThreadViewer} from '@app/api/experiment/ChannelThreadsGate';
import {routeOfficialBotComponent} from '@app/api/guild/OfficialBotComponentRouter';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import type {User} from '@app/api/models/User';
import {assertAccountNotLimited} from '@app/api/user/AccountLimit';
import {assertGuildMemberCanCommunicate} from '@app/api/utils/GuildCommunicationUtils';
import {UnknownMessageError} from '@fluxer/errors/src/domains/channel/UnknownMessageError';
import type {MessageComponentClickResponse} from '@fluxer/schema/src/domains/message/MessageComponentSchemas';

export interface MessageComponentServiceDeps {
	channelRepository: IChannelRepositoryAggregate;
	channelService: ChannelService;
}

// A click needs what adding a reaction needs (view, history, not timed out, verified email), except the community's
// REACTIONS switch: the bots have their own feature flags. The handler writes before the reply; nothing is deferred.
export class MessageComponentService extends MessageInteractionBase {
	constructor(
		gatewayService: IGatewayService,
		protected readonly deps: MessageComponentServiceDeps,
	) {
		super(gatewayService);
	}

	async click({
		user,
		viewer,
		channelId,
		messageId,
		customId,
		requestCache,
	}: {
		user: User;
		viewer: ThreadViewer;
		channelId: ChannelID;
		messageId: MessageID;
		customId: string;
		requestCache: RequestCache;
	}): Promise<MessageComponentClickResponse> {
		const authChannel = await this.deps.channelService.interactions.authService.getChannelAuthenticated({
			userId: user.id,
			viewer,
			channelId,
		});
		const {channel, member} = authChannel;
		if (!channel.guildId || !member) throw new UnknownMessageError();
		this.ensureTextChannel(channel);
		assertThreadInteractionAllowed(authChannel, 'react');
		assertAccountNotLimited(user);
		assertGuildMemberCanCommunicate(member);
		await this.assertMessageHistoryAccess({authChannel, messageId});
		requireEmailVerified(user);
		// TEMPORARY: every click reads the message row from Cassandra. Trigger: click p95 > 300 ms
		// or a messages read p99 > 20 ms. Path: a 30 s cache keyed by message_id + version.
		const message = await this.deps.channelRepository.messages.getMessage(channel.id, messageId);
		if (!message) throw new UnknownMessageError();
		if (!findClickableButton(message, customId)) return {reply: {code: 'component_unavailable', channel_id: null}};
		const reply = await routeOfficialBotComponent({
			viewer,
			user,
			guildId: channel.guildId,
			channelId: channel.id,
			message,
			customId,
			member,
			authChannel,
			channelService: this.deps.channelService,
			requestCache,
			atMs: Date.now(),
		});
		return {reply: {code: reply.code, channel_id: reply.channel_id ?? null}};
	}
}

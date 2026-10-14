// SPDX-License-Identifier: AGPL-3.0-or-later

import type {MessageID} from '@app/api/BrandedTypes';
import type {AuthenticatedChannel} from '@app/api/channel/services/AuthenticatedChannel';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {Channel} from '@app/api/models/Channel';
import {Permissions, TEXT_BASED_CHANNEL_TYPES} from '@fluxer/constants/src/ChannelConstants';
import {THREAD_CHANNEL_TYPES} from '@fluxer/constants/src/ThreadConstants';
import {CannotSendMessageToNonTextChannelError} from '@fluxer/errors/src/domains/channel/CannotSendMessageToNonTextChannelError';
import {UnknownMessageError} from '@fluxer/errors/src/domains/channel/UnknownMessageError';
import type {GuildResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';
import {snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';

export interface ParsedEmoji {
	id?: string;
	name: string;
	animated?: boolean;
}

export abstract class MessageInteractionBase {
	constructor(protected gatewayService: IGatewayService) {}

	protected isOperationDisabled(guild: GuildResponse | null, operation: number): boolean {
		if (!guild) return false;
		return (guild.disabled_operations & operation) !== 0;
	}

	protected ensureTextChannel(channel: Channel): void {
		if (!TEXT_BASED_CHANNEL_TYPES.has(channel.type) && !THREAD_CHANNEL_TYPES.has(channel.type)) {
			throw new CannotSendMessageToNonTextChannelError();
		}
	}

	protected async assertMessageHistoryAccess({
		authChannel,
		messageId,
	}: {
		authChannel: AuthenticatedChannel;
		messageId: MessageID;
	}): Promise<void> {
		const {guild, hasPermission} = authChannel;
		if (!guild) {
			return;
		}
		if (await hasPermission(Permissions.READ_MESSAGE_HISTORY)) {
			return;
		}
		const cutoff = guild.message_history_cutoff;
		if (!cutoff || snowflakeToDate(messageId).getTime() < new Date(cutoff).getTime()) {
			throw new UnknownMessageError();
		}
	}
}

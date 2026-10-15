// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import type {ChannelID, GuildSoundID, UserID} from '@app/api/BrandedTypes';
import type {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {checkGuildSoundboardPlayRateLimit} from '@app/api/guild/soundboard/GuildSoundboardPlayRateLimit';
import type {GuildSoundboardRepository} from '@app/api/guild/soundboard/GuildSoundboardRepository';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import {requirePermission} from '@app/api/utils/PermissionUtils';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import {RateLimitError} from '@fluxer/errors/src/domains/core/RateLimitError';
import type {IRateLimitService} from '@pkgs/rate_limit/src/IRateLimitService';

export class GuildSoundboardPlayService {
	constructor(
		private readonly repository: GuildSoundboardRepository,
		private readonly gateway: IGatewayService,
		// Only the channel lookup is needed; production passes ChannelRepository.channelData.
		private readonly channels: Pick<ChannelRepository['channelData'], 'findUnique'>,
		private readonly limiter: IRateLimitService,
	) {}

	async play(params: {
		userId: UserID;
		channelId: ChannelID;
		soundId: GuildSoundID;
		sessionId: string;
		connectionId: string;
	}): Promise<void> {
		const channel = await this.channels.findUnique(params.channelId);
		if (!channel?.guildId) throw InputValidationError.create('channel_id', 'A guild voice channel is required');
		const sound = await this.repository.getSound(channel.guildId, params.soundId);
		if (!sound) throw InputValidationError.create('sound_id', 'Unknown guild sound');
		await requirePermission(this.gateway, {
			guildId: channel.guildId,
			channelId: params.channelId,
			userId: params.userId,
			permission: Permissions.VIEW_CHANNEL | Permissions.CONNECT | Permissions.SPEAK,
		});
		const rate = await checkGuildSoundboardPlayRateLimit(this.limiter, params.userId, params.channelId);
		if (!rate.allowed) throw new RateLimitError({retryAfter: 3, limit: 2, resetTime: new Date(Date.now() + 3000)});
		const result = await this.gateway.playGuildSoundboardSound({
			guild_id: channel.guildId.toString(),
			channel_id: params.channelId.toString(),
			user_id: params.userId.toString(),
			sound_id: sound.soundId.toString(),
			session_id: params.sessionId,
			connection_id: params.connectionId,
			event_id: randomUUID(),
			asset_version: sound.assetHash,
			volume: sound.volume,
		});
		if (!result.success) {
			if (result.error === 'rate_limited')
				throw new RateLimitError({retryAfter: 3, limit: 2, resetTime: new Date(Date.now() + 3000)});
			throw new MissingPermissionsError();
		}
	}
}

// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, UserID} from '@app/api/BrandedTypes';
import {
	SOUNDBOARD_CHANNEL_PLAY_BUCKET,
	SOUNDBOARD_USER_PLAY_BUCKET,
} from '@app/api/rate_limit_configs/GuildSoundboardRateLimitConfig';
import type {IRateLimitService} from '@pkgs/rate_limit/src/IRateLimitService';

export async function checkGuildSoundboardPlayRateLimit(
	limiter: IRateLimitService,
	userId: UserID,
	channelId: ChannelID,
): Promise<{allowed: boolean}> {
	const user = await limiter.checkBucketLimit(`soundboard:play:user:${userId}`, SOUNDBOARD_USER_PLAY_BUCKET);
	if (!user.allowed) return {allowed: false};
	const channel = await limiter.checkBucketLimit(
		`soundboard:play:channel:${channelId}`,
		SOUNDBOARD_CHANNEL_PLAY_BUCKET,
	);
	return {allowed: channel.allowed};
}

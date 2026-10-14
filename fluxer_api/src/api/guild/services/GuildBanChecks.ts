// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID, UserID} from '@app/api/BrandedTypes';
import {shouldEnforceGuildIpBan} from '@app/api/ban/IpBanCgnatGuard';
import type {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import {BannedFromGuildError} from '@fluxer/errors/src/domains/guild/BannedFromGuildError';
import {IpBannedFromGuildError} from '@fluxer/errors/src/domains/guild/IpBannedFromGuildError';
import {isSameIpDecisionMatch} from '@fluxer/ip_utils/src/IpAddress';
import type {IpInfoService} from '@pkgs/geoip/src/IpInfoService';

export async function assertNotBannedFromGuild(
	guildRepository: GuildRepository,
	userRepository: UserRepository,
	ipInfoService: IpInfoService,
	params: {userId: UserID; guildId: GuildID},
): Promise<void> {
	const {userId, guildId} = params;
	const [bans, user] = await Promise.all([guildRepository.listBans(guildId), userRepository.findUnique(userId)]);
	const userIp = user?.lastActiveIp;
	const userEmail = user?.email?.toLowerCase();
	// Micup: one CGNAT/shared-access verdict per check, so a carrier IP ban does not lock out every user behind it.
	let enforceIpBan: boolean | undefined;
	for (const ban of bans) {
		if (ban.userId === userId) throw new BannedFromGuildError();
		if (isSameIpDecisionMatch(userIp, ban.ipAddress)) {
			enforceIpBan ??= await shouldEnforceGuildIpBan(userIp, ban.ipAddress, ipInfoService);
			if (enforceIpBan) throw new IpBannedFromGuildError();
		}
	}
	if (userEmail) {
		const emailBan = await guildRepository.getBanByEmail(guildId, userEmail);
		if (emailBan) throw new BannedFromGuildError();
	}
}

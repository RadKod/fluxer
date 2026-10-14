// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createUserID} from '@app/api/BrandedTypes';
import {isHighCgnatBlastRadiusRisk, isHighSharedAccessBlastRadiusRisk} from '@app/api/ban/IpBanCgnatGuard';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import type {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import {GuildModerationService} from '@app/api/guild/services/GuildModerationService';
import {GuildMemberValidationService} from '@app/api/guild/services/member/GuildMemberValidationService';
import {GuildBan} from '@app/api/models/GuildBan';
import {User} from '@app/api/models/User';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import {BannedFromGuildError} from '@fluxer/errors/src/domains/guild/BannedFromGuildError';
import {createUnavailableIpInfoService} from '@pkgs/geoip/src/IpInfoService';
import {expect, test, vi} from 'vitest';

test.each(['moderation', 'membership'])(
	'reuses one verdict in %s while retaining direct account bans',
	async (kind) => {
		const guildId = createGuildID(100n);
		const userId = createUserID(3n);
		const ip = '2a01:e0a:d10:5555::3';
		const empty = await createUnavailableIpInfoService().lookup(ip);
		const lookup = vi.fn().mockResolvedValue({...empty, available: true, flags: {...empty.flags, isMobile: true}});
		const bans = [1n, 2n].map(
			(id) =>
				new GuildBan({
					guild_id: guildId,
					user_id: createUserID(id),
					moderator_id: createUserID(4n),
					banned_at: new Date(),
					expires_at: null,
					reason: null,
					ip: `2a01:e0a:d10:5555::${id}`,
					email: null,
				}),
		);
		const guildRepository = {
			listBans: vi.fn().mockResolvedValue(bans),
			getBanByEmail: vi.fn().mockResolvedValue(null),
		} as unknown as GuildRepository;
		const userRepository = {
			findUnique: vi.fn().mockResolvedValue(new User({...EMPTY_USER_ROW, user_id: userId, last_active_ip: ip})),
		} as unknown as UserRepository;
		const service =
			kind === 'membership'
				? new GuildMemberValidationService(guildRepository, userRepository, {lookup})
				: new GuildModerationService(
						guildRepository,
						userRepository,
						{} as never,
						{} as never,
						{} as never,
						{} as never,
						{lookup},
					);
		await service.checkUserBanStatus({userId, guildId});
		expect(lookup).toHaveBeenCalledTimes(1);
		bans.push(
			new GuildBan({
				guild_id: guildId,
				user_id: userId,
				moderator_id: createUserID(4n),
				banned_at: new Date(),
				expires_at: null,
				reason: null,
				ip,
				email: null,
			}),
		);
		await expect(service.checkUserBanStatus({userId, guildId})).rejects.toBeInstanceOf(BannedFromGuildError);
	},
);

test('retains carrier/shared-access exceptions without exempting hosting or anonymous access', async () => {
	const empty = await createUnavailableIpInfoService().lookup('203.0.113.9');
	const mobile = {...empty, available: true, flags: {...empty.flags, isMobile: true}};
	const education = {...empty, available: true, asn: {...empty.asn, type: 'education'}};
	expect(isHighCgnatBlastRadiusRisk(mobile)).toBe(true);
	expect(isHighSharedAccessBlastRadiusRisk(education)).toBe(true);
	expect(isHighCgnatBlastRadiusRisk({...mobile, available: false})).toBe(false);
	for (const result of [mobile, education]) {
		const hosting = {...result, flags: {...result.flags, isHosting: true}};
		const anonymous = {...result, anonymous: {...result.anonymous, isResidentialProxy: true}};
		expect(isHighCgnatBlastRadiusRisk(hosting)).toBe(false);
		expect(isHighSharedAccessBlastRadiusRisk(hosting)).toBe(false);
		expect(isHighCgnatBlastRadiusRisk(anonymous)).toBe(false);
		expect(isHighSharedAccessBlastRadiusRisk(anonymous)).toBe(false);
	}
});

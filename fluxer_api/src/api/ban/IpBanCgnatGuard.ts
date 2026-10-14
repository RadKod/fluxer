// SPDX-License-Identifier: AGPL-3.0-or-later

import {isIpBanExempt} from '@app/api/ban/IpBanExemptions';
import {Logger} from '@app/api/Logger';
import {parseIpBanEntry} from '@app/api/utils/IpRangeUtils';
import type {IpInfoLookupResult, IpInfoService} from '@pkgs/geoip/src/IpInfoService';

function isAnonymousAccess(result: IpInfoLookupResult): boolean {
	const anonymous = result.anonymous;
	return (
		anonymous.isAnonymous ||
		anonymous.isVpn ||
		anonymous.isProxy ||
		anonymous.isResidentialProxy ||
		anonymous.isTor ||
		anonymous.isRelay
	);
}

export function isHighCgnatBlastRadiusRisk(result: IpInfoLookupResult): boolean {
	if (!result.available || result.flags.isHosting || isAnonymousAccess(result)) return false;
	return result.flags.isMobile || result.mobile.name !== null || result.asn.type?.trim().toLowerCase() === 'mobile';
}

export function isHighSharedAccessBlastRadiusRisk(result: IpInfoLookupResult): boolean {
	if (result.flags.isHosting || isAnonymousAccess(result)) return false;
	return result.flags.isAnycast || result.flags.isSatellite || result.asn.type?.trim().toLowerCase() === 'education';
}

export async function shouldEnforceGuildIpBan(
	userIp: string | null | undefined,
	bannedIp: string | null | undefined,
	ipInfoService: IpInfoService,
): Promise<boolean> {
	if (isIpBanExempt(userIp)) return false;
	if (!userIp || !bannedIp || parseIpBanEntry(bannedIp)?.type !== 'single') return true;
	try {
		const result = await ipInfoService.lookup(userIp, {source: 'guild.ip_ban', reason: 'join_cgnat_guard'});
		return !isHighCgnatBlastRadiusRisk(result) && !isHighSharedAccessBlastRadiusRisk(result);
	} catch (error) {
		Logger.warn({error, userIp, bannedIp}, 'IPInfo blast-radius guard failed while checking guild IP ban');
		return true;
	}
}

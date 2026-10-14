// SPDX-License-Identifier: AGPL-3.0-or-later

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';

export function buildBotInviteUrl({
	applicationId,
	guildId,
	permissions,
}: {
	applicationId: string;
	guildId?: string;
	permissions: string;
}): string {
	const origin =
		typeof location !== 'undefined' && /^https?:$/.test(location.protocol)
			? location.origin
			: RuntimeConfig.webAppBaseUrl;
	const url = new URL('/oauth2/authorize', origin);
	url.search = new URLSearchParams({
		client_id: applicationId,
		scope: 'bot',
		permissions,
		...(guildId ? {guild_id: guildId, disable_guild_select: 'true'} : {}),
	}).toString();
	return url.toString();
}

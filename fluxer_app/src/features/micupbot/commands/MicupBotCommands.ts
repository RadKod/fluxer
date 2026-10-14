// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {http} from '@app/features/platform/transport/RestTransport';
import type * as Request from '@fluxer/schema/src/domains/micupbot/MicupBotRequestSchemas';
import type * as Response from '@fluxer/schema/src/domains/micupbot/MicupBotResponseSchemas';
import type {ApplicationPublicResponse} from '@fluxer/schema/src/domains/oauth/OAuthSchemas';

export async function fetchSettings(guildId: string) {
	return (await http.get<Response.MicupBotSettingsResponse>(Endpoints.GUILD_MICUPBOT_SETTINGS(guildId))).body;
}
export async function fetchAutomod(guildId: string) {
	return (await http.get<Response.MicupBotAutomodResponse>(Endpoints.GUILD_MICUPBOT_AUTOMOD(guildId))).body;
}
export async function fetchPanels(guildId: string) {
	return (
		await http.get<Response.MicupBotReactionRolePanelListResponse>(Endpoints.GUILD_MICUPBOT_REACTION_ROLES(guildId))
	).body;
}
export async function fetchRewards(guildId: string) {
	return (await http.get<Response.MicupBotLevelRewardsResponse>(Endpoints.GUILD_MICUPBOT_LEVEL_REWARDS(guildId))).body;
}
export async function fetchLeaderboard(guildId: string) {
	return (
		await http.get<Response.MicupBotLeaderboardResponse>(Endpoints.GUILD_MICUPBOT_LEADERBOARD(guildId), {
			query: {limit: 10},
		})
	).body;
}
export async function fetchApplication(applicationId: string) {
	return (await http.get<ApplicationPublicResponse>(Endpoints.OAUTH_PUBLIC_APPLICATION(applicationId))).body;
}
export async function updateSettings(guildId: string, data: (typeof Request.MicupBotSettingsUpdateRequest)['_input']) {
	return (await http.patch<Response.MicupBotSettingsResponse>(Endpoints.GUILD_MICUPBOT_SETTINGS(guildId), {body: data}))
		.body;
}
export async function updateAutomod(guildId: string, data: (typeof Request.MicupBotAutomodUpdateRequest)['_input']) {
	return (await http.put<Response.MicupBotAutomodResponse>(Endpoints.GUILD_MICUPBOT_AUTOMOD(guildId), {body: data}))
		.body;
}
export async function createPanel(
	guildId: string,
	data: (typeof Request.MicupBotReactionRolePanelCreateRequest)['_input'],
) {
	return (
		await http.post<Response.MicupBotReactionRolePanelResponse>(Endpoints.GUILD_MICUPBOT_REACTION_ROLES(guildId), {
			body: data,
		})
	).body;
}
export async function deletePanel(guildId: string, messageId: string): Promise<void> {
	await http.delete(Endpoints.GUILD_MICUPBOT_REACTION_ROLE(guildId, messageId));
}
export async function updateRewards(
	guildId: string,
	data: (typeof Request.MicupBotLevelRewardsUpdateRequest)['_input'],
) {
	return (
		await http.put<Response.MicupBotLevelRewardsResponse>(Endpoints.GUILD_MICUPBOT_LEVEL_REWARDS(guildId), {body: data})
	).body;
}
export async function fetchWarnings(guildId: string, userId: string) {
	return (await http.get<Response.MicupBotWarningListResponse>(Endpoints.GUILD_MICUPBOT_WARNINGS(guildId, userId)))
		.body;
}
export async function deleteWarning(guildId: string, userId: string, warningId: string): Promise<void> {
	await http.delete(Endpoints.GUILD_MICUPBOT_WARNING(guildId, userId, warningId));
}
export async function clearWarnings(guildId: string, userId: string): Promise<void> {
	await http.delete(Endpoints.GUILD_MICUPBOT_WARNINGS(guildId, userId));
}

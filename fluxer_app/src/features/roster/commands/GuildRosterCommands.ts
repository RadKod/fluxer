// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {http} from '@app/features/platform/transport/RestTransport';
import type {
	GuildRosterEventCreateRequest,
	GuildRosterEventUpdateRequest,
} from '@fluxer/schema/src/domains/roster/GuildRosterRequestSchemas';
import type {
	GuildRosterEventListResponse,
	GuildRosterEventResponse,
} from '@fluxer/schema/src/domains/roster/GuildRosterResponseSchemas';

export async function fetchGuildRosterEvents(guildId: string): Promise<GuildRosterEventListResponse> {
	return (await http.get<GuildRosterEventListResponse>(Endpoints.GUILD_ROSTER_EVENTS(guildId))).body;
}

export async function createGuildRosterEvent(
	guildId: string,
	data: (typeof GuildRosterEventCreateRequest)['_input'],
): Promise<GuildRosterEventResponse> {
	return (await http.post<GuildRosterEventResponse>(Endpoints.GUILD_ROSTER_EVENTS(guildId), {body: data})).body;
}

export async function updateGuildRosterEvent(
	guildId: string,
	eventId: string,
	data: (typeof GuildRosterEventUpdateRequest)['_input'],
): Promise<GuildRosterEventResponse> {
	return (await http.patch<GuildRosterEventResponse>(Endpoints.GUILD_ROSTER_EVENT(guildId, eventId), {body: data}))
		.body;
}

export async function deleteGuildRosterEvent(guildId: string, eventId: string): Promise<void> {
	await http.delete(Endpoints.GUILD_ROSTER_EVENT(guildId, eventId));
}

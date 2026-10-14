// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createChannelID, createGuildID, createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import type {GuildRosterEventRow} from '@app/api/database/types/GuildRosterTypes';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {GuildRosterRepository} from '@app/api/guild/roster/GuildRosterRepository';
import {createChannel, createGuild} from '@app/api/guild/tests/GuildTestUtils';
import {getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import type {GuildRosterEventResponse} from '@fluxer/schema/src/domains/roster/GuildRosterResponseSchemas';

export async function createRosterSettingsFixture(harness: ApiTestHarness) {
	Config.instance.rosterBotApplicationId = '1490000000000000001';
	overrideLimits({feature_guild_roster: 1});
	const owner = await createTestAccount(harness);
	const guild = await createGuild(harness, owner.token, 'Roster settings');
	const voice = await createChannel(harness, owner.token, guild.id, 'Event room', ChannelTypes.GUILD_VOICE);
	const guildId = createGuildID(BigInt(guild.id));
	const base = `/guilds/${guild.id}/roster-events`;
	const data = {name: 'Raid', voice_channel_id: voice.id, announce_channel_id: guild.system_channel_id!};
	const repository = new GuildRosterRepository();
	return {
		owner,
		guild,
		guildId,
		voice,
		base,
		data,
		repository,
		create: (body: object = data, token = owner.token) =>
			createBuilder<GuildRosterEventResponse>(harness, token).post(base).body(body),
		async seed(overrides: Partial<GuildRosterEventRow> = {}): Promise<GuildRosterEventRow> {
			const now = new Date();
			const row: GuildRosterEventRow = {
				guild_id: guildId,
				event_id: await getSnowflakeService().generate(),
				name: data.name,
				voice_channel_id: createChannelID(BigInt(voice.id)),
				announce_channel_id: createChannelID(BigInt(data.announce_channel_id)),
				mention_role_id: null,
				main_size: 10,
				sub_size: 5,
				enabled: true,
				created_by: createUserID(BigInt(owner.userId)),
				created_at: now,
				updated_at: now,
				version: 0,
				...overrides,
			};
			await repository.create(row);
			return row;
		},
	};
}

export type RosterSettingsFixture = Awaited<ReturnType<typeof createRosterSettingsFixture>>;

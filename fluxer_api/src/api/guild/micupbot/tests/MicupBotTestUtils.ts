// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createChannelID, createGuildID, createMessageID, createUserID} from '@app/api/BrandedTypes';
import {authorizeBot} from '@app/api/bot/tests/BotTestUtils';
import {Config} from '@app/api/Config';
import type {MicupBotGuildSettingsRow} from '@app/api/database/types/MicupBotTypes';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {MICUPBOT_BOT_INVITE_PERMISSIONS} from '@app/api/guild/micupbot/MicupBotConstants';
import {
	acceptInvite,
	addMemberRole,
	createChannelInvite,
	createGuild,
	createRole,
	getMember,
	updateRolePositions,
} from '@app/api/guild/tests/GuildTestUtils';
import {getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {getMicupBotRepository} from '@app/api/middleware/ServiceSingletons';
import {createOAuth2Application} from '@app/api/oauth/tests/OAuth2TestUtils';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import type {
	MicupBotReactionRolePanelResponse,
	MicupBotSettingsResponse,
} from '@fluxer/schema/src/domains/micupbot/MicupBotResponseSchemas';

export async function createMicupBotFixture(harness: ApiTestHarness) {
	Config.instance.micupBotApplicationId = '1490000000000000001';
	overrideLimits({feature_micupbot: 1});
	const owner = await createTestAccount(harness);
	const guild = await createGuild(harness, owner.token, 'Community settings');
	const guildId = createGuildID(BigInt(guild.id));
	const channelId = createChannelID(BigInt(guild.system_channel_id!));
	const repository = getMicupBotRepository();
	const base = `/guilds/${guild.id}/micupbot`;
	const role = await createRole(harness, owner.token, guild.id, {name: 'Member colour', permissions: '0'});
	const panel = {
		channel_id: channelId.toString(),
		title: 'Choose a colour',
		description: 'Your choice',
		entries: [{emoji: {name: '🔴'}, role_id: role.id}],
	};
	return {
		owner,
		guild,
		guildId,
		channelId,
		repository,
		base,
		role,
		panel,
		get: () => createBuilder<MicupBotSettingsResponse>(harness, owner.token).get(`${base}/settings`),
		patch: (body: object, token = owner.token) =>
			createBuilder<MicupBotSettingsResponse>(harness, token).patch(`${base}/settings`).body(body),
		createPanel: (body: object = panel, token = owner.token) =>
			createBuilder<MicupBotReactionRolePanelResponse>(harness, token).post(`${base}/reaction-roles`).body(body),
		async member(permissions = 0n) {
			const member = await createTestAccount(harness);
			await acceptInvite(
				harness,
				member.token,
				(await createChannelInvite(harness, owner.token, channelId.toString())).code,
			);
			const memberRole = await createRole(harness, owner.token, guild.id, {
				name: 'Settings manager',
				permissions: permissions.toString(),
			});
			await addMemberRole(harness, owner.token, guild.id, member.userId, memberRole.id);
			await updateRolePositions(harness, owner.token, guild.id, [{id: memberRole.id, position: 5}]);
			return {...member, role: memberRole};
		},
		async addBot() {
			const app = await createOAuth2Application(harness, owner.token, {name: 'Community bot'});
			await authorizeBot(
				harness,
				owner.token,
				app.application.id,
				['bot'],
				guild.id,
				MICUPBOT_BOT_INVITE_PERMISSIONS.toString(),
			);
			const bot = await getMember(harness, owner.token, guild.id, app.botUserId);
			const botRoleId = bot.roles[0]!;
			await updateRolePositions(harness, owner.token, guild.id, [{id: botRoleId, position: 10}]);
			Config.instance.micupBotApplicationId = app.application.id;
			return {...app, botRoleId};
		},
		async seedSettings(overrides: Partial<MicupBotGuildSettingsRow> = {}) {
			const row: MicupBotGuildSettingsRow = {
				guild_id: guildId,
				commands_enabled: false,
				levels_enabled: false,
				automod_enabled: false,
				welcome_enabled: false,
				welcome_channel_id: null,
				welcome_message: null,
				welcome_embed: false,
				goodbye_enabled: false,
				goodbye_channel_id: null,
				goodbye_message: null,
				goodbye_embed: false,
				autorole_ids: null,
				level_up_message_enabled: true,
				level_up_channel_id: null,
				level_up_message: null,
				no_xp_channel_ids: null,
				no_xp_role_ids: null,
				voice_xp_enabled: false,
				updated_by: createUserID(BigInt(owner.userId)),
				updated_at: new Date(),
				version: 0,
				...overrides,
			};
			const current = await repository.getSettings(guildId);
			await repository.putSettings(row, current?.version ?? null);
			return row;
		},
		async seedPanel() {
			const row = {
				guild_id: guildId,
				message_id: createMessageID(await getSnowflakeService().generate()),
				channel_id: channelId,
				mode: 'normal' as const,
				title: panel.title,
				description: panel.description,
				panel_entries: JSON.stringify([{emoji: {name: '🔴', id: null}, role_id: role.id}]),
				created_by: createUserID(BigInt(owner.userId)),
				created_at: new Date(),
			};
			await repository.putPanel(row);
			return row;
		},
		async seedWarning(userId = owner.userId) {
			const row = {
				guild_id: guildId,
				user_id: createUserID(BigInt(userId)),
				warning_id: await getSnowflakeService().generate(),
				moderator_id: createUserID(BigInt(owner.userId)),
				reason: 'Please follow the rules',
				created_at: new Date(),
			};
			await repository.addWarning(row);
			return row;
		},
	};
}
export type MicupBotFixture = Awaited<ReturnType<typeof createMicupBotFixture>>;

export function micupBotRoutes(f: MicupBotFixture) {
	return [
		['get', 'settings'],
		['patch', 'settings', {commands_enabled: false}],
		['get', 'automod'],
		['put', 'automod', {rules: []}],
		['get', 'reaction-roles'],
		['post', 'reaction-roles', f.panel],
		['delete', 'reaction-roles/1490000000000000002'],
		['get', 'level-rewards'],
		['put', 'level-rewards', {rewards: []}],
		['get', 'leaderboard'],
		['get', `warnings/${f.owner.userId}`],
		['delete', `warnings/${f.owner.userId}`],
		['delete', `warnings/${f.owner.userId}/1490000000000000002`],
	] as const;
}

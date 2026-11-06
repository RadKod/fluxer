// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createGuildID} from '@app/api/BrandedTypes';
import {getGuildChannels, getRoles} from '@app/api/guild/tests/GuildTestUtils';
import {getGuildRepository, getLimitConfigService} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {SystemChannelFlags} from '@fluxer/constants/src/GuildConstants';
import {VOICE_CHANNEL_USER_LIMIT_MAX} from '@fluxer/constants/src/LimitConstants';
import {MessageNotifications} from '@fluxer/constants/src/NotificationConstants';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import type {GuildResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';
import {afterAll, beforeAll, beforeEach, describe, expect, test} from 'vitest';

describe('Guild Template Import', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	test('imports @everyone role from template using role name instead of only ID=0', async () => {
		const account = await createTestAccount(harness);
		const guild = await createBuilder<GuildResponse>(harness, account.token)
			.post('/guilds')
			.body({
				name: 'Template Guild',
				template: {
					name: 'Template Source',
					description: null,
					verification_level: 1,
					default_message_notifications: 1,
					explicit_content_filter: 1,
					system_channel_id: 2001,
					afk_timeout: 300,
					system_channel_flags: 0,
					roles: [
						{
							id: 987654321,
							name: '@everyone',
							permissions: Permissions.VIEW_CHANNEL.toString(),
						},
						{
							id: 2222,
							name: 'Moderators',
							permissions: Permissions.MANAGE_MESSAGES.toString(),
							hoist: true,
							mentionable: true,
						},
					],
					channels: [
						{
							id: 2001,
							type: ChannelTypes.GUILD_TEXT,
							name: 'general',
							position: 0,
						},
					],
				},
			})
			.execute();
		const roles = await getRoles(harness, account.token, guild.id);
		const everyoneRole = roles.find((role) => role.id === guild.id);
		const moderatorsRole = roles.find((role) => role.name === 'Moderators');
		expect(everyoneRole).toBeDefined();
		expect(everyoneRole?.name).toBe('@everyone');
		expect(everyoneRole?.position).toBe(0);
		expect(BigInt(everyoneRole?.permissions ?? '0')).toBe(Permissions.VIEW_CHANNEL);
		expect(moderatorsRole).toBeDefined();
		expect(moderatorsRole?.position).toBe(1);
	});
	test('sanitises template-level guild settings during import', async () => {
		const account = await createTestAccount(harness);
		const guild = await createBuilder<GuildResponse>(harness, account.token)
			.post('/guilds')
			.body({
				name: 'Sanitised Guild',
				template: {
					name: 'Template Source',
					description: null,
					verification_level: 999,
					default_message_notifications: 42,
					explicit_content_filter: 42,
					system_channel_id: 3001,
					afk_timeout: 5,
					system_channel_flags: SystemChannelFlags.SUPPRESS_JOIN_NOTIFICATIONS | (1 << 12),
					roles: [
						{
							id: 0,
							name: '@everyone',
							permissions: DEFAULT_EVERYONE_PERMISSIONS,
						},
					],
					channels: [
						{
							id: 3001,
							type: ChannelTypes.GUILD_TEXT,
							name: 'general',
							position: 0,
						},
					],
				},
			})
			.execute();
		expect(guild.verification_level).toBe(3);
		expect(guild.default_message_notifications).toBe(1);
		expect(guild.explicit_content_filter).toBe(2);
		expect(guild.system_channel_flags).toBe(SystemChannelFlags.SUPPRESS_JOIN_NOTIFICATIONS);
		expect(guild.afk_timeout).toBe(60);
	});
	test('imports announcement, stage, forum and media channels and ignores unsupported types', async () => {
		const account = await createTestAccount(harness);
		const guild = await createBuilder<GuildResponse>(harness, account.token)
			.post('/guilds')
			.body({
				name: 'Compatibility Guild',
				template: {
					name: 'Template Source',
					description: null,
					verification_level: 0,
					default_message_notifications: 0,
					explicit_content_filter: 0,
					system_channel_id: '4102',
					afk_timeout: 300,
					system_channel_flags: 0,
					roles: [
						{
							id: '0',
							name: '@everyone',
							permissions: DEFAULT_EVERYONE_PERMISSIONS,
						},
					],
					channels: [
						{
							id: '4101',
							type: ChannelTypes.GUILD_CATEGORY,
							name: 'Main',
							position: 0,
						},
						{
							id: '4102',
							type: ChannelTypes.GUILD_ANNOUNCEMENT,
							name: 'announcements',
							parent_id: '4101',
							position: 1,
						},
						{
							id: '4103',
							type: 13,
							name: 'town-hall',
							parent_id: '4101',
							position: 2,
						},
						{
							id: '4104',
							type: ChannelTypes.GUILD_MEDIA,
							name: 'media-feed',
							parent_id: '4101',
							position: 3,
						},
						{
							id: '4105',
							type: ChannelTypes.GUILD_FORUM,
							name: 'help',
							parent_id: '4101',
							position: 4,
							rate_limit_per_user: 120,
						},
						{
							id: '4106',
							type: 14,
							name: 'directory',
							parent_id: '4101',
							position: 5,
						},
					],
				},
			})
			.execute();
		const channels = await listThreadAwareChannels(account.token, guild.id);
		const categoryChannel = channels.find((channel) => channel.name === 'Main');
		const announcementsChannel = channels.find((channel) => channel.name === 'announcements');
		const stageChannel = channels.find((channel) => channel.name === 'town-hall');
		const mediaChannel = channels.find((channel) => channel.name === 'media-feed');
		expect(categoryChannel).toBeDefined();
		expect(announcementsChannel).toBeDefined();
		expect(announcementsChannel?.type).toBe(ChannelTypes.GUILD_TEXT);
		expect(announcementsChannel?.parent_id).toBe(categoryChannel?.id ?? null);
		expect(stageChannel).toBeDefined();
		expect(stageChannel?.type).toBe(ChannelTypes.GUILD_VOICE);
		expect(stageChannel?.parent_id).toBe(categoryChannel?.id ?? null);
		const forumChannel = channels.find((channel) => channel.name === 'help');
		expect(mediaChannel?.type).toBe(ChannelTypes.GUILD_MEDIA);
		expect(mediaChannel?.parent_id).toBe(categoryChannel?.id ?? null);
		expect(mediaChannel?.position).toBe(3);
		expect(forumChannel?.type).toBe(ChannelTypes.GUILD_FORUM);
		expect(forumChannel?.parent_id).toBe(categoryChannel?.id ?? null);
		expect(forumChannel?.rate_limit_per_user).toBe(120);
		expect(channels.find((channel) => channel.name === 'directory')).toBeUndefined();
		expect(guild.system_channel_id).toBe(announcementsChannel?.id ?? null);
	});
	test.each(['😀', 'not an emoji'])('drops imported role icons on an unboosted guild (%s)', async (unicodeEmoji) => {
		const account = await createTestAccount(harness);
		const guild = await createBuilder<GuildResponse>(harness, account.token)
			.post('/guilds')
			.body({
				name: 'Imported Icons',
				template: buildMinimalTemplate({
					roles: [
						{id: 0, name: '@everyone', permissions: DEFAULT_EVERYONE_PERMISSIONS},
						{id: 6100, name: 'Unicode', permissions: '0', unicode_emoji: unicodeEmoji},
						{id: 6101, name: 'Custom', permissions: '0', icon: 'custom-hash', icon_emoji_id: '123'},
					],
				}),
			})
			.expect(200)
			.execute();
		const roles = await getRoles(harness, account.token, guild.id);
		expect(roles.filter((role) => role.name !== '@everyone')).toHaveLength(2);
		for (const role of roles) {
			expect(role.unicode_emoji).toBeNull();
			expect(role.icon_emoji_id).toBeNull();
		}
		const stored = await getGuildRepository().listRoles(createGuildID(BigInt(guild.id)));
		expect(stored.every((role) => role.iconHash === null)).toBe(true);
	});
	test.each(['😀', 'not an emoji'])(
		'honours an operator role icon grant while dropping invalid emoji (%s)',
		async (unicodeEmoji) => {
			const limits = getLimitConfigService();
			const snapshot = limits.getConfigSnapshot();
			await limits.updateConfig({
				...snapshot,
				rules: [...snapshot.rules, {id: 'operator_role_icons', limits: {feature_role_icons: 1}}],
			});
			try {
				const account = await createTestAccount(harness);
				const guild = await createBuilder<GuildResponse>(harness, account.token)
					.post('/guilds')
					.body({
						name: 'Operator Icons',
						template: buildMinimalTemplate({
							roles: [
								{id: 0, name: '@everyone', permissions: DEFAULT_EVERYONE_PERMISSIONS},
								{id: 6100, name: 'Unicode', permissions: '0', unicode_emoji: unicodeEmoji},
							],
						}),
					})
					.expect(200)
					.execute();
				const role = (await getRoles(harness, account.token, guild.id)).find((role) => role.name === 'Unicode');
				expect(role?.unicode_emoji).toBe(unicodeEmoji === '😀' ? '😀' : null);
				expect(role?.icon_emoji_id).toBeNull();
			} finally {
				await limits.updateConfig(snapshot);
			}
		},
	);
	test('clamps imported voice user limits to the channel maximum and keeps channels readable', async () => {
		const account = await createTestAccount(harness);
		const guild = await createBuilder<GuildResponse>(harness, account.token)
			.post('/guilds')
			.body({
				name: 'Stage Guild',
				template: buildMinimalTemplate({
					channels: [
						{id: 6001, type: ChannelTypes.GUILD_TEXT, name: 'general', position: 0, rate_limit_per_user: 30},
						{id: 6002, type: 13, name: 'town-hall', position: 1, user_limit: 10_000},
						{id: 6003, type: ChannelTypes.GUILD_VOICE, name: 'lounge', position: 2, voice_connection_limit: 100},
					],
				}),
			})
			.execute();
		const channels = await getGuildChannels(harness, account.token, guild.id);
		expect(channels.find((channel) => channel.name === 'general')?.rate_limit_per_user).toBe(30);
		expect(channels.find((channel) => channel.name === 'town-hall')?.user_limit).toBe(VOICE_CHANNEL_USER_LIMIT_MAX);
		expect(channels.find((channel) => channel.name === 'lounge')?.voice_connection_limit).toBe(100);
	});
	test('defaults a community created without a template to mention-only notifications', async () => {
		const account = await createTestAccount(harness);
		const guild = await createBuilder<GuildResponse>(harness, account.token)
			.post('/guilds')
			.body({name: 'Plain Guild'})
			.execute();
		expect(guild.default_message_notifications).toBe(MessageNotifications.ONLY_MENTIONS);
	});
	test('keeps all-messages notifications when the template asks for them', async () => {
		const account = await createTestAccount(harness);
		const guild = await createBuilder<GuildResponse>(harness, account.token)
			.post('/guilds')
			.body({
				name: 'All Messages Guild',
				template: {
					name: 'Template Source',
					description: null,
					verification_level: 0,
					default_message_notifications: MessageNotifications.ALL_MESSAGES,
					explicit_content_filter: 0,
					system_channel_id: 6001,
					afk_timeout: 300,
					system_channel_flags: 0,
					roles: [{id: 0, name: '@everyone', permissions: DEFAULT_EVERYONE_PERMISSIONS}],
					channels: [{id: 6001, type: ChannelTypes.GUILD_TEXT, name: 'general', position: 0}],
				},
			})
			.execute();
		expect(guild.default_message_notifications).toBe(MessageNotifications.ALL_MESSAGES);
	});
	test('accepts channels shaped like a full template export', async () => {
		const account = await createTestAccount(harness);
		const exported = {
			bitrate: 64000,
			user_limit: 0,
			nsfw: false,
			rate_limit_per_user: 0,
			topic: null,
			default_auto_archive_duration: null,
			permission_overwrites: [{id: 0, type: 0, allow: '0', deny: Permissions.SEND_MESSAGES.toString()}],
			available_tags: [],
			template: '',
			default_reaction_emoji: null,
			default_thread_rate_limit_per_user: 0,
			default_sort_order: null,
			default_forum_layout: 0,
			default_tag_setting: null,
			icon_emoji: null,
			theme_color: null,
		};
		const guild = await createBuilder<GuildResponse>(harness, account.token)
			.post('/guilds')
			.body({
				name: 'Exported Guild',
				template: {
					...buildMinimalTemplate({
						channels: [
							{...exported, id: 1, type: ChannelTypes.GUILD_CATEGORY, name: 'Info', position: 0, parent_id: null},
							{...exported, id: 6001, type: ChannelTypes.GUILD_TEXT, name: 'rules', position: 0, parent_id: 1},
							{...exported, id: 3, type: ChannelTypes.GUILD_CATEGORY, name: 'Nested', position: 1, parent_id: 1},
							{
								...exported,
								id: 4,
								type: ChannelTypes.GUILD_FORUM,
								name: 'ideas',
								position: 1,
								parent_id: 1,
								nsfw: null,
							},
						],
					}),
					afk_channel_id: null,
					preferred_locale: 'en-US',
					region: 'us-west',
				},
			})
			.execute();
		const channels = await listThreadAwareChannels(account.token, guild.id);
		const category = channels.find((channel) => channel.name === 'Info');
		const rules = channels.find((channel) => channel.name === 'rules');
		expect(rules?.parent_id).toBe(category?.id ?? null);
		expect(rules?.permission_overwrites?.find((overwrite) => overwrite.id === guild.id)?.deny).toBe(
			Permissions.SEND_MESSAGES.toString(),
		);
		expect(channels.find((channel) => channel.name === 'Nested')?.parent_id ?? null).toBeNull();
		expect(channels.find((channel) => channel.name === 'ideas')?.parent_id).toBe(category?.id ?? null);
		expect(guild.system_channel_id).toBe(rules?.id ?? null);
	});

	function listThreadAwareChannels(token: string, guildId: string): Promise<Array<ChannelResponse>> {
		return createBuilder<Array<ChannelResponse>>(harness, token)
			.get(`/guilds/${guildId}/channels`)
			.header(THREAD_FEATURES_HEADER, THREAD_FEATURES_CAPABLE)
			.execute();
	}
});

const THREAD_FEATURES_HEADER = 'X-Fluxer-Features';
const THREAD_FEATURES_CAPABLE = 'channel_threads';

const DEFAULT_EVERYONE_PERMISSIONS = Permissions.VIEW_CHANNEL.toString();

function buildMinimalTemplate(overrides: {channels?: Array<object>; roles?: Array<object>}) {
	return {
		name: 'Template Source',
		description: null,
		verification_level: 0,
		default_message_notifications: 0,
		explicit_content_filter: 0,
		system_channel_id: 6001,
		afk_timeout: 300,
		system_channel_flags: 0,
		roles: overrides.roles ?? [{id: 0, name: '@everyone', permissions: DEFAULT_EVERYONE_PERMISSIONS}],
		channels: overrides.channels ?? [{id: 6001, type: ChannelTypes.GUILD_TEXT, name: 'general', position: 0}],
	};
}

// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {
	createChannel,
	createGuild,
	getChannel,
	getGuild,
	sendChannelMessage,
} from '@app/api/channel/tests/ChannelTestUtils';
import {readMessageRow} from '@app/api/channel/tests/CrosspostTestUtils';
import {getGuildChannels} from '@app/api/guild/tests/GuildTestUtils';
import {ensureSessionStarted} from '@app/api/message/tests/MessageTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ChannelTypes, CROSSPOST_SERVER_FLAGS, MessageFlags, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import type {GuildResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';
import type {MessageResponse} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {afterAll, beforeAll, beforeEach, describe, expect, test} from 'vitest';

describe('announcement channels are not offered', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	test('refuses to create an announcement channel', async () => {
		const owner = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, 'Closed Announcements');
		await createBuilder(harness, owner.token)
			.post(`/guilds/${guild.id}/channels`)
			.body({name: 'news', type: ChannelTypes.GUILD_ANNOUNCEMENT})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_CHANNEL_TYPE)
			.execute();
		const channels = await getGuildChannels(harness, owner.token, guild.id);
		expect(channels.some((channel) => channel.type === ChannelTypes.GUILD_ANNOUNCEMENT)).toBe(false);
	});

	test('refuses to convert a text channel into an announcement channel', async () => {
		const owner = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, 'Closed Announcements');
		const text = await createChannel(harness, owner.token, guild.id, 'news', ChannelTypes.GUILD_TEXT);
		await createBuilder(harness, owner.token)
			.patch(`/channels/${text.id}`)
			.body({type: ChannelTypes.GUILD_ANNOUNCEMENT})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.CHANNEL_TYPE_CONVERSION_NOT_SUPPORTED)
			.execute();
		expect((await getChannel(harness, owner.token, text.id)).type).toBe(ChannelTypes.GUILD_TEXT);
	});

	test('imports a template announcement channel as a text channel', async () => {
		const owner = await createTestAccount(harness);
		const guild = await createBuilder<GuildResponse>(harness, owner.token)
			.post('/guilds')
			.body({
				name: 'Imported Community',
				template: {
					name: 'Template Source',
					description: null,
					verification_level: 0,
					default_message_notifications: 0,
					explicit_content_filter: 0,
					system_channel_id: '7001',
					afk_timeout: 300,
					system_channel_flags: 0,
					roles: [{id: '0', name: '@everyone', permissions: Permissions.VIEW_CHANNEL.toString()}],
					channels: [{id: '7001', type: ChannelTypes.GUILD_ANNOUNCEMENT, name: 'announcements', position: 0}],
				},
			})
			.execute();
		const channels = await getGuildChannels(harness, owner.token, guild.id);
		const imported = channels.find((channel) => channel.name === 'announcements');
		expect(imported?.type).toBe(ChannelTypes.GUILD_TEXT);
		expect(guild.system_channel_id).toBe(imported?.id ?? null);
	});

	test('answers the follow and publish routes as unknown', async () => {
		const owner = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, 'Closed Announcements');
		const source = await createChannel(harness, owner.token, guild.id, 'news', ChannelTypes.GUILD_TEXT);
		const target = await createChannel(harness, owner.token, guild.id, 'inbox', ChannelTypes.GUILD_TEXT);
		const message = await sendChannelMessage(harness, owner.token, source.id, 'hello');
		await createBuilder(harness, owner.token)
			.post(`/channels/${source.id}/followers`)
			.body({webhook_channel_id: target.id})
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
			.execute();
		await createBuilder(harness, owner.token)
			.get(`/channels/${source.id}/follower-stats`)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
			.execute();
		await createBuilder(harness, owner.token)
			.post(`/channels/${source.id}/messages/${message.id}/crosspost`)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
			.execute();
		await createBuilder(harness, owner.token)
			.get(`/channels/${source.id}/messages/${message.id}/crosspost-source`)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
			.execute();
	});

	test('ignores a body type on voice and category channels', async () => {
		const owner = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, 'Closed Announcements');
		const voice = await createChannel(harness, owner.token, guild.id, 'voice', ChannelTypes.GUILD_VOICE);
		const category = await createChannel(harness, owner.token, guild.id, 'category', ChannelTypes.GUILD_CATEGORY);
		for (const channel of [voice, category]) {
			const updated = await createBuilder<ChannelResponse>(harness, owner.token)
				.patch(`/channels/${channel.id}`)
				.body({type: ChannelTypes.GUILD_ANNOUNCEMENT, name: 'renamed'})
				.expect(HTTP_STATUS.OK)
				.execute();
			expect(updated.type).toBe(channel.type);
			expect(updated.name).toBe('renamed');
			expect((await getChannel(harness, owner.token, channel.id)).type).toBe(channel.type);
		}
	});

	test('refuses to convert a text channel into a voice channel', async () => {
		const owner = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, 'Closed Announcements');
		const text = await createChannel(harness, owner.token, guild.id, 'general', ChannelTypes.GUILD_TEXT);
		await createBuilder(harness, owner.token)
			.patch(`/channels/${text.id}`)
			.body({type: ChannelTypes.GUILD_VOICE})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.CHANNEL_TYPE_CONVERSION_NOT_SUPPORTED)
			.execute();
		expect((await getChannel(harness, owner.token, text.id)).type).toBe(ChannelTypes.GUILD_TEXT);
	});

	test('refuses a voice channel as the system channel', async () => {
		const owner = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, 'Closed Announcements');
		const voice = await createChannel(harness, owner.token, guild.id, 'voice', ChannelTypes.GUILD_VOICE);
		const response = await createBuilder<{errors: Array<{path: string; code: string}>}>(harness, owner.token)
			.patch(`/guilds/${guild.id}`)
			.body({system_channel_id: voice.id})
			.expect(HTTP_STATUS.BAD_REQUEST)
			.execute();
		expect(response.errors[0]?.code).toBe(ValidationErrorCodes.SYSTEM_CHANNEL_MUST_BE_TEXT);
		expect((await getGuild(harness, owner.token, guild.id)).system_channel_id).not.toBe(voice.id);
	});

	test('clients cannot set the server-owned publish flags in a text channel', async () => {
		const owner = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, 'Closed Announcements');
		const text = await createChannel(harness, owner.token, guild.id, 'general', ChannelTypes.GUILD_TEXT);
		await ensureSessionStarted(harness, owner.token);
		const sent = await createBuilder<MessageResponse>(harness, owner.token)
			.post(`/channels/${text.id}/messages`)
			.body({content: 'Flag probe', flags: CROSSPOST_SERVER_FLAGS})
			.expect(HTTP_STATUS.OK)
			.execute();
		expect(sent.flags & CROSSPOST_SERVER_FLAGS).toBe(0);
		expect((await readMessageRow(text.id, sent.id))?.flags).toBe(0);
		const edited = await createBuilder<MessageResponse>(harness, owner.token)
			.patch(`/channels/${text.id}/messages/${sent.id}`)
			.body({flags: CROSSPOST_SERVER_FLAGS | MessageFlags.SUPPRESS_EMBEDS})
			.expect(HTTP_STATUS.OK)
			.execute();
		expect(edited.flags).toBe(MessageFlags.SUPPRESS_EMBEDS);
		expect((await readMessageRow(text.id, sent.id))?.flags).toBe(MessageFlags.SUPPRESS_EMBEDS);
	});
});

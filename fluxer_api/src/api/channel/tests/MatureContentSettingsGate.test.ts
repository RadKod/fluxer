// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {acceptInvite, createChannelInvite} from '@app/api/channel/tests/ChannelTestUtils';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {createGuild, getGuildChannels} from '@app/api/guild/tests/GuildTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {ContentWarningLevel, GuildNSFWLevel} from '@fluxer/constants/src/GuildConstants';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import type {GuildResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const OPENING_CHANNEL_FIELDS: Array<Record<string, unknown>> = [
	{nsfw_override: true},
	{nsfw: true},
	{content_warning_level: ContentWarningLevel.CONTENT_WARNING},
	{content_warning_text: 'Spoilers'},
];

const TEMPLATE_CHANNELS: Array<Record<string, unknown>> = [
	{id: 1, type: ChannelTypes.GUILD_CATEGORY, name: 'Main', position: 0},
	{id: 2, type: ChannelTypes.GUILD_TEXT, name: 'general', parent_id: 1, position: 1},
];

const OPENING_GUILD_FIELDS: Array<Record<string, unknown>> = [
	{nsfw: true},
	{nsfw_level: GuildNSFWLevel.AGE_RESTRICTED},
	{content_warning_level: ContentWarningLevel.CONTENT_WARNING},
	{content_warning_text: 'Spoilers'},
];

describe('mature content settings while feature_mature_content_settings is 0', () => {
	let harness: ApiTestHarness;
	let owner: TestAccount;
	let guild: GuildResponse;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		owner = await createTestAccount(harness);
		guild = await createGuild(harness, owner.token, 'Mature content gate');
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	function createChannel(body: Record<string, unknown>) {
		return createBuilder<ChannelResponse>(harness, owner.token)
			.post(`/guilds/${guild.id}/channels`)
			.body({name: 'room', type: ChannelTypes.GUILD_TEXT, ...body});
	}
	function patchChannel(channelId: string, body: Record<string, unknown>) {
		return createBuilder<ChannelResponse>(harness, owner.token).patch(`/channels/${channelId}`).body(body);
	}
	function patchGuild(body: Record<string, unknown>) {
		return createBuilder<GuildResponse>(harness, owner.token).patch(`/guilds/${guild.id}`).body(body);
	}
	function createGuildFromTemplate(channels: Array<Record<string, unknown>>) {
		return createBuilder<GuildResponse>(harness, owner.token)
			.post('/guilds')
			.body({
				name: 'From template',
				template: {
					name: 'Template Source',
					description: null,
					verification_level: 0,
					default_message_notifications: 0,
					explicit_content_filter: 0,
					system_channel_id: 2,
					afk_timeout: 300,
					system_channel_flags: 0,
					roles: [{id: 0, name: '@everyone', permissions: Permissions.VIEW_CHANNEL.toString()}],
					channels,
				},
			});
	}
	// Writes the stored values the way an instance with the flag on once did, then turns the flag back off.
	async function withStoredValues<T>(write: () => Promise<T>): Promise<T> {
		overrideLimits({feature_mature_content_settings: 1});
		const result = await write();
		vi.restoreAllMocks();
		return result;
	}

	describe('channels', () => {
		it.each(OPENING_CHANNEL_FIELDS)('refuses to create a channel with %o', async (body) => {
			await createChannel(body).expect(403, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED).execute();
		});

		it('creates a channel that leaves every setting off', async () => {
			const channel = await createChannel({
				nsfw: false,
				nsfw_override: false,
				content_warning_level: ContentWarningLevel.INHERIT,
				content_warning_text: '  ',
			}).execute();
			expect(channel.nsfw_override).toBe(false);
			expect(channel.content_warning_level).toBe(ContentWarningLevel.INHERIT);
		});

		it.each(OPENING_CHANNEL_FIELDS)('refuses to turn on %o', async (body) => {
			const channel = await createChannel({}).execute();
			await patchChannel(channel.id, body).expect(403, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED).execute();
			const stored = await createBuilder<ChannelResponse>(harness, owner.token)
				.get(`/channels/${channel.id}`)
				.execute();
			expect(stored.nsfw_override).toBeNull();
			expect(stored.content_warning_level).toBe(ContentWarningLevel.INHERIT);
			expect(stored.content_warning_text).toBeNull();
		});

		it('accepts the stored values sent back unchanged, refuses new warning text and lets every setting be turned off', async () => {
			const stored = {
				nsfw_override: true,
				content_warning_level: ContentWarningLevel.CONTENT_WARNING,
				content_warning_text: 'Spoilers',
			};
			const channel = await withStoredValues(() => createChannel(stored).execute());
			await patchChannel(channel.id, {...stored, name: 'renamed', nsfw: true}).execute();
			await patchChannel(channel.id, {content_warning_text: 'Other'})
				.expect(403, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED)
				.execute();
			const cleared = await patchChannel(channel.id, {
				nsfw_override: null,
				content_warning_level: ContentWarningLevel.INHERIT,
				content_warning_text: null,
			}).execute();
			expect(cleared.name).toBe('renamed');
			expect(cleared.nsfw_override).toBeNull();
			expect(cleared.content_warning_level).toBe(ContentWarningLevel.INHERIT);
			expect(cleared.content_warning_text).toBeNull();
		});

		it('creates and edits these settings while the flag is on', async () => {
			overrideLimits({feature_mature_content_settings: 1});
			const channel = await createChannel({nsfw_override: true}).execute();
			const updated = await patchChannel(channel.id, {
				content_warning_level: ContentWarningLevel.CONTENT_WARNING,
				content_warning_text: 'Spoilers',
			}).execute();
			expect(updated.nsfw_override).toBe(true);
			expect(updated.content_warning_level).toBe(ContentWarningLevel.CONTENT_WARNING);
			expect(updated.content_warning_text).toBe('Spoilers');
		});
	});

	describe('communities', () => {
		it.each(OPENING_GUILD_FIELDS)('refuses to turn on %o', async (body) => {
			await patchGuild(body).expect(403, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED).execute();
			const stored = await createBuilder<GuildResponse>(harness, owner.token).get(`/guilds/${guild.id}`).execute();
			expect(stored.nsfw).toBe(false);
			expect(stored.content_warning_level).toBe(ContentWarningLevel.INHERIT);
			expect(stored.content_warning_text).toBeNull();
		});

		it('accepts the stored values sent back unchanged, refuses new warning text and lets every setting be turned off', async () => {
			const stored = {
				nsfw: true,
				content_warning_level: ContentWarningLevel.CONTENT_WARNING,
				content_warning_text: 'Spoilers',
			};
			await withStoredValues(() => patchGuild(stored).execute());
			await patchGuild({...stored, name: 'Renamed'}).execute();
			await patchGuild({content_warning_text: 'Other'})
				.expect(403, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED)
				.execute();
			const cleared = await patchGuild({
				nsfw: false,
				content_warning_level: ContentWarningLevel.INHERIT,
				content_warning_text: null,
			}).execute();
			expect(cleared.name).toBe('Renamed');
			expect(cleared.nsfw).toBe(false);
			expect(cleared.content_warning_level).toBe(ContentWarningLevel.INHERIT);
			expect(cleared.content_warning_text).toBeNull();
		});

		it('turns these settings on while the flag is on', async () => {
			overrideLimits({feature_mature_content_settings: 1});
			const updated = await patchGuild({nsfw_level: GuildNSFWLevel.AGE_RESTRICTED}).execute();
			expect(updated.nsfw).toBe(true);
			expect(updated.content_warning_level).toBe(ContentWarningLevel.CONTENT_WARNING);
		});
	});

	describe('community templates', () => {
		it.each([
			['a category', 0],
			['a channel', 1],
		])('creates the community with mature content off when the template marks %s as mature', async (_label, index) => {
			const channels = TEMPLATE_CHANNELS.map((channel, i) => (i === index ? {...channel, nsfw: true} : channel));
			const created = await createGuildFromTemplate(channels).execute();
			const guilds = await createBuilder<Array<GuildResponse>>(harness, owner.token).get('/users/@me/guilds').execute();
			expect(guilds.map((g) => g.id).sort()).toEqual([guild.id, created.id].sort());
			const createdChannels = await getGuildChannels(harness, owner.token, created.id);
			expect(createdChannels).toHaveLength(2);
			for (const channel of createdChannels) {
				expect(channel.nsfw).toBe(false);
				expect(channel.nsfw_override).not.toBe(true);
			}
		});

		it('creates a community from a template that leaves mature content off', async () => {
			const created = await createGuildFromTemplate([
				{...TEMPLATE_CHANNELS[0], nsfw: false},
				TEMPLATE_CHANNELS[1],
			]).execute();
			const channels = await getGuildChannels(harness, owner.token, created.id);
			expect(channels).toHaveLength(2);
			expect(channels.every((channel) => channel.nsfw === false)).toBe(true);
		});

		it('creates mature channels from a template while the flag is on', async () => {
			overrideLimits({feature_mature_content_settings: 1});
			const created = await createGuildFromTemplate([
				{...TEMPLATE_CHANNELS[0], nsfw: true},
				TEMPLATE_CHANNELS[1],
			]).execute();
			const channels = await getGuildChannels(harness, owner.token, created.id);
			expect(channels.find((channel) => channel.name === 'Main')?.nsfw_override).toBe(true);
		});
	});

	it('answers a member without permission with MISSING_PERMISSIONS before the flag check', async () => {
		const member = await createTestAccount(harness);
		const channel = await createChannel({}).execute();
		const invite = await createChannelInvite(harness, owner.token, channel.id);
		await acceptInvite(harness, member.token, invite.code);
		await createBuilder(harness, member.token)
			.post(`/guilds/${guild.id}/channels`)
			.body({name: 'room', type: ChannelTypes.GUILD_TEXT, nsfw_override: true})
			.expect(403, APIErrorCodes.MISSING_PERMISSIONS)
			.execute();
		await createBuilder(harness, member.token)
			.patch(`/channels/${channel.id}`)
			.body({nsfw_override: true})
			.expect(403, APIErrorCodes.MISSING_PERMISSIONS)
			.execute();
		await createBuilder(harness, member.token)
			.patch(`/guilds/${guild.id}`)
			.body({nsfw: true})
			.expect(403, APIErrorCodes.MISSING_PERMISSIONS)
			.execute();
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {createEmojiID, createGuildID, createMessageID, createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {MessageInteractionService} from '@app/api/channel/services/MessageInteractionService';
import {MessageDeleteService} from '@app/api/channel/services/message/MessageDeleteService';
import {MessageSendService} from '@app/api/channel/services/message/MessageSendService';
import {createMicupBotFixture, type MicupBotFixture} from '@app/api/guild/micupbot/tests/MicupBotTestUtils';
import {createGuild} from '@app/api/guild/tests/GuildTestUtils';
import {getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {getChannelRepository, getGuildRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest';

let harness: ApiTestHarness;
let f: MicupBotFixture;
let originalId: string | undefined;
beforeAll(async () => {
	harness = await createApiTestHarness();
});
beforeEach(async () => {
	originalId = Config.instance.micupBotApplicationId;
	await harness.reset();
	f = await createMicupBotFixture(harness);
});
afterEach(() => {
	Config.instance.micupBotApplicationId = originalId;
	vi.restoreAllMocks();
});
afterAll(async () => {
	await harness?.shutdown();
});

it('creating a panel posts the bot message with the emojis and stores it', async () => {
	const bot = await f.addBot();
	const send = vi.spyOn(MessageSendService.prototype, 'sendMessage');
	const reaction = vi.spyOn(MessageInteractionService.prototype, 'addReaction');
	const result = await f.createPanel().execute();
	const messageId = createMessageID(BigInt(result.message_id));
	expect(result).toMatchObject({...f.panel, entries: [{emoji: {name: '🔴', id: null}, role_id: f.role.id}]});
	expect(send).toHaveBeenCalledWith(
		expect.objectContaining({
			user: expect.objectContaining({id: createUserID(BigInt(bot.botUserId))}),
			data: expect.objectContaining({allowed_mentions: {parse: []}}),
		}),
	);
	expect(send.mock.calls[0]![0].data.embeds?.[0]?.description).toContain(`🔴 → <@&${f.role.id}>`);
	expect(reaction).toHaveBeenCalledWith(
		expect.objectContaining({userId: createUserID(BigInt(bot.botUserId)), messageId, emoji: '🔴'}),
	);
	expect((await getChannelRepository().messages.getMessage(f.channelId, messageId))?.authorId).toBe(
		createUserID(BigInt(bot.botUserId)),
	);
	expect(
		await getChannelRepository().messageInteractions.checkUserReactionExists(
			f.channelId,
			messageId,
			createUserID(BigInt(bot.botUserId)),
			'🔴',
		),
	).toBe(true);
	expect(await f.repository.getPanel(f.guildId, messageId)).not.toBeNull();
	expect(await createBuilder(harness, f.owner.token).get(`${f.base}/reaction-roles`).execute()).toEqual({
		panels: [result],
		max_panels: 25,
	});
});

it('the 26th panel answers MAX_MICUPBOT_REACTION_ROLE_PANELS', async () => {
	await f.addBot();
	for (let i = 0; i < 25; i++) await f.seedPanel();
	const send = vi.spyOn(MessageSendService.prototype, 'sendMessage');
	await f.createPanel().expect(400, APIErrorCodes.MAX_MICUPBOT_REACTION_ROLE_PANELS).execute();
	expect(send).not.toHaveBeenCalled();
});

it('concurrent panel creates cannot exceed 25 stored panels', async () => {
	await f.addBot();
	for (let i = 0; i < 24; i++) await f.seedPanel();
	const results = await Promise.all([f.createPanel().executeRaw(), f.createPanel().executeRaw()]);
	expect(results.map(({response}) => response.status).sort()).toEqual([200, 400]);
	expect(await f.repository.listPanels(f.guildId)).toHaveLength(25);
});

it('a panel persistence failure removes the unregistered bot message', async () => {
	await f.addBot();
	vi.spyOn(f.repository, 'putPanel').mockRejectedValueOnce(new Error('Storage unavailable'));
	const send = vi.spyOn(MessageSendService.prototype, 'sendMessage');
	await f.createPanel().expect(500).execute();
	const {message} = await send.mock.results[0]!.value;
	expect(await getChannelRepository().messages.getMessage(f.channelId, message.id)).toBeNull();
	expect(await f.repository.listPanels(f.guildId)).toEqual([]);
});

it('an uncertain panel write keeps the message if its row exists or cannot be checked', async () => {
	await f.addBot();
	const put = f.repository.putPanel.bind(f.repository);
	const persist = vi.spyOn(f.repository, 'putPanel');
	const send = vi.spyOn(MessageSendService.prototype, 'sendMessage');
	for (const outcome of ['stored', 'unreadable']) {
		persist.mockImplementationOnce(async (row) => {
			if (outcome === 'stored') await put(row);
			else vi.spyOn(f.repository, 'getPanel').mockRejectedValueOnce(new Error('Read unavailable'));
			throw new Error('Write acknowledgement unavailable');
		});
		send.mockClear();
		await f.createPanel().expect(500).execute();
		const {message} = await send.mock.results[0]!.value;
		expect(await getChannelRepository().messages.getMessage(f.channelId, message.id)).not.toBeNull();
	}
});

it('a panel needs the bot in the community', async () => {
	await f.createPanel().expect(400, APIErrorCodes.MICUPBOT_NOT_IN_GUILD).execute();
	expect(await f.repository.listPanels(f.guildId)).toEqual([]);
});

it('deleting a panel removes the row and tries the bot message', async () => {
	const bot = await f.addBot();
	const panel = await f.createPanel().execute();
	const messageId = createMessageID(BigInt(panel.message_id));
	const remove = vi.spyOn(MessageDeleteService.prototype, 'deleteMessage');
	await createBuilder(harness, f.owner.token).delete(`${f.base}/reaction-roles/${messageId}`).expect(204).execute();
	expect(remove).toHaveBeenCalledWith(
		expect.objectContaining({userId: createUserID(BigInt(bot.botUserId)), channelId: f.channelId, messageId}),
	);
	expect(await f.repository.getPanel(f.guildId, messageId)).toBeNull();
	expect(await getChannelRepository().messages.getMessage(f.channelId, messageId)).toBeNull();
	const orphan = await f.seedPanel();
	remove.mockRejectedValueOnce(new Error('Message already unavailable'));
	await createBuilder(harness, f.owner.token)
		.delete(`${f.base}/reaction-roles/${orphan.message_id}`)
		.expect(204)
		.execute();
	expect(await f.repository.getPanel(f.guildId, orphan.message_id)).toBeNull();
});

it('an emoji of another community is refused', async () => {
	await f.addBot();
	const other = await createGuild(harness, f.owner.token, 'Other emoji');
	const emojiId = createEmojiID(await getSnowflakeService().generate());
	await getGuildRepository().upsertEmoji({
		guild_id: createGuildID(BigInt(other.id)),
		emoji_id: emojiId,
		name: 'colour',
		creator_id: createUserID(BigInt(f.owner.userId)),
		animated: false,
		version: 0,
	});
	const send = vi.spyOn(MessageSendService.prototype, 'sendMessage');
	await f
		.createPanel({...f.panel, entries: [{emoji: {name: 'colour', id: emojiId.toString()}, role_id: f.role.id}]})
		.expect(400, APIErrorCodes.INVALID_FORM_BODY)
		.execute();
	expect(send).not.toHaveBeenCalled();
});

it('a panel or warning of another community answers 404', async () => {
	const panel = await f.seedPanel();
	const warning = await f.seedWarning();
	const other = await createGuild(harness, f.owner.token, 'Other community');
	const base = `/guilds/${other.id}/micupbot`;
	await createBuilder(harness, f.owner.token)
		.delete(`${base}/reaction-roles/${panel.message_id}`)
		.expect(404, APIErrorCodes.UNKNOWN_MICUPBOT_REACTION_ROLE_PANEL)
		.execute();
	await createBuilder(harness, f.owner.token)
		.delete(`${base}/warnings/${f.owner.userId}/${warning.warning_id}`)
		.expect(404, APIErrorCodes.UNKNOWN_MICUPBOT_WARNING)
		.execute();
	expect(await f.repository.getPanel(f.guildId, panel.message_id)).toEqual(panel);
	expect(await f.repository.listWarnings(f.guildId, warning.user_id, 100)).toEqual([warning]);
});

it('panel channel overwrites and unsafe roles are checked before sending', async () => {
	await f.addBot();
	const caller = await f.member(
		Permissions.MANAGE_GUILD |
			Permissions.MANAGE_ROLES |
			Permissions.SEND_MESSAGES |
			Permissions.VIEW_CHANNEL |
			Permissions.ADD_REACTIONS,
	);
	const send = vi.spyOn(MessageSendService.prototype, 'sendMessage');
	await f
		.createPanel({...f.panel, entries: [{emoji: {name: '🔴'}, role_id: f.guild.id}]})
		.expect(400, APIErrorCodes.MICUPBOT_ROLE_NOT_ASSIGNABLE)
		.execute();
	for (const permission of [Permissions.VIEW_CHANNEL, Permissions.SEND_MESSAGES, Permissions.ADD_REACTIONS]) {
		await createBuilder(harness, f.owner.token)
			.put(`/channels/${f.channelId}/permissions/${caller.role.id}`)
			.body({type: 0, allow: '0', deny: permission.toString()})
			.expect(204)
			.execute();
		await f.createPanel(f.panel, caller.token).expect(403, APIErrorCodes.MISSING_PERMISSIONS).execute();
	}
	expect(send).not.toHaveBeenCalled();
});

it.each([
	['VIEW_CHANNEL', Permissions.VIEW_CHANNEL],
	['SEND_MESSAGES', Permissions.SEND_MESSAGES],
	['EMBED_LINKS', Permissions.EMBED_LINKS],
	['ADD_REACTIONS', Permissions.ADD_REACTIONS],
	['READ_MESSAGE_HISTORY', Permissions.READ_MESSAGE_HISTORY],
])('a panel checks the bot channel %s permission before sending', async (_name, permission) => {
	const bot = await f.addBot();
	await createBuilder(harness, f.owner.token)
		.put(`/channels/${f.channelId}/permissions/${bot.botUserId}`)
		.body({type: 1, allow: '0', deny: permission.toString()})
		.expect(204)
		.execute();
	const send = vi.spyOn(MessageSendService.prototype, 'sendMessage');
	await f.createPanel().expect(403, APIErrorCodes.MISSING_PERMISSIONS).execute();
	expect(send).not.toHaveBeenCalled();
	expect(await f.repository.listPanels(f.guildId)).toEqual([]);
});

it('invalid unicode is rejected and a reaction failure leaves a usable stored panel', async () => {
	await f.addBot();
	await f
		.createPanel({...f.panel, entries: [{emoji: {name: 'plain text'}, role_id: f.role.id}]})
		.expect(400, APIErrorCodes.INVALID_FORM_BODY)
		.execute();
	vi.spyOn(MessageInteractionService.prototype, 'addReaction').mockRejectedValueOnce(new Error('Reaction unavailable'));
	const panel = await f.createPanel().execute();
	expect(await f.repository.getPanel(f.guildId, createMessageID(BigInt(panel.message_id)))).not.toBeNull();
});

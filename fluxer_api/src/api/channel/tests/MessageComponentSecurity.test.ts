// SPDX-License-Identifier: AGPL-3.0-or-later

import {unclaimAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createChannelID, createGuildID, createUserID} from '@app/api/BrandedTypes';
import {createTestBotAccount} from '@app/api/bot/tests/BotTestUtils';
import {Config} from '@app/api/Config';
import {
	createChannel,
	createPermissionOverwrite,
	sendChannelMessage,
	updateGuild,
} from '@app/api/channel/tests/ChannelTestUtils';
import {
	clickButton,
	createClickFixture,
	spyRouter,
	storeButtonMessage,
} from '@app/api/channel/tests/MessageComponentTestUtils';
import * as RosterComponents from '@app/api/guild/roster/GuildRosterComponents';
import {createDMChannel} from '@app/api/message/tests/MessageTestUtils';
import {getGuildRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {GuildOperations} from '@fluxer/constants/src/GuildConstants';
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest';

let harness: ApiTestHarness;
let originalRosterId: string | undefined;
beforeAll(async () => {
	harness = await createApiTestHarness();
});
beforeEach(async () => {
	originalRosterId = Config.instance.rosterBotApplicationId;
	await harness.reset();
});
afterEach(() => {
	Config.instance.rosterBotApplicationId = originalRosterId;
	vi.restoreAllMocks();
});
afterAll(async () => {
	await harness?.shutdown();
});

const UNAVAILABLE = {reply: {code: 'component_unavailable', channel_id: null}};

function spyRosterHandler() {
	return vi.spyOn(RosterComponents, 'handleGuildRosterComponent').mockResolvedValue({code: 'roster_joined'});
}

it('a member who cannot view the channel gets 403 and no handler runs', async () => {
	const f = await createClickFixture(harness);
	const messageId = await storeButtonMessage({channelId: f.channelId, authorId: f.botId});
	await createPermissionOverwrite(harness, f.owner.token, f.systemChannel.id, f.member.userId, {
		type: 1,
		allow: '0',
		deny: Permissions.VIEW_CHANNEL.toString(),
	});
	const router = spyRouter();
	await clickButton(harness, f.member.token, f.channelId, messageId).expect(403).execute();
	expect(router).not.toHaveBeenCalled();
});

it('without READ_MESSAGE_HISTORY a message before the cutoff answers 404', async () => {
	const f = await createClickFixture(harness);
	const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
	const before = await storeButtonMessage({channelId: f.channelId, authorId: f.botId});
	await tick();
	await updateGuild(harness, f.owner.token, f.guild.id, {message_history_cutoff: new Date().toISOString()});
	await tick();
	const after = await storeButtonMessage({channelId: f.channelId, authorId: f.botId});
	await createPermissionOverwrite(harness, f.owner.token, f.systemChannel.id, f.member.userId, {
		type: 1,
		allow: Permissions.VIEW_CHANNEL.toString(),
		deny: Permissions.READ_MESSAGE_HISTORY.toString(),
	});
	const router = spyRouter();
	await clickButton(harness, f.member.token, f.channelId, before).expect(404, APIErrorCodes.UNKNOWN_MESSAGE).execute();
	expect(router).not.toHaveBeenCalled();
	expect((await clickButton(harness, f.member.token, f.channelId, after).execute()).reply?.code).toBe('roster_joined');
});

it('a timed-out member cannot click', async () => {
	const f = await createClickFixture(harness);
	const messageId = await storeButtonMessage({channelId: f.channelId, authorId: f.botId});
	await createBuilder(harness, f.owner.token)
		.patch(`/guilds/${f.guild.id}/members/${f.member.userId}`)
		.body({communication_disabled_until: new Date(Date.now() + 5 * 60 * 1000).toISOString()})
		.execute();
	const router = spyRouter();
	await clickButton(harness, f.member.token, f.channelId, messageId)
		.expect(403, APIErrorCodes.COMMUNICATION_DISABLED)
		.execute();
	expect(router).not.toHaveBeenCalled();
});

it('an unverified email cannot click', async () => {
	const f = await createClickFixture(harness);
	const messageId = await storeButtonMessage({channelId: f.channelId, authorId: f.botId});
	await createBuilder(harness, '')
		.post(`/test/users/${f.member.userId}/security-flags`)
		.body({email_verified: false, suspicious_activity_flags: 0})
		.execute();
	const router = spyRouter();
	await clickButton(harness, f.member.token, f.channelId, messageId)
		.expect(403, APIErrorCodes.EMAIL_VERIFICATION_REQUIRED)
		.execute();
	expect(router).not.toHaveBeenCalled();
});

it('an unclaimed account cannot click', async () => {
	const f = await createClickFixture(harness);
	const messageId = await storeButtonMessage({channelId: f.channelId, authorId: f.botId});
	await unclaimAccount(harness, f.member.userId);
	const router = spyRouter();
	await clickButton(harness, f.member.token, f.channelId, messageId)
		.expect(400, APIErrorCodes.UNCLAIMED_ACCOUNT_CANNOT_SEND_MESSAGES)
		.execute();
	expect(router).not.toHaveBeenCalled();
});

it('a user who has not started a session cannot click', async () => {
	const f = await createClickFixture(harness);
	const messageId = await storeButtonMessage({channelId: f.channelId, authorId: f.botId});
	await createBuilder(harness, f.member.token)
		.patch(`/test/users/${f.member.userId}/flags`)
		.body({flags: '0'})
		.execute();
	const router = spyRouter();
	const {json} = await clickButton(harness, f.member.token, f.channelId, messageId).expect(400).executeWithResponse();
	expect(JSON.stringify(json)).toContain('MUST_START_SESSION_BEFORE_SENDING');
	expect(router).not.toHaveBeenCalled();
});

it('a bot token or a bot user is refused', async () => {
	const f = await createClickFixture(harness);
	const messageId = await storeButtonMessage({channelId: f.channelId, authorId: f.botId});
	const bot = await createTestBotAccount(harness);
	const router = spyRouter();
	await clickButton(harness, `Bot ${bot.botToken}`, f.channelId, messageId).expect(403).execute();
	await createBuilder(harness, '').post(`/test/users/${f.member.userId}/set-bot-flag`).body({is_bot: true}).execute();
	await clickButton(harness, f.member.token, f.channelId, messageId).expect(403).execute();
	expect(router).not.toHaveBeenCalled();
});

it('a message id of another channel answers 404', async () => {
	const f = await createClickFixture(harness);
	const other = await createChannel(harness, f.owner.token, f.guild.id, 'diger');
	const messageId = await storeButtonMessage({channelId: createChannelID(BigInt(other.id)), authorId: f.botId});
	const router = spyRouter();
	await clickButton(harness, f.member.token, f.channelId, messageId)
		.expect(404, APIErrorCodes.UNKNOWN_MESSAGE)
		.execute();
	expect(router).not.toHaveBeenCalled();
});

it('a click in a DM answers 404', async () => {
	const f = await createClickFixture(harness);
	const dm = await createDMChannel(harness, f.member.token, f.owner.userId);
	const dmMessage = await storeButtonMessage({channelId: createChannelID(BigInt(dm.id)), authorId: f.botId});
	const notesId = createChannelID(BigInt(f.member.userId));
	const notesMessage = await storeButtonMessage({channelId: notesId, authorId: f.botId});
	const router = spyRouter();
	await clickButton(harness, f.member.token, dm.id, dmMessage).expect(404).execute();
	await clickButton(harness, f.member.token, notesId, notesMessage).expect(404).execute();
	expect(router).not.toHaveBeenCalled();
});

it('a stored button on a message by a normal user calls no handler', async () => {
	const f = await createClickFixture(harness);
	const messageId = await storeButtonMessage({
		channelId: f.channelId,
		authorId: createUserID(BigInt(f.owner.userId)),
	});
	const handler = spyRosterHandler();
	expect(await clickButton(harness, f.member.token, f.channelId, messageId).execute()).toEqual(UNAVAILABLE);
	expect(handler).not.toHaveBeenCalled();
});

it('a support custom_id on a Roster message calls no handler', async () => {
	const f = await createClickFixture(harness);
	const support = await storeButtonMessage({channelId: f.channelId, authorId: f.botId, customId: 'support:open'});
	const roster = await storeButtonMessage({channelId: f.channelId, authorId: f.botId});
	const handler = spyRosterHandler();
	expect(await clickButton(harness, f.member.token, f.channelId, support, 'support:open').execute()).toEqual(
		UNAVAILABLE,
	);
	expect(handler).not.toHaveBeenCalled();
	expect((await clickButton(harness, f.member.token, f.channelId, roster).execute()).reply?.code).toBe('roster_joined');
	expect(handler).toHaveBeenCalledOnce();
	expect(handler.mock.calls[0]![0].guildId).toBe(createGuildID(BigInt(f.guild.id)));
});

it('a webhook message never routes', async () => {
	const f = await createClickFixture(harness);
	const messageId = await storeButtonMessage({channelId: f.channelId, authorId: f.botId, webhookId: f.botId});
	const router = spyRouter();
	expect(await clickButton(harness, f.member.token, f.channelId, messageId).execute()).toEqual(UNAVAILABLE);
	expect(router).not.toHaveBeenCalled();
});

it('the 11th click in 10 seconds in one channel answers 429', async () => {
	const f = await createClickFixture(harness);
	const messageId = await storeButtonMessage({channelId: f.channelId, authorId: f.botId});
	spyRouter();
	const click = () =>
		clickButton(harness, f.member.token, f.channelId, messageId).header('x-fluxer-test-enable-rate-limits', 'true');
	for (let index = 0; index < 10; index++) await click().expect(200).execute();
	await click().expect(429, APIErrorCodes.RATE_LIMITED).execute();
});

it('disabling REACTIONS for the community does not block button clicks', async () => {
	const f = await createClickFixture(harness);
	const guildId = createGuildID(BigInt(f.guild.id));
	const guild = (await getGuildRepository().findUnique(guildId))!;
	await getGuildRepository().upsertPartial(guildId, {disabled_operations: GuildOperations.REACTIONS}, guild.toRow());
	const sent = await sendChannelMessage(harness, f.owner.token, f.systemChannel.id, 'Tepki dene');
	await createBuilder(harness, f.member.token)
		.put(`/channels/${f.channelId}/messages/${sent.id}/reactions/%F0%9F%91%8D/@me`)
		.expect(403, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED)
		.execute();
	const messageId = await storeButtonMessage({channelId: f.channelId, authorId: f.botId});
	const router = spyRouter();
	expect((await clickButton(harness, f.member.token, f.channelId, messageId).execute()).reply?.code).toBe(
		'roster_joined',
	);
	expect(router).toHaveBeenCalledOnce();
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {
	clickButton,
	createClickFixture,
	spyRouter,
	storeButtonMessage,
} from '@app/api/channel/tests/MessageComponentTestUtils';
import * as Router from '@app/api/guild/OfficialBotComponentRouter';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {MESSAGE_COMPONENT_REPLY_CODES} from '@fluxer/constants/src/MessageComponentConstants';
import {MessageComponentClickResponse} from '@fluxer/schema/src/domains/message/MessageComponentSchemas';
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

it('a click on a clickable button of a first-party bot message calls the router once and returns its reply', async () => {
	const f = await createClickFixture(harness);
	const messageId = await storeButtonMessage({channelId: f.channelId, authorId: f.botId});
	const router = spyRouter({code: 'roster_joined'});
	const body = await clickButton(harness, f.member.token, f.channelId, messageId).execute();
	expect(body).toEqual({reply: {code: 'roster_joined', channel_id: null}});
	expect(router).toHaveBeenCalledOnce();
	const click = router.mock.calls[0]![0];
	expect(click.customId).toBe('roster:join');
	expect(click.user.id.toString()).toBe(f.member.userId);
	expect(click.guildId.toString()).toBe(f.guild.id);
	expect(click.channelId).toBe(f.channelId);
	expect(click.message.id).toBe(messageId);
	expect(click.member.user.id).toBe(f.member.userId);
});

it('the reply code reaches the HTTP body unchanged', async () => {
	const f = await createClickFixture(harness);
	const messageId = await storeButtonMessage({channelId: f.channelId, authorId: f.botId});
	for (const code of MESSAGE_COMPONENT_REPLY_CODES) {
		spyRouter({code, channel_id: f.channelId.toString()});
		const body = await clickButton(harness, f.member.token, f.channelId, messageId).execute();
		expect(body).toEqual({reply: {code, channel_id: f.channelId.toString()}});
	}
});

it('a disabled button answers component_unavailable', async () => {
	const f = await createClickFixture(harness);
	const messageId = await storeButtonMessage({channelId: f.channelId, authorId: f.botId, disabled: true});
	const router = spyRouter();
	const body = await clickButton(harness, f.member.token, f.channelId, messageId).execute();
	expect(body).toEqual({reply: {code: 'component_unavailable', channel_id: null}});
	expect(router).not.toHaveBeenCalled();
});

it('a custom_id that is not on the message answers component_unavailable and calls no handler', async () => {
	const f = await createClickFixture(harness);
	const messageId = await storeButtonMessage({channelId: f.channelId, authorId: f.botId});
	const router = spyRouter();
	const body = await clickButton(harness, f.member.token, f.channelId, messageId, 'roster:leave').execute();
	expect(body).toEqual({reply: {code: 'component_unavailable', channel_id: null}});
	expect(router).not.toHaveBeenCalled();
});

it('the click response schema accepts only the known reply codes', async () => {
	for (const code of MESSAGE_COMPONENT_REPLY_CODES)
		expect(MessageComponentClickResponse.safeParse({reply: {code, channel_id: null}}).success).toBe(true);
	expect(MessageComponentClickResponse.safeParse({reply: null}).success).toBe(true);
	for (const code of ['support_opened', 'Katıldın!', '', 'ROSTER_JOINED'])
		expect(MessageComponentClickResponse.safeParse({reply: {code}}).success).toBe(false);
	const f = await createClickFixture(harness);
	const messageId = await storeButtonMessage({channelId: f.channelId, authorId: f.botId});
	const body = await clickButton(harness, f.member.token, f.channelId, messageId).execute();
	expect(MessageComponentClickResponse.parse(body)).toEqual(body);
});

it("the click's write is visible when the HTTP reply arrives", async () => {
	const f = await createClickFixture(harness);
	const messageId = await storeButtonMessage({channelId: f.channelId, authorId: f.botId});
	const key = `dd-a:click-write:${messageId}`;
	vi.spyOn(Router, 'routeOfficialBotComponent').mockImplementation(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
		await getKVClient().set(key, 'written');
		return {code: 'roster_joined'};
	});
	const body = await clickButton(harness, f.member.token, f.channelId, messageId).execute();
	expect(body.reply?.code).toBe('roster_joined');
	expect(await getKVClient().get(key)).toBe('written');
});

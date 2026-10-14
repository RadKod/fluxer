// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createMessageID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {createChannel} from '@app/api/channel/tests/ChannelTestUtils';
import {createClickFixture, storeButtonMessage} from '@app/api/channel/tests/MessageComponentTestUtils';
import {getChannelRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {MessageReferenceTypes} from '@fluxer/constants/src/ChannelConstants';
import type {MessageResponse} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
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

it('forwarding a message with buttons copies no components into the snapshot', async () => {
	const f = await createClickFixture(harness);
	const source = await storeButtonMessage({channelId: f.channelId, authorId: f.botId});
	expect((await getChannelRepository().messages.getMessage(f.channelId, source))?.components).toHaveLength(1);
	const destination = await createChannel(harness, f.owner.token, f.guild.id, 'iletilen');
	const forwarded = await createBuilder<MessageResponse>(harness, f.member.token)
		.post(`/channels/${destination.id}/messages`)
		.body({
			message_reference: {
				message_id: source.toString(),
				channel_id: f.channelId.toString(),
				guild_id: f.guild.id,
				type: MessageReferenceTypes.FORWARD,
			},
		})
		.execute();
	expect(forwarded.message_snapshots?.[0]?.content).toBe('Kart');
	expect(forwarded.message_snapshots?.[0]).not.toHaveProperty('components');
	const stored = await getChannelRepository().messages.getMessage(
		createChannelID(BigInt(destination.id)),
		createMessageID(BigInt(forwarded.id)),
	);
	expect(stored?.components).toEqual([]);
	const row = stored!.toRow();
	expect(row.micup_components).toBeNull();
	expect(row.message_snapshots?.[0]).not.toHaveProperty('components');
	expect(row.message_snapshots?.[0]).not.toHaveProperty('micup_components');
});

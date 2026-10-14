// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	type ChannelID,
	createChannelID,
	createMessageID,
	createWebhookID,
	type MessageID,
	type UserID,
} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {actionRow, button} from '@app/api/channel/services/message/MessageComponentRules';
import {setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import * as Router from '@app/api/guild/OfficialBotComponentRouter';
import {rosterBotUserId} from '@app/api/guild/roster/GuildRosterBot';
import {getChannelRepository} from '@app/api/middleware/ServiceSingletons';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import type {MessageComponentClickResponse} from '@fluxer/schema/src/domains/message/MessageComponentSchemas';
import {createSnowflake} from '@fluxer/snowflake/src/Snowflake';
import {makeBucket} from '@fluxer/snowflake/src/SnowflakeBuckets';
import {vi} from 'vitest';

const ROSTER_APP_ID = '9001';

// A guild with one member and a configured Roster bot; the bot's messages are written straight to the repository.
export async function createClickFixture(harness: ApiTestHarness) {
	const setup = await setupTestGuildWithMembers(harness, 1);
	Config.instance.rosterBotApplicationId = ROSTER_APP_ID;
	overrideLimits({feature_guild_roster: 1});
	return {
		...setup,
		member: setup.members[0]!,
		channelId: createChannelID(BigInt(setup.systemChannel.id)),
		botId: rosterBotUserId()!,
	};
}

let sequence = 0;

export async function storeButtonMessage(p: {
	channelId: ChannelID;
	authorId: UserID;
	customId?: string;
	disabled?: boolean;
	webhookId?: bigint;
}): Promise<MessageID> {
	const messageId = createMessageID(createSnowflake({timestamp: Date.now(), sequence: sequence++ % 4096}));
	await getChannelRepository().messages.upsertMessage(
		{
			channel_id: p.channelId,
			bucket: makeBucket(messageId),
			message_id: messageId,
			author_id: p.authorId,
			type: 0,
			webhook_id: p.webhookId ? createWebhookID(p.webhookId) : null,
			webhook_name: p.webhookId ? 'Hook' : null,
			webhook_avatar_hash: null,
			content: 'Kart',
			edited_timestamp: null,
			pinned_timestamp: null,
			flags: 0,
			mention_everyone: false,
			mention_users: null,
			mention_roles: null,
			mention_channels: null,
			attachments: null,
			embeds: null,
			sticker_items: null,
			message_reference: null,
			message_snapshots: null,
			call: null,
			has_reaction: false,
			version: 1,
			micup_components: [
				actionRow([button({customId: p.customId ?? 'roster:join', label: 'Katıl', style: 3, disabled: p.disabled})]),
			],
		},
		null,
	);
	return messageId;
}

export function clickButton(
	harness: ApiTestHarness,
	token: string,
	channelId: ChannelID | string,
	messageId: MessageID | string,
	customId = 'roster:join',
) {
	return createBuilder<MessageComponentClickResponse>(harness, token)
		.post(`/channels/${channelId}/messages/${messageId}/components`)
		.body({custom_id: customId});
}

export function spyRouter(reply: Router.OfficialBotComponentReply = {code: 'roster_joined'}) {
	return vi.spyOn(Router, 'routeOfficialBotComponent').mockResolvedValue(reply);
}

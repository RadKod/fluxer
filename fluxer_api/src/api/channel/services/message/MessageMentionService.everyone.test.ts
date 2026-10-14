// SPDX-License-Identifier: AGPL-3.0-or-later

import {MessageMentionService} from '@app/api/channel/services/message/MessageMentionService';
import type {MessageResponseDataService} from '@app/api/channel/services/message/MessageResponseDataService';
import type {Message} from '@app/api/models/Message';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {describe, expect, it, vi} from 'vitest';

describe('MessageMentionService everyone permission result', () => {
	it.each([true, false])('preserves everyone only when canMentionEveryone is %s', async (canMentionEveryone) => {
		const extractMentions = vi
			.fn()
			.mockResolvedValue([{users: [], roles: [], channels: [], everyone: true, here: false}]);
		const service = new MessageMentionService(
			{} as ConstructorParameters<typeof MessageMentionService>[0],
			{} as ConstructorParameters<typeof MessageMentionService>[1],
			{} as ConstructorParameters<typeof MessageMentionService>[2],
			{} as ConstructorParameters<typeof MessageMentionService>[3],
			{extractMentions} as unknown as MessageResponseDataService,
		);
		const result = await service.extractMentions({
			content: '@everyone',
			referencedMessage: null,
			message: {flags: 0} as Message,
			channelType: ChannelTypes.GUILD_TEXT,
			allowedMentions: null,
			canMentionEveryone,
		});
		expect(extractMentions).toHaveBeenCalledWith(['@everyone']);
		expect(result.mentionsEveryone).toBe(canMentionEveryone);
		expect(result.mentionsHere).toBe(false);
		expect(result.userMentions.size).toBe(0);
		expect(result.roleMentions.size).toBe(0);
	});
});

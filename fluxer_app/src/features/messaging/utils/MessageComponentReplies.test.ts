// SPDX-License-Identifier: AGPL-3.0-or-later

import {MESSAGE_COMPONENT_REPLY_CODES} from '@fluxer/constants/src/MessageComponentConstants';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));

const {replyDescriptor} = await import('@app/features/messaging/utils/MessageComponentReplies');

describe('MessageComponentReplies', () => {
	it('every reply code has a message descriptor', () => {
		for (const code of MESSAGE_COMPONENT_REPLY_CODES) {
			const descriptor = replyDescriptor(code) as {message?: string; comment?: string} | undefined;
			expect(descriptor?.message, code).toBeTruthy();
			expect(descriptor?.comment, code).toBeTruthy();
		}
		expect(replyDescriptor('toString')).toBeUndefined();
		expect(replyDescriptor('giveaway_from_the_future')).toBeUndefined();
	});
});

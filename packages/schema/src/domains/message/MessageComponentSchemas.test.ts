// SPDX-License-Identifier: AGPL-3.0-or-later

import {MESSAGE_COMPONENT_REPLY_CODES} from '@fluxer/constants/src/MessageComponentConstants';
import {
	MessageActionRowResponse,
	MessageComponentClickRequest,
	MessageComponentClickResponse,
} from '@fluxer/schema/src/domains/message/MessageComponentSchemas';
import {describe, expect, it} from 'vitest';

function row(style: number) {
	return {
		type: 1,
		components: [
			{
				type: 2,
				style,
				label: 'Katıl',
				emoji: {name: '✅', id: null, animated: false},
				custom_id: 'roster:join',
				disabled: false,
			},
		],
	};
}

describe('Message component schemas', () => {
	it('a button row parses with style 1..4 and rejects style 5', () => {
		for (const style of [1, 2, 3, 4]) expect(MessageActionRowResponse.safeParse(row(style)).success).toBe(true);
		for (const style of [0, 5]) expect(MessageActionRowResponse.safeParse(row(style)).success).toBe(false);
	});

	it('a click needs a custom_id of 1..100 characters', () => {
		for (const custom_id of ['roster:join', 'x'.repeat(100)])
			expect(MessageComponentClickRequest.safeParse({custom_id}).success).toBe(true);
		for (const body of [{}, {custom_id: ''}, {custom_id: 'x'.repeat(101)}])
			expect(MessageComponentClickRequest.safeParse(body).success).toBe(false);
	});

	it('the click response accepts only the known reply codes', () => {
		for (const code of MESSAGE_COMPONENT_REPLY_CODES)
			expect(MessageComponentClickResponse.safeParse({reply: {code}}).success).toBe(true);
		expect(MessageComponentClickResponse.safeParse({reply: null}).success).toBe(true);
		expect(
			MessageComponentClickResponse.safeParse({reply: {code: 'roster_joined', channel_id: '1490000000000000001'}})
				.success,
		).toBe(true);
		for (const code of ['', 'Roster_joined', 'free text from a bot'])
			expect(MessageComponentClickResponse.safeParse({reply: {code}}).success).toBe(false);
	});
});

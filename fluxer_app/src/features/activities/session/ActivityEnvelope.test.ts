// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	ACTIVITY_MESSAGE_MAX_BYTES,
	decodeActivityEnvelope,
	encodeActivityEnvelope,
} from '@app/features/activities/session/ActivityEnvelope';
import {describe, expect, it} from 'vitest';

const encoder = new TextEncoder();

describe('activity envelope', () => {
	it('round-trips type, seq and data', () => {
		const bytes = encodeActivityEnvelope('app', 7, {note: 3});
		expect(decodeActivityEnvelope(bytes, 'user_1_a')).toEqual({type: 'app', seq: 7, from: 'user_1_a', data: {note: 3}});
	});

	it('stamps the LiveKit sender and ignores a from field in the message', () => {
		const forged = encoder.encode(JSON.stringify({t: 'app', seq: 1, from: 'user_9_x', d: {from: 'user_9_x'}}));
		const envelope = decodeActivityEnvelope(forged, 'user_2_b');
		expect(envelope?.from).toBe('user_2_b');
		expect(envelope?.data).toEqual({from: 'user_9_x'});
	});

	it('drops what is not an envelope', () => {
		expect(decodeActivityEnvelope(encoder.encode('not json'), 'user_1_a')).toBeNull();
		expect(decodeActivityEnvelope(encoder.encode('[1]'), 'user_1_a')).toBeNull();
		expect(decodeActivityEnvelope(encoder.encode('{"t":"other","seq":1}'), 'user_1_a')).toBeNull();
		expect(decodeActivityEnvelope(encoder.encode('{"t":"app","seq":-1}'), 'user_1_a')).toBeNull();
		expect(decodeActivityEnvelope(encoder.encode('{"t":"app","seq":1.5}'), 'user_1_a')).toBeNull();
	});

	it('refuses a message over the size limit', () => {
		expect(() => encodeActivityEnvelope('app', 1, 'x'.repeat(ACTIVITY_MESSAGE_MAX_BYTES))).toThrow(RangeError);
	});
});

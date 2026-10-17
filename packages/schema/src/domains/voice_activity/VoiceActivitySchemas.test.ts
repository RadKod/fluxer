// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	StartVoiceActivityRequest,
	VoiceActivitySession,
} from '@fluxer/schema/src/domains/voice_activity/VoiceActivitySchemas';
import {describe, expect, test} from 'vitest';

describe('voice activity schemas', () => {
	test('start takes only known activity ids', () => {
		expect(StartVoiceActivityRequest.parse({activity_id: 'band', connection_id: 'c1'}).activity_id).toBe('band');
		expect(StartVoiceActivityRequest.safeParse({activity_id: 'poker', connection_id: 'c1'}).success).toBe(false);
		expect(StartVoiceActivityRequest.safeParse({activity_id: 'band', connection_id: ''}).success).toBe(false);
	});

	test('the session leaves the server with no extra fields', () => {
		const session = {activity_id: 'band', session_id: '1', started_by: '2', started_at: 3};
		expect(VoiceActivitySession.parse(session)).toEqual(session);
		expect(VoiceActivitySession.safeParse({...session, extra: true}).success).toBe(false);
	});
});

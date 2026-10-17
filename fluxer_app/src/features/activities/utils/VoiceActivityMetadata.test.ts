// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	parseRoomActivitySession,
	parseVoiceActivitySession,
} from '@app/features/activities/utils/VoiceActivityMetadata';
import {VOICE_ACTIVITY_METADATA_KEY, VOICE_ACTIVITY_SESSION_TTL_MS} from '@fluxer/constants/src/VoiceActivityConstants';
import {describe, expect, it} from 'vitest';

const NOW = 1_800_000_000_000;
const SESSION = {activity_id: 'band', session_id: '11', started_by: '22', started_at: NOW - 1_000};

describe('room activity metadata', () => {
	it('reads the session next to other server-written keys', () => {
		const metadata = JSON.stringify({other: {x: 1}, [VOICE_ACTIVITY_METADATA_KEY]: SESSION});
		expect(parseRoomActivitySession(metadata, NOW)).toEqual(SESSION);
	});

	it('is no session when the key is missing, null or the metadata is not JSON', () => {
		expect(parseRoomActivitySession(undefined, NOW)).toBeNull();
		expect(parseRoomActivitySession('', NOW)).toBeNull();
		expect(parseRoomActivitySession('{oops', NOW)).toBeNull();
		expect(parseRoomActivitySession('{"other":1}', NOW)).toBeNull();
		expect(parseRoomActivitySession(JSON.stringify({[VOICE_ACTIVITY_METADATA_KEY]: null}), NOW)).toBeNull();
	});

	it('ignores an activity this build does not know', () => {
		expect(parseVoiceActivitySession({...SESSION, activity_id: 'poker'}, NOW)).toBeNull();
	});

	it('rejects malformed fields', () => {
		expect(parseVoiceActivitySession({...SESSION, session_id: ''}, NOW)).toBeNull();
		expect(parseVoiceActivitySession({...SESSION, started_by: 22}, NOW)).toBeNull();
		expect(parseVoiceActivitySession({...SESSION, started_at: 'soon'}, NOW)).toBeNull();
	});

	it('treats a session past its TTL as ended', () => {
		const stale = {...SESSION, started_at: NOW - VOICE_ACTIVITY_SESSION_TTL_MS - 1};
		expect(parseVoiceActivitySession(stale, NOW)).toBeNull();
	});

	it('keeps only the contract fields', () => {
		expect(parseVoiceActivitySession({...SESSION, extra: true}, NOW)).toEqual(SESSION);
	});
});

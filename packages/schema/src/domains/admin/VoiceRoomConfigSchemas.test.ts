// SPDX-License-Identifier: AGPL-3.0-or-later

import {VOICE_ROOM_THEME_IDS} from '@fluxer/constants/src/VoiceRoomThemes';
import {
	DEFAULT_VOICE_ROOM_CONFIG,
	INERT_VOICE_ROOM_ASSIGNMENT,
	resolveVoiceRoomAssignment,
	VoiceRoomAssignmentResponse,
	VoiceRoomConfigSchema,
	VoiceRoomConfigUpdateRequest,
} from '@fluxer/schema/src/domains/admin/VoiceRoomConfigSchemas';
import {
	ExperimentAssignmentsResponse,
	readVoiceRoomAssignment,
} from '@fluxer/schema/src/domains/experiment/ExperimentSchemas';
import {describe, expect, test} from 'vitest';

describe('voice room config', () => {
	test('defaults both false', () => {
		expect(DEFAULT_VOICE_ROOM_CONFIG).toEqual({
			rooms_enabled: false,
			games_enabled: false,
			room_cameras_enabled: false,
			default_room_theme: null,
		});
		expect(VoiceRoomConfigSchema.parse({})).toEqual(DEFAULT_VOICE_ROOM_CONFIG);
		expect(resolveVoiceRoomAssignment(DEFAULT_VOICE_ROOM_CONFIG)).toEqual(INERT_VOICE_ROOM_ASSIGNMENT);
		expect(VoiceRoomConfigUpdateRequest.parse({})).toEqual({});
		expect(VoiceRoomConfigUpdateRequest.safeParse({rooms_enabled: 'yes'}).success).toBe(false);
	});

	test('games assignment needs rooms', () => {
		const off = {room_cameras_enabled: false, default_room_theme: null};
		expect(resolveVoiceRoomAssignment({rooms_enabled: false, games_enabled: true, ...off})).toEqual({
			rooms: false,
			games: false,
			cameras: false,
			default_room_theme: null,
		});
		expect(resolveVoiceRoomAssignment({rooms_enabled: true, games_enabled: false, ...off})).toEqual({
			rooms: true,
			games: false,
			cameras: false,
			default_room_theme: null,
		});
		expect(resolveVoiceRoomAssignment({rooms_enabled: true, games_enabled: true, ...off})).toEqual({
			rooms: true,
			games: true,
			cameras: false,
			default_room_theme: null,
		});
	});

	test('room_cameras_enabled defaults false', () => {
		expect(VoiceRoomConfigSchema.parse({rooms_enabled: true, games_enabled: true}).room_cameras_enabled).toBe(false);
		expect(INERT_VOICE_ROOM_ASSIGNMENT).toEqual({rooms: false, games: false, cameras: false, default_room_theme: null});
		expect(VoiceRoomConfigUpdateRequest.parse({room_cameras_enabled: true})).toEqual({room_cameras_enabled: true});
		expect(VoiceRoomConfigUpdateRequest.safeParse({room_cameras_enabled: 'on'}).success).toBe(false);
	});

	test('cameras assignment needs rooms', () => {
		const cameras = (rooms_enabled: boolean, room_cameras_enabled: boolean) =>
			resolveVoiceRoomAssignment({rooms_enabled, games_enabled: false, room_cameras_enabled, default_room_theme: null})
				.cameras;
		expect(cameras(false, true)).toBe(false);
		expect(cameras(true, false)).toBe(false);
		expect(cameras(true, true)).toBe(true);
	});

	test('experiments body without voice_room.cameras parses and reads false', () => {
		// Optional on the wire: a server that predates the field still parses, and the reader says false.
		expect(VoiceRoomAssignmentResponse.parse({rooms: true, games: true})).toEqual({rooms: true, games: true});
		const old = ExperimentAssignmentsResponse.parse({
			poll_interval_seconds: 300,
			poll_jitter_percent: 15,
			assignments: {voice_room: {rooms: true, games: true}},
		});
		expect(readVoiceRoomAssignment(old)).toEqual({rooms: true, games: true, cameras: false, default_room_theme: null});
		expect(readVoiceRoomAssignment({...old, assignments: {}})).toEqual(INERT_VOICE_ROOM_ASSIGNMENT);
	});

	test('stored default theme accepts manifest ids and null, and rejects none and unknown themes', () => {
		for (const default_room_theme of [...VOICE_ROOM_THEME_IDS, null]) {
			expect(VoiceRoomConfigSchema.parse({default_room_theme}).default_room_theme).toBe(default_room_theme);
			expect(VoiceRoomConfigUpdateRequest.parse({default_room_theme})).toEqual({default_room_theme});
		}
		for (const default_room_theme of ['none', 'unknown', 'uzay-gemisi', false]) {
			expect(VoiceRoomConfigSchema.safeParse({default_room_theme}).success).toBe(false);
			expect(VoiceRoomConfigUpdateRequest.safeParse({default_room_theme}).success).toBe(false);
		}
		expect(VoiceRoomAssignmentResponse.safeParse({rooms: true, games: false, default_room_theme: false}).success).toBe(
			false,
		);
	});

	test('experiments preserves assignments when the default theme is unknown to this client', () => {
		const assignments = {
			voice_room: {rooms: true, games: true, cameras: true, default_room_theme: 'uzay-gemisi'},
		};
		const response = ExperimentAssignmentsResponse.parse({
			poll_interval_seconds: 300,
			poll_jitter_percent: 15,
			assignments,
		});
		expect(response.assignments).toEqual(assignments);
		expect(readVoiceRoomAssignment(response)).toEqual(assignments.voice_room);
	});

	test('configured default theme is delivered and read without changing the rooms switch', () => {
		const default_room_theme = VOICE_ROOM_THEME_IDS[0];
		const config = VoiceRoomConfigSchema.parse({default_room_theme});
		const assignment = resolveVoiceRoomAssignment(config);
		expect(assignment).toEqual({...INERT_VOICE_ROOM_ASSIGNMENT, default_room_theme});
		const response = ExperimentAssignmentsResponse.parse({
			poll_interval_seconds: 300,
			poll_jitter_percent: 15,
			assignments: {voice_room: assignment},
		});
		expect(readVoiceRoomAssignment(response).default_room_theme).toBe(default_room_theme);
	});
});

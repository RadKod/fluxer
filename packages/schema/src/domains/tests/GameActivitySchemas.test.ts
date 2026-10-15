// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	GameActivityPolicyRevisionSchema,
	GameActivitySchema,
} from '@fluxer/schema/src/domains/user/GameActivitySchemas';
import {UserSettingsUpdateRequest} from '@fluxer/schema/src/domains/user/UserRequestSchemas';
import {UserSettingsResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {describe, expect, test} from 'vitest';

describe('game activity schemas', () => {
	test('exactly_one_identity_and_bounded_payload', () => {
		const started_at = 1_800_000_000_000;
		for (const value of [
			{started_at},
			{game_id: 'game', manual_name: 'Game', started_at},
			{game_id: 'a'.repeat(49), started_at},
			{game_id: '../game', started_at},
			{game_id: 'GAME', started_at},
			{manual_name: '', started_at},
			{manual_name: 'a'.repeat(65), started_at},
			{manual_name: 'Game\u202E', started_at},
			{manual_name: 'Game\u200B', started_at},
			{manual_name: 'Game\n', started_at},
			{game_id: 'game', started_at, icon_url: 'https://example.test/game.png'},
		])
			expect(GameActivitySchema.safeParse(value).success).toBe(false);
		expect(GameActivitySchema.parse({game_id: 'a'.repeat(48), started_at})).toEqual({
			game_id: 'a'.repeat(48),
			started_at,
		});
		expect(GameActivitySchema.parse({manual_name: '🎮'.repeat(64), started_at})).toEqual({
			manual_name: '🎮'.repeat(64),
			started_at,
		});
	});

	test('reject_unsafe_timestamp', () => {
		for (const started_at of [
			NaN,
			Infinity,
			-Infinity,
			1.5,
			Number.MAX_SAFE_INTEGER + 1,
			-Number.MAX_SAFE_INTEGER - 1,
		]) {
			expect(GameActivitySchema.safeParse({game_id: 'game', started_at}).success).toBe(false);
		}
		expect(GameActivitySchema.safeParse({game_id: 'game', started_at: Number.MAX_SAFE_INTEGER}).success).toBe(true);
	});

	test('missing_visibility_is_off', () => {
		const legacy = UserSettingsResponse.partial();
		expect(legacy.parse({})).toEqual({game_activity_visibility: 'off', game_activity_policy_revision: '0'});
		expect(legacy.parse({game_activity_visibility: null, game_activity_policy_revision: null})).toEqual({
			game_activity_visibility: 'off',
			game_activity_policy_revision: '0',
		});
		expect(UserSettingsUpdateRequest.safeParse({game_activity_visibility: 'shared_guilds'}).success).toBe(false);
		expect(UserSettingsUpdateRequest.parse({})).toEqual({});
	});

	test('everyone_and_default_acknowledgement_are_accepted', () => {
		expect(UserSettingsUpdateRequest.parse({game_activity_visibility: 'everyone'})).toEqual({
			game_activity_visibility: 'everyone',
		});
		expect(UserSettingsUpdateRequest.parse({game_activity_default_acknowledged: true})).toEqual({
			game_activity_default_acknowledged: true,
		});
		expect(UserSettingsUpdateRequest.safeParse({game_activity_default_acknowledged: false}).success).toBe(false);
		expect(
			UserSettingsResponse.partial().parse({
				game_activity_visibility: 'everyone',
				game_activity_eligible: true,
				game_activity_default_pending: false,
			}),
		).toEqual({
			game_activity_visibility: 'everyone',
			game_activity_policy_revision: '0',
			game_activity_eligible: true,
			game_activity_default_pending: false,
		});
	});

	test('policy_revision_is_bounded_canonical_decimal', () => {
		for (const revision of ['-1', '01', '1.0', '', '9223372036854775808', '1'.repeat(20)]) {
			expect(GameActivityPolicyRevisionSchema.safeParse(revision).success).toBe(false);
		}
		expect(GameActivityPolicyRevisionSchema.parse('9223372036854775807')).toBe('9223372036854775807');
	});
});

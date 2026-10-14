// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	GuildRosterEventCreateRequest,
	GuildRosterEventUpdateRequest,
} from '@fluxer/schema/src/domains/roster/GuildRosterRequestSchemas';
import {GuildRosterEventResponse} from '@fluxer/schema/src/domains/roster/GuildRosterResponseSchemas';
import {describe, expect, it} from 'vitest';

const input = {name: 'Raid', voice_channel_id: '1490000000000000001', announce_channel_id: '1490000000000000002'};

describe('Guild roster schemas', () => {
	it('name is trimmed and must be 1..64 characters', () => {
		expect(GuildRosterEventCreateRequest.parse({...input, name: ' Raid '}).name).toBe('Raid');
		for (const name of ['', '   ', 'x'.repeat(65)])
			expect(GuildRosterEventCreateRequest.safeParse({...input, name}).success).toBe(false);
		expect(GuildRosterEventCreateRequest.safeParse({...input, name: 'x'.repeat(64)}).success).toBe(true);
	});
	it('main_size defaults to 10 and accepts 1..50 only', () => {
		expect(GuildRosterEventCreateRequest.parse(input).main_size).toBe(10);
		for (const main_size of [1, 50])
			expect(GuildRosterEventCreateRequest.safeParse({...input, main_size}).success).toBe(true);
		for (const main_size of [0, 51, 1.5])
			expect(GuildRosterEventCreateRequest.safeParse({...input, main_size}).success).toBe(false);
	});
	it('sub_size defaults to 5 and accepts 0..25 only', () => {
		expect(GuildRosterEventCreateRequest.parse(input).sub_size).toBe(5);
		for (const sub_size of [0, 25])
			expect(GuildRosterEventCreateRequest.safeParse({...input, sub_size}).success).toBe(true);
		for (const sub_size of [-1, 26, 1.5])
			expect(GuildRosterEventCreateRequest.safeParse({...input, sub_size}).success).toBe(false);
	});
	it('mention_role_id may be null', () => {
		expect(GuildRosterEventCreateRequest.parse({...input, mention_role_id: null}).mention_role_id).toBeNull();
		expect(GuildRosterEventUpdateRequest.parse({mention_role_id: null})).toEqual({mention_role_id: null});
	});
	it('update needs at least one field', () => {
		expect(GuildRosterEventUpdateRequest.safeParse({}).success).toBe(false);
		expect(GuildRosterEventUpdateRequest.safeParse({unknown: true}).success).toBe(false);
		expect(GuildRosterEventUpdateRequest.parse({name: ' New '})).toEqual({name: 'New'});
	});
	it('event response carries no member list', () => {
		const response = GuildRosterEventResponse.parse({
			...input,
			id: '1490000000000000003',
			guild_id: '1490000000000000004',
			mention_role_id: null,
			main_size: 10,
			sub_size: 5,
			enabled: true,
			created_at: '2026-10-02T10:00:00Z',
			updated_at: '2026-10-02T10:00:00Z',
			members: ['private'],
			created_by: 'private',
		});
		expect(response).not.toHaveProperty('members');
		expect(response).not.toHaveProperty('created_by');
		expect(Object.keys(response).sort()).toEqual(
			[
				'id',
				'guild_id',
				'name',
				'voice_channel_id',
				'announce_channel_id',
				'mention_role_id',
				'main_size',
				'sub_size',
				'enabled',
				'created_at',
				'updated_at',
			].sort(),
		);
	});
});

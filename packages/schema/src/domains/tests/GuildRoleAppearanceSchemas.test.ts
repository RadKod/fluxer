// SPDX-License-Identifier: AGPL-3.0-or-later

import {GuildRoleCreateRequest, GuildRoleUpdateRequest} from '@fluxer/schema/src/domains/guild/GuildRequestSchemas';
import {GuildRoleResponse} from '@fluxer/schema/src/domains/guild/GuildRoleSchemas';
import {describe, expect, it} from 'vitest';

describe.each([
	['create', GuildRoleCreateRequest, {name: 'Role'}],
	['update', GuildRoleUpdateRequest, {}],
] as const)('role appearance %s request', (_name, schema, base) => {
	it('preserves omitted fields and explicit null clearing', () => {
		expect(schema.parse(base)).not.toHaveProperty('color_secondary');
		expect(schema.parse({...base, color_secondary: null, icon_emoji_id: null, unicode_emoji: null})).toMatchObject({
			color_secondary: null,
			icon_emoji_id: null,
			unicode_emoji: null,
		});
	});
	it.each([0, 0xffffff])('accepts secondary color boundary %i', (color_secondary) => {
		expect(schema.parse({...base, color_secondary})).toHaveProperty('color_secondary', color_secondary);
	});
	it.each([-1, 0x1000000, 1.5, 'red', 'linear-gradient(red, blue)'])(
		'rejects secondary color %j',
		(color_secondary) => {
			expect(schema.safeParse({...base, color_secondary}).success).toBe(false);
		},
	);
	it('accepts a single Unicode sequence or a snowflake emoji', () => {
		expect(schema.parse({...base, unicode_emoji: '👩‍💻'})).toHaveProperty('unicode_emoji', '👩‍💻');
		expect(schema.parse({...base, icon_emoji_id: '1234567890123456789'})).toHaveProperty(
			'icon_emoji_id',
			1234567890123456789n,
		);
	});
	it.each(['', 'hello', '🎉🎉'])('rejects invalid Unicode %j', (unicode_emoji) => {
		expect(schema.safeParse({...base, unicode_emoji}).success).toBe(false);
	});
	it('rejects two simultaneous icon sources', () => {
		expect(schema.safeParse({...base, unicode_emoji: '🎉', icon_emoji_id: '1234567890123456789'}).success).toBe(false);
	});
});

describe('role appearance response', () => {
	it('preserves nullable appearance and string snowflakes on the wire', () => {
		const base = {id: '20', name: 'Role', color: 0, position: 1, permissions: '0', hoist: false, mentionable: false};
		expect(
			GuildRoleResponse.parse({...base, color_secondary: 0, icon_emoji_id: '30', unicode_emoji: null}),
		).toMatchObject({
			color_secondary: 0,
			icon_emoji_id: '30',
			unicode_emoji: null,
		});
		expect(GuildRoleResponse.parse({...base, color_secondary: null, icon_emoji_id: null})).toMatchObject({
			color_secondary: null,
			icon_emoji_id: null,
		});
		expect(GuildRoleResponse.safeParse(base).success).toBe(true);
	});
});

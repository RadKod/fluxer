// SPDX-License-Identifier: AGPL-3.0-or-later

import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {
	GuildMemberUpdateRequest,
	MyGuildMemberUpdateRequest,
} from '@fluxer/schema/src/domains/guild/GuildRequestSchemas';
import {TemplateChannel} from '@fluxer/schema/src/domains/guild/GuildTemplateSchemas';
import {describe, expect, it} from 'vitest';

describe('GuildMemberUpdateRequest', () => {
	it.each(['sanalyer Destek', 'sanalyer Yetkili', 'ᴍɪᴄᴜᴘ Moderasyon'])(
		'rejects the nickname %s, which passes for an official sanalyer account',
		(nick) => {
			for (const schema of [GuildMemberUpdateRequest, MyGuildMemberUpdateRequest]) {
				expect(schema.safeParse({nick}).error?.issues[0]?.message).toBe(
					ValidationErrorCodes.GLOBAL_NAME_CANNOT_IMPERSONATE_MICUP,
				);
			}
		},
	);
	it.each(['Sunucu Yetkilisi', 'sanalyer sever', null, ''])('accepts the nickname %j', (nick) => {
		expect(MyGuildMemberUpdateRequest.safeParse({nick}).success).toBe(true);
	});
});

describe('TemplateChannel permission overwrites', () => {
	it.each([
		['role', 0],
		['member', 1],
		['0', 0],
		[1, 1],
		[42, 42],
	])('normalizes the imported overwrite type %j', (type, expected) => {
		const channel = TemplateChannel.parse({
			id: '1',
			type: 0,
			position: 0,
			permission_overwrites: [{id: '2', type, allow: '8', deny: '0'}],
		});
		expect(channel.permission_overwrites).toEqual([{id: '2', type: expected, allow: '8', deny: '0'}]);
	});

	it.each(['invalid', 'NaN', 'Infinity', Number.NaN, Number.POSITIVE_INFINITY])(
		'rejects nonfinite overwrite type %j',
		(type) => {
			expect(
				TemplateChannel.safeParse({
					id: '1',
					type: 0,
					position: 0,
					permission_overwrites: [{id: '2', type, allow: '8', deny: '0'}],
				}).success,
			).toBe(false);
		},
	);
});

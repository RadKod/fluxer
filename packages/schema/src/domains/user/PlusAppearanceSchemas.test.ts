// SPDX-License-Identifier: AGPL-3.0-or-later

import {NameStyleSchema, ThemeColorsSchema} from '@fluxer/schema/src/domains/user/PlusAppearanceSchemas';
import {UserUpdateRequest} from '@fluxer/schema/src/domains/user/UserRequestSchemas';
import {
	UserPartialResponse,
	UserPrivateResponse,
	UserProfileFullResponse,
} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {describe, expect, it} from 'vitest';

const partialUser = {
	id: '1300000000000000001',
	username: 'iğdır',
	discriminator: '0001',
	global_name: null,
	avatar: null,
	avatar_color: null,
	flags: 0,
};

describe('name_style', () => {
	it.each([
		{font_id: 6, colors: [0xffffff]},
		{font_id: 1, colors: [0xff5ea8, 0x7b5cff]},
		{font_id: 12, colors: [0, 0xffffff]},
	])('accepts %j in PATCH /users/@me', (nameStyle) => {
		expect(UserUpdateRequest.parse({name_style: nameStyle}).name_style).toEqual(nameStyle);
	});

	it('accepts null, which removes the style', () => {
		expect(UserUpdateRequest.parse({name_style: null}).name_style).toBeNull();
	});

	it.each([
		{font_id: 0, colors: [0xffffff]},
		{font_id: 13, colors: [0xffffff]},
		{font_id: 1.5, colors: [0xffffff]},
		{font_id: '1', colors: [0xffffff]},
		{font_id: 1, colors: []},
		{font_id: 1, colors: [1, 2, 3]},
		{font_id: 1, colors: [0x1000000]},
		{font_id: 1, colors: [-1]},
		{font_id: 1},
		{colors: [0xffffff]},
	])('rejects %j', (nameStyle) => {
		expect(UserUpdateRequest.safeParse({name_style: nameStyle}).success).toBe(false);
	});

	it('rides on the partial user, omitted or null when the user shows none', () => {
		const style = {font_id: 6, colors: [0xffffff, 0x7b5cff]};
		expect(UserPartialResponse.parse({...partialUser, name_style: style}).name_style).toEqual(style);
		expect(UserPartialResponse.parse({...partialUser, name_style: null}).name_style).toBeNull();
		expect(UserPartialResponse.parse(partialUser).name_style).toBeUndefined();
		expect(UserPrivateResponse.shape.name_style).toBe(UserPartialResponse.shape.name_style);
	});

	it('is one schema for the request and the responses', () => {
		expect(NameStyleSchema.safeParse({font_id: 3, colors: [0xffffff]}).success).toBe(true);
	});
});

describe('theme_colors', () => {
	it('accepts two colours or null in PATCH /users/@me', () => {
		expect(UserUpdateRequest.parse({theme_colors: [0x1e1b4b, 0x07a3b2]}).theme_colors).toEqual([0x1e1b4b, 0x07a3b2]);
		expect(UserUpdateRequest.parse({theme_colors: [0, 0xffffff]}).theme_colors).toEqual([0, 0xffffff]);
		expect(UserUpdateRequest.parse({theme_colors: null}).theme_colors).toBeNull();
	});

	it.each([[[]], [[0x1e1b4b]], [[1, 2, 3]], [[0x1000000, 0]], [[0, -1]], [['#1e1b4b', 0]]])(
		'rejects %j',
		(themeColors) => {
			expect(UserUpdateRequest.safeParse({theme_colors: themeColors}).success).toBe(false);
		},
	);

	it('is on the profile and the private user, never on the partial user', () => {
		const profileField = UserProfileFullResponse.shape.user_profile.shape.theme_colors;
		expect(profileField.parse([0x1e1b4b, 0x07a3b2])).toEqual([0x1e1b4b, 0x07a3b2]);
		expect(profileField.parse(null)).toBeNull();
		expect(profileField.safeParse([0x1e1b4b]).success).toBe(false);
		expect(UserPrivateResponse.shape.theme_colors.parse(null)).toBeNull();
		expect(UserPrivateResponse.shape.theme_colors.safeParse(undefined).success).toBe(false);
		expect(UserPartialResponse.shape).not.toHaveProperty('theme_colors');
	});

	it('is one schema for the request and the responses', () => {
		expect(ThemeColorsSchema.safeParse([1, 2]).success).toBe(true);
	});
});

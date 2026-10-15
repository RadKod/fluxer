// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	buildPlusAppearancePatch,
	DEFAULT_NAME_COLOR,
	DEFAULT_SECOND_NAME_COLOR,
	isNameStyleReadable,
	isUnreadableNameStyleChange,
	type PlusAppearanceValues,
	PROFILE_THEME_PRESETS,
	readPlusAppearance,
	readPlusAppearanceBaseline,
	resolvePlusAppearanceAccess,
	withNameColor,
	withNameColorMode,
	withNameFont,
	withThemeColor,
} from '@app/features/user/components/modals/tabs/my_profile_tab/PlusAppearanceForm';
import {isNameColorsReadableOnDark} from '@fluxer/constants/src/ColorContrast';
import type {NameStyle} from '@fluxer/schema/src/domains/user/PlusAppearanceSchemas';
import {describe, expect, it} from 'vitest';

const EMPTY: PlusAppearanceValues = {name_style: null, theme_colors: null};
const STYLED: PlusAppearanceValues = {
	name_style: {font_id: 3, colors: [0xff7ac6, 0xa78bfa]},
	theme_colors: [0x3b1d8f, 0x0f8f8a],
};
const FULL_ACCESS = {nameStyle: true, profileTheme: true};
const NO_ACCESS = {nameStyle: false, profileTheme: false};

describe('readPlusAppearance', () => {
	it('reads null for both fields when the user carries none', () => {
		expect(readPlusAppearance({nameStyle: null, themeColors: undefined})).toEqual(EMPTY);
		expect(readPlusAppearance(null)).toEqual(EMPTY);
	});

	it('reads the stored name style and theme colours', () => {
		expect(readPlusAppearance({nameStyle: STYLED.name_style, themeColors: STYLED.theme_colors})).toEqual(STYLED);
	});
});

describe('resolvePlusAppearanceAccess', () => {
	const PLUS_USER = {premiumType: 1, bot: false};

	it('unlocks each part from its own limit key', () => {
		const resolve = (key: string) => (key === 'feature_name_style' ? 1 : 0);
		expect(resolvePlusAppearanceAccess(resolve, PLUS_USER)).toEqual({nameStyle: true, profileTheme: false});
	});

	it('locks both parts for a free account', () => {
		expect(resolvePlusAppearanceAccess(() => 0, PLUS_USER)).toEqual(NO_ACCESS);
	});

	it.each([
		['a premium override without a premium type', {premiumType: 0, bot: false}],
		['no premium type at all', {premiumType: null, bot: false}],
		['a bot', {premiumType: 1, bot: true}],
		['no user', null],
	])('locks both parts for %s even when the limits allow them, as the server would never show them', (_name, user) => {
		expect(resolvePlusAppearanceAccess(() => 1, user)).toEqual(NO_ACCESS);
	});
});

describe('readPlusAppearanceBaseline', () => {
	it('reads the form defaults, with null for a field the form has none for', () => {
		expect(readPlusAppearanceBaseline(STYLED)).toEqual(STYLED);
		expect(readPlusAppearanceBaseline({})).toEqual(EMPTY);
		expect(readPlusAppearanceBaseline(undefined)).toEqual(EMPTY);
	});

	it('keeps a newer remote value when only another field of a dirty form is saved', () => {
		// The form was dirty when another device saved a new style, so its defaults still hold the old one.
		const formDefaults = {...STYLED, bio: 'old'};
		const draft: PlusAppearanceValues = {name_style: STYLED.name_style, theme_colors: STYLED.theme_colors};
		expect(buildPlusAppearancePatch(readPlusAppearanceBaseline(formDefaults), draft, FULL_ACCESS)).toEqual({});
	});
});

describe('isUnreadableNameStyleChange', () => {
	const UNREADABLE: NameStyle = {font_id: 1, colors: [0x333333]};

	it('blocks a changed name style that fails the contrast check', () => {
		expect(isUnreadableNameStyleChange(null, UNREADABLE)).toBe(true);
		expect(isUnreadableNameStyleChange({font_id: 2, colors: [0x333333]}, UNREADABLE)).toBe(true);
	});

	it('lets an unchanged stored style through, so other fields still save', () => {
		expect(isUnreadableNameStyleChange(UNREADABLE, {font_id: 1, colors: [0x333333]})).toBe(false);
	});

	it('lets a readable change and a reset through', () => {
		expect(isUnreadableNameStyleChange(UNREADABLE, {font_id: 1, colors: [0xffffff]})).toBe(false);
		expect(isUnreadableNameStyleChange(UNREADABLE, null)).toBe(false);
	});
});

describe('isNameStyleReadable', () => {
	it('treats no name style as readable', () => {
		expect(isNameStyleReadable(null)).toBe(true);
	});

	it('accepts a light solid colour and rejects a dark one', () => {
		expect(isNameStyleReadable({font_id: 1, colors: [0xffffff]})).toBe(true);
		expect(isNameStyleReadable({font_id: 1, colors: [0x333333]})).toBe(false);
	});

	it('rejects a gradient whose midpoint is too dark even when both ends pass', () => {
		expect(isNameStyleReadable({font_id: 1, colors: [0xff0000, 0x00ff00]})).toBe(false);
	});

	it('ships readable defaults', () => {
		expect(isNameColorsReadableOnDark([DEFAULT_NAME_COLOR, DEFAULT_SECOND_NAME_COLOR])).toBe(true);
	});
});

describe('buildPlusAppearancePatch', () => {
	it('sends nothing when nothing changed', () => {
		expect(buildPlusAppearancePatch(STYLED, structuredClone(STYLED), FULL_ACCESS)).toEqual({});
	});

	it('sends only the field that changed', () => {
		const draft: PlusAppearanceValues = {...STYLED, name_style: {font_id: 6, colors: [0xffffff]}};
		expect(buildPlusAppearancePatch(STYLED, draft, FULL_ACCESS)).toEqual({
			name_style: {font_id: 6, colors: [0xffffff]},
		});
		const themeDraft = {...STYLED, theme_colors: [0x111827, 0x4b5563] as [number, number]};
		expect(buildPlusAppearancePatch(STYLED, themeDraft, FULL_ACCESS)).toEqual({theme_colors: [0x111827, 0x4b5563]});
	});

	it('sends both fields together in one patch', () => {
		expect(buildPlusAppearancePatch(EMPTY, STYLED, FULL_ACCESS)).toEqual(STYLED);
	});

	it('sends null for a reset', () => {
		expect(buildPlusAppearancePatch(STYLED, EMPTY, FULL_ACCESS)).toEqual({name_style: null, theme_colors: null});
	});

	it('drops a locked value but always lets a reset through', () => {
		expect(buildPlusAppearancePatch(EMPTY, STYLED, NO_ACCESS)).toEqual({});
		expect(buildPlusAppearancePatch(STYLED, EMPTY, NO_ACCESS)).toEqual({name_style: null, theme_colors: null});
	});
});

describe('name style edits', () => {
	it('picking a font on an empty style starts with the default colour', () => {
		expect(withNameFont(null, 5)).toEqual({font_id: 5, colors: [DEFAULT_NAME_COLOR]});
	});

	it('picking a font keeps the colours', () => {
		expect(withNameFont({font_id: 1, colors: [1, 2]}, 9)).toEqual({font_id: 9, colors: [1, 2]});
	});

	it('switches between solid and gradient', () => {
		const solid: NameStyle = {font_id: 2, colors: [0xffffff]};
		expect(withNameColorMode(solid, 'gradient', 0x123456)).toEqual({font_id: 2, colors: [0xffffff, 0x123456]});
		expect(withNameColorMode({font_id: 2, colors: [1, 2]}, 'solid', 0)).toEqual({font_id: 2, colors: [1]});
		expect(withNameColorMode({font_id: 2, colors: [1, 2]}, 'gradient', 0)).toEqual({font_id: 2, colors: [1, 2]});
	});

	it('sets one colour by index', () => {
		expect(withNameColor({font_id: 2, colors: [1, 2]}, 1, 7)).toEqual({font_id: 2, colors: [1, 7]});
		expect(withNameColor({font_id: 2, colors: [1]}, 0, 7)).toEqual({font_id: 2, colors: [7]});
	});
});

describe('profile theme edits', () => {
	it('starts an empty theme from the first preset', () => {
		expect(withThemeColor(null, 1, 0xabcdef)).toEqual([PROFILE_THEME_PRESETS[0][0], 0xabcdef]);
	});

	it('sets one colour by index', () => {
		expect(withThemeColor([1, 2], 0, 9)).toEqual([9, 2]);
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	colorToHex,
	nameColorsClashInGuild,
	nameColorsClashWithRoles,
	resolveNameStyleView,
} from '@app/features/name_style/NameStyle';
import {nameStyleFontFamily, nameStyleFontKey} from '@app/features/name_style/NameStyleFonts';
import {deltaE2000} from '@fluxer/constants/src/ColorContrast';
import {NAME_STYLE_FONTS, type NameStyleFontId} from '@fluxer/constants/src/NameStyleConstants';
import nameStyleFontList from '@fluxer/fonts/name-styles.json';
import type {NameStyle} from '@fluxer/schema/src/domains/user/PlusAppearanceSchemas';
import {describe, expect, it} from 'vitest';

const PRESS_START: NameStyleFontId = 6;
const OUTSIDE_GUILD = {};

describe('colorToHex', () => {
	it('pads to six lower-case digits', () => {
		expect(colorToHex(0x7b5cff)).toBe('#7b5cff');
		expect(colorToHex(0x00ff00)).toBe('#00ff00');
		expect(colorToHex(0)).toBe('#000000');
	});
});

describe('name style fonts', () => {
	it('builds exactly the fonts the stored ids name, in the same order', () => {
		expect(nameStyleFontList.fonts.map((font) => font.id)).toEqual(NAME_STYLE_FONTS.map((font) => font.key));
	});

	it('maps a stored font id to its file key and CSS family', () => {
		expect(nameStyleFontKey(PRESS_START)).toBe('pressstart');
		expect(nameStyleFontKey(13)).toBeNull();
		expect(nameStyleFontFamily('pressstart')).toBe(`'Micup Name pressstart', var(--font-sans)`);
	});
});

describe('nameColorsClashWithRoles', () => {
	it('flags a colour closer than ΔE2000 15 to a role colour', () => {
		const red = 0xe74c3c;
		const nearRed = 0xe0533f;
		expect(deltaE2000(red, nearRed)).toBeLessThan(15);
		expect(nameColorsClashWithRoles([nearRed], [red])).toBe(true);
	});

	it('flags the second gradient colour too', () => {
		expect(nameColorsClashWithRoles([0x3dd9eb, 0xe0533f], [0xe74c3c])).toBe(true);
	});

	it('flags a gradient that passes through a role colour between its ends', () => {
		const red = 0xe74c3c;
		expect(deltaE2000(0xc09e10, red)).toBeGreaterThanOrEqual(15);
		expect(deltaE2000(0xf9046e, red)).toBeGreaterThanOrEqual(15);
		expect(deltaE2000(0xdd513f, red)).toBeLessThan(2);
		expect(nameColorsClashWithRoles([0xc09e10, 0xf9046e], [red])).toBe(true);
	});

	it('lets colours far from every role through', () => {
		const blue = 0x4f7cff;
		expect(deltaE2000(blue, 0xe74c3c)).toBeGreaterThanOrEqual(15);
		expect(nameColorsClashWithRoles([blue], [0xe74c3c, 0x2ecc71])).toBe(false);
		expect(nameColorsClashWithRoles([blue], [])).toBe(false);
	});
});

describe('nameColorsClashInGuild', () => {
	function countingRoles(colors: ReadonlyArray<number>) {
		const reads = {count: 0};
		const roles: Record<string, {color: number}> = {};
		colors.forEach((color, index) => {
			Object.defineProperty(roles, String(index), {
				enumerable: true,
				value: {
					get color() {
						reads.count += 1;
						return color;
					},
				},
			});
		});
		return {roles, reads};
	}

	it('ignores roles without a colour', () => {
		expect(nameColorsClashInGuild({everyone: {color: 0}}, [0x000001])).toBe(false);
	});

	it("flags a colour close to a role gradient's second colour", () => {
		const roles = {a: {color: 0x2ecc71, colorSecondary: 0xe74c3c}, b: {color: 0x3498db, colorSecondary: null}};
		expect(nameColorsClashInGuild(roles, [0xe0533f])).toBe(true);
		expect(nameColorsClashInGuild(roles, [0xffd23f])).toBe(false);
		expect(nameColorsClashInGuild({a: {color: 0, colorSecondary: 0xe74c3c}}, [0xe0533f])).toBe(false);
	});

	it('decides once per roles version and style', () => {
		const {roles, reads} = countingRoles([0xe74c3c, 0x2ecc71]);
		expect(nameColorsClashInGuild(roles, [0xe0533f])).toBe(true);
		const afterFirst = reads.count;
		expect(nameColorsClashInGuild(roles, [0xe0533f])).toBe(true);
		expect(nameColorsClashInGuild(roles, [0x4f7cff])).toBe(false);
		expect(reads.count).toBe(afterFirst);
	});

	it('decides again for a new roles version', () => {
		const style = [0xe0533f];
		expect(nameColorsClashInGuild({a: {color: 0x2ecc71}}, style)).toBe(false);
		expect(nameColorsClashInGuild({a: {color: 0x2ecc71}, b: {color: 0xe74c3c}}, style)).toBe(true);
	});
});

describe('resolveNameStyleView', () => {
	const style: NameStyle = {font_id: PRESS_START, colors: [0xff5ea8, 0x8b5cf6]};

	it('draws nothing without a style', () => {
		expect(resolveNameStyleView(null, OUTSIDE_GUILD)).toBeNull();
	});

	it('draws the font with one colour solid and two as a gradient', () => {
		const gradient = resolveNameStyleView(style, OUTSIDE_GUILD);
		expect(gradient?.fontKey).toBe('pressstart');
		expect(gradient?.fontFamily).toBe(nameStyleFontFamily('pressstart'));
		expect(gradient?.gradient).toEqual(['#ff5ea8', '#8b5cf6']);
		expect(gradient?.solid).toBeNull();
		expect(resolveNameStyleView({font_id: PRESS_START, colors: [0x112233]}, OUTSIDE_GUILD)?.solid).toBe('#112233');
	});

	it('keeps the colours of an unknown font and drops colours outside 0..0xFFFFFF', () => {
		const view = resolveNameStyleView({font_id: 99 as NameStyleFontId, colors: [0xff0000]}, OUTSIDE_GUILD);
		expect(view?.fontFamily).toBeNull();
		expect(view?.solid).toBe('#ff0000');
		expect(resolveNameStyleView({font_id: PRESS_START, colors: [-1, 0x1000000]}, OUTSIDE_GUILD)?.solid).toBeNull();
	});

	it('keeps only the font where a coloured role colours the name', () => {
		const view = resolveNameStyleView(style, {...OUTSIDE_GUILD, fontOnly: true});
		expect(view?.fontFamily).not.toBeNull();
		expect(view?.solid).toBeNull();
		expect(view?.gradient).toBeNull();
	});

	it('draws the default colour in a guild where a colour comes close to a coloured role', () => {
		const near = resolveNameStyleView(style, {...OUTSIDE_GUILD, guildRoles: {mod: {color: 0xff5aa5}}});
		expect(near?.fontFamily).not.toBeNull();
		expect(near?.gradient).toBeNull();
		const far = resolveNameStyleView(style, {...OUTSIDE_GUILD, guildRoles: {mod: {color: 0x2ecc71}}});
		expect(far?.gradient).toEqual(['#ff5ea8', '#8b5cf6']);
	});

	it('marks colours that fail 3:1 on the light theme so it draws the default colour there', () => {
		const pale = resolveNameStyleView({font_id: PRESS_START, colors: [0xe0f2fe, 0x7dd3fc]}, OUTSIDE_GUILD);
		expect(pale?.gradient).toEqual(['#e0f2fe', '#7dd3fc']);
		expect(pale?.defaultOnLight).toBe(true);
		const deep = resolveNameStyleView({font_id: PRESS_START, colors: [0x7b2ff7]}, OUTSIDE_GUILD);
		expect(deep?.solid).toBe('#7b2ff7');
		expect(deep?.defaultOnLight).toBe(false);
	});
});

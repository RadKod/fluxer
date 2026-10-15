// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {
	compositeOver,
	contrastRatio,
	nameReadsOnProfileTheme,
	profileGradientCssVars,
	profileThemeColors,
	readableTextOn,
	relativeLuminance,
	TEXT_DARK,
	TEXT_LIGHT,
} from '@app/features/user/utils/ProfileGradient';
import {describe, expect, it} from 'vitest';

// Every 5 % of the gradient, mixing the sRGB channels as the browser paints it.
function painted(colors: ReadonlyArray<number>): Array<number> {
	if (colors.length !== 2) return [...colors];
	const channel = (color: number, shift: number) => (color >> shift) & 0xff;
	return Array.from({length: 21}, (_, step) => {
		const mix = (shift: number) =>
			Math.round(channel(colors[0], shift) + (channel(colors[1], shift) - channel(colors[0], shift)) * (step / 20));
		return (mix(16) << 16) | (mix(8) << 8) | mix(0);
	});
}

function worstContrast(colors: ReadonlyArray<number>, result: ReturnType<typeof readableTextOn>): number {
	const scrimColor = result.text === TEXT_LIGHT ? TEXT_DARK : TEXT_LIGHT;
	return Math.min(
		...painted(colors).map((c) => contrastRatio(result.text, compositeOver(scrimColor, result.scrimAlpha, c))),
	);
}

describe('WCAG luminance and contrast', () => {
	it('matches the WCAG reference values', () => {
		expect(relativeLuminance(0xffffff)).toBeCloseTo(1, 5);
		expect(relativeLuminance(0x000000)).toBe(0);
		expect(contrastRatio(0xffffff, 0x000000)).toBeCloseTo(21, 5);
		expect(contrastRatio(0x777777, 0xffffff)).toBeCloseTo(4.48, 2);
	});

	it('is symmetric', () => {
		expect(contrastRatio(0x7b5cff, 0x1e1b4b)).toBeCloseTo(contrastRatio(0x1e1b4b, 0x7b5cff), 10);
	});
});

describe('readableTextOn', () => {
	it('puts light text on a dark pair without a scrim', () => {
		const result = readableTextOn([0x1e1b4b, 0x4c1d95]);
		expect(result.text).toBe(TEXT_LIGHT);
		expect(result.scrimAlpha).toBe(0);
		expect(result.contrast).toBeGreaterThanOrEqual(4.5);
	});

	it('puts dark text on a pastel pair without a scrim', () => {
		const result = readableTextOn([0xffd6e8, 0xd6e4ff]);
		expect(result.text).toBe(TEXT_DARK);
		expect(result.scrimAlpha).toBe(0);
		expect(result.contrast).toBeGreaterThanOrEqual(4.5);
	});

	it('handles a single colour', () => {
		expect(readableTextOn([0xffffff]).text).toBe(TEXT_DARK);
		expect(readableTextOn([0x000000]).text).toBe(TEXT_LIGHT);
	});

	it.each([
		[0xff5ea8, 0x7b5cff],
		[0xffff00, 0x0000ff],
		[0x00c2ff, 0xff7a00],
		[0x808080, 0x8a8a8a],
		[0x04e01c, 0xe71b82],
	])('reaches 4.5:1 along the whole gradient %s → %s, adding a scrim only when needed', (c1, c2) => {
		const result = readableTextOn([c1, c2]);
		expect(result.contrast).toBeGreaterThanOrEqual(4.5);
		expect(worstContrast([c1, c2], result)).toBeGreaterThanOrEqual(4.5);
		if (result.scrimAlpha > 0) {
			const unscrimmed = Math.max(
				worstContrast([c1, c2], {...result, text: TEXT_LIGHT, scrimAlpha: 0}),
				worstContrast([c1, c2], {...result, text: TEXT_DARK, scrimAlpha: 0}),
			);
			expect(unscrimmed).toBeLessThan(4.5);
		}
	});

	it('needs a scrim for yellow to blue, where no plain text colour works on both ends', () => {
		expect(readableTextOn([0xffff00, 0x0000ff]).scrimAlpha).toBeGreaterThan(0);
	});
});

describe('profileGradientCssVars', () => {
	it('writes the colours, the text colour and the scrim as CSS variables', () => {
		const vars = profileGradientCssVars([0x1e1b4b, 0x07a3b2]);
		expect(vars['--profile-gradient-1']).toBe('#1e1b4b');
		expect(vars['--profile-gradient-2']).toBe('#07a3b2');
		expect(vars['--profile-gradient-text']).toMatch(/^#[0-9a-f]{6}$/);
		expect(vars['--profile-gradient-scrim']).toMatch(/^rgb\(\d+ \d+ \d+ \/ [\d.]+\)$/);
		expect(vars['--profile-gradient-veil']).toMatch(/^rgb\(\d+ \d+ \d+ \/ [\d.]+\)$/);
	});

	it('veils the card only as much as the text needs', () => {
		expect(profileGradientCssVars([0x1e1b4b, 0x4c1d95])['--profile-gradient-veil']).toMatch(/\/ 0\)$/);
		const needed = readableTextOn([0xffff00, 0x0000ff]).scrimAlpha;
		expect(profileGradientCssVars([0xffff00, 0x0000ff])['--profile-gradient-veil']).toMatch(
			new RegExp(`/ ${needed}\\)$`),
		);
	});
});

describe('profileThemeColors', () => {
	const own: [number, number] = [0x3b1d8f, 0x0f8f8a];
	const fetched: [number, number] = [0xff7a59, 0x7a1e4f];

	it("takes the signed-in user's own colours from the private user, even when they are cleared", () => {
		expect(profileThemeColors({themeColors: own}, {userProfile: {theme_colors: fetched}})).toEqual(own);
		expect(profileThemeColors({themeColors: null}, {userProfile: {theme_colors: fetched}})).toBeNull();
	});

	it("takes anyone else's colours from their profile", () => {
		expect(profileThemeColors({themeColors: undefined}, {userProfile: {theme_colors: fetched}})).toEqual(fetched);
		expect(profileThemeColors({themeColors: undefined}, {userProfile: {}})).toBeNull();
		expect(profileThemeColors({themeColors: undefined}, null)).toBeNull();
		expect(profileThemeColors(null, null)).toBeNull();
	});
});

describe('nameReadsOnProfileTheme', () => {
	const PASTEL: [number, number] = [0xfbcfe8, 0xc4b5fd];
	const SLATE: [number, number] = [0x111827, 0x4b5563];

	it('drops a white name on a pastel theme, where the card text turns dark', () => {
		expect(readableTextOn(PASTEL).text).toBe(TEXT_DARK);
		expect(nameReadsOnProfileTheme({font_id: 1, colors: [0xffffff]}, PASTEL)).toBe(false);
	});

	it('keeps a white name on a dark theme', () => {
		expect(nameReadsOnProfileTheme({font_id: 1, colors: [0xffffff]}, SLATE)).toBe(true);
	});

	it('checks the whole name gradient', () => {
		expect(nameReadsOnProfileTheme({font_id: 1, colors: [0xffffff, 0x4b5563]}, SLATE)).toBe(false);
	});

	it('keeps any name without a theme and has nothing to drop without a name style', () => {
		expect(nameReadsOnProfileTheme({font_id: 1, colors: [0xffffff]}, null)).toBe(true);
		expect(nameReadsOnProfileTheme(null, PASTEL)).toBe(true);
	});
});

describe('profile theme inside the coal and dark card rules', () => {
	const coalBlock = (file: string, selector: string): string => {
		const css = readFileSync(`src/features/user/components/profile/${file}`, 'utf8');
		const start = css.indexOf(`:global(html:is(.theme-coal, .theme-dark)) ${selector} {`);
		expect(start).toBeGreaterThanOrEqual(0);
		return css.slice(start, css.indexOf('}', start));
	};

	it('keeps the themed avatar ring see-through, the card surface otherwise', () => {
		const ring = coalBlock('profile_card/ProfileCardBanner.module.css', '.avatarButton');
		expect(ring).toContain('border-color: var(--profile-card-avatar-ring, var(--background-secondary-alt));');
		expect(ring).toContain('background-color: var(--profile-card-avatar-ring, var(--background-secondary-alt));');
	});

	it('puts the voice card on the theme scrim, the hover well otherwise', () => {
		expect(coalBlock('VoiceActivityCard.module.css', '.card')).toContain(
			'background-color: var(--profile-panel-background, var(--background-modifier-hover));',
		);
	});
});

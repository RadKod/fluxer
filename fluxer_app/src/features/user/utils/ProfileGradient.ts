// SPDX-License-Identifier: AGPL-3.0-or-later

import {colorToHex} from '@app/features/name_style/NameStyle';
import {
	contrastRatio,
	gradientSamples,
	isNameColorsReadableOn,
	NAME_COLOR_MIN_CONTRAST,
} from '@fluxer/constants/src/ColorContrast';
import type {NameStyle, ThemeColors} from '@fluxer/schema/src/domains/user/PlusAppearanceSchemas';

export {contrastRatio, relativeLuminance} from '@fluxer/constants/src/ColorContrast';

export const TEXT_LIGHT = 0xffffff;
export const TEXT_DARK = 0x0c0c0f;
const MIN_CONTRAST = 4.5;
const SCRIM_STEP = 0.05;
const SCRIM_MAX = 0.9;

function channel(color: number, shift: number): number {
	return (color >> shift) & 0xff;
}

export function compositeOver(top: number, alpha: number, bottom: number): number {
	const mix = (shift: number) => Math.round(channel(top, shift) * alpha + channel(bottom, shift) * (1 - alpha));
	return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

function worst(text: number, backgrounds: ReadonlyArray<number>): number {
	return Math.min(...backgrounds.map((background) => contrastRatio(text, background)));
}

export interface ReadableText {
	text: number;
	scrimAlpha: number;
	contrast: number;
}

// Picks the text colour with the better worst-case contrast over the gradient; when neither reaches 4.5:1, finds the
// lightest scrim (dark under light text, light under dark text) that does.
export function readableTextOn(colors: ReadonlyArray<number>): ReadableText {
	const backgrounds = gradientSamples(colors);
	const light = worst(TEXT_LIGHT, backgrounds);
	const dark = worst(TEXT_DARK, backgrounds);
	const text = light >= dark ? TEXT_LIGHT : TEXT_DARK;
	let contrast = Math.max(light, dark);
	if (contrast >= MIN_CONTRAST) return {text, scrimAlpha: 0, contrast};
	const scrim = text === TEXT_LIGHT ? TEXT_DARK : TEXT_LIGHT;
	let alpha = 0;
	while (contrast < MIN_CONTRAST && alpha < SCRIM_MAX) {
		alpha = Math.round((alpha + SCRIM_STEP) * 100) / 100;
		contrast = worst(
			text,
			backgrounds.map((background) => compositeOver(scrim, alpha, background)),
		);
	}
	return {text, scrimAlpha: alpha, contrast};
}

export type ProfileGradientCssVars = Record<
	| '--profile-gradient-1'
	| '--profile-gradient-2'
	| '--profile-gradient-text'
	| '--profile-gradient-veil'
	| '--profile-gradient-scrim',
	string
>;

const PANEL_SCRIM_ALPHA = 0.24;

function rgba(color: number, alpha: number): string {
	return `rgb(${channel(color, 16)} ${channel(color, 8)} ${channel(color, 0)} / ${alpha})`;
}

// veil: laid over the whole gradient, exactly what the text needs (often nothing). scrim: the inner panel, always a
// little stronger so it reads as a surface.
export function profileGradientCssVars(colors: readonly [number, number]): ProfileGradientCssVars {
	const {text, scrimAlpha} = readableTextOn(colors);
	const scrim = text === TEXT_LIGHT ? TEXT_DARK : TEXT_LIGHT;
	return {
		'--profile-gradient-1': colorToHex(colors[0]),
		'--profile-gradient-2': colorToHex(colors[1]),
		'--profile-gradient-text': colorToHex(text),
		'--profile-gradient-veil': rgba(scrim, scrimAlpha),
		'--profile-gradient-scrim': rgba(scrim, PANEL_SCRIM_ALPHA),
	};
}

// Every gradient sample under the veil, bare and under the panel scrim: the backgrounds a name on the card can sit on.
function profileThemeBackgrounds(colors: ThemeColors): Array<number> {
	const {text, scrimAlpha} = readableTextOn(colors);
	const scrim = text === TEXT_LIGHT ? TEXT_DARK : TEXT_LIGHT;
	return gradientSamples(colors).flatMap((sample) => {
		const veiled = compositeOver(scrim, scrimAlpha, sample);
		return [veiled, compositeOver(scrim, PANEL_SCRIM_ALPHA, veiled)];
	});
}

// A name on a profile theme keeps its colours only when they read on the whole card; otherwise it takes the card's
// text colour, which always does.
export function nameReadsOnProfileTheme(
	nameStyle: NameStyle | null | undefined,
	themeColors: ThemeColors | null | undefined,
): boolean {
	if (!nameStyle || !themeColors) return true;
	return isNameColorsReadableOn(nameStyle.colors, profileThemeBackgrounds(themeColors), NAME_COLOR_MIN_CONTRAST);
}

// The signed-in user's own colours come with the private user and change live; everyone else's come with the profile.
export function profileThemeColors(
	user: {readonly themeColors?: ThemeColors | null} | null | undefined,
	profile: {readonly userProfile?: {readonly theme_colors?: ThemeColors | null}} | null | undefined,
): ThemeColors | null {
	if (user?.themeColors !== undefined) return user.themeColors;
	return profile?.userProfile?.theme_colors ?? null;
}

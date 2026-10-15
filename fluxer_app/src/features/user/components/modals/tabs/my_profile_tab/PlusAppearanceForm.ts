// SPDX-License-Identifier: AGPL-3.0-or-later

import type {User} from '@app/features/user/models/User';
import {isNameColorsReadableOnDark} from '@fluxer/constants/src/ColorContrast';
import type {LimitKey} from '@fluxer/constants/src/LimitConfigMetadata';
import type {NameStyleFontId} from '@fluxer/constants/src/NameStyleConstants';
import type {NameStyle, ThemeColors} from '@fluxer/schema/src/domains/user/PlusAppearanceSchemas';

export type NameColorMode = 'solid' | 'gradient';

export interface PlusAppearanceValues {
	name_style: NameStyle | null;
	theme_colors: ThemeColors | null;
}

export interface PlusAppearanceAccess {
	nameStyle: boolean;
	profileTheme: boolean;
}

export const DEFAULT_NAME_COLOR = 0xffffff;
export const DEFAULT_SECOND_NAME_COLOR = 0xa78bfa;

// Top colour, then bottom colour.
export const PROFILE_THEME_PRESETS: ReadonlyArray<ThemeColors> = [
	[0x3b1d8f, 0x0f8f8a],
	[0x1e3a8a, 0x9333ea],
	[0xbe185d, 0xf59e0b],
	[0x064e3b, 0x10b981],
	[0x111827, 0x4b5563],
	[0xfbcfe8, 0xc4b5fd],
];

export function readPlusAppearance(user: Pick<User, 'nameStyle' | 'themeColors'> | null): PlusAppearanceValues {
	return {name_style: user?.nameStyle ?? null, theme_colors: user?.themeColors ?? null};
}

// The server saves a style only for an account that would show it: a premium type and not a bot (the private user
// already reports no premium type while the perks are off).
export function resolvePlusAppearanceAccess(
	resolve: (key: LimitKey) => number,
	user: Pick<User, 'premiumType' | 'bot'> | null,
): PlusAppearanceAccess {
	const shown = (user?.premiumType ?? 0) > 0 && !user?.bot;
	return {
		nameStyle: shown && resolve('feature_name_style') > 0,
		profileTheme: shown && resolve('feature_profile_theme') > 0,
	};
}

// The form's defaults are the values it last took from the server; the patch compares against them, not the live
// user, so a field the form did not touch never overwrites a newer value saved elsewhere.
export function readPlusAppearanceBaseline(
	defaults: {readonly name_style?: unknown; readonly theme_colors?: unknown} | undefined,
): PlusAppearanceValues {
	return {
		name_style: (defaults?.name_style ?? null) as NameStyle | null,
		theme_colors: (defaults?.theme_colors ?? null) as ThemeColors | null,
	};
}

export function isNameStyleReadable(nameStyle: NameStyle | null): boolean {
	return nameStyle === null || isNameColorsReadableOnDark(nameStyle.colors);
}

// Only a changed style is checked: a stored one is not sent again, so it never blocks saving other fields.
export function isUnreadableNameStyleChange(baseline: NameStyle | null, draft: NameStyle | null): boolean {
	return !sameNameStyle(baseline, draft) && !isNameStyleReadable(draft);
}

function sameColors(a: ReadonlyArray<number> | null, b: ReadonlyArray<number> | null): boolean {
	if (a === null || b === null) return a === b;
	return a.length === b.length && a.every((color, index) => color === b[index]);
}

function sameNameStyle(a: NameStyle | null, b: NameStyle | null): boolean {
	if (a === null || b === null) return a === b;
	return a.font_id === b.font_id && sameColors(a.colors, b.colors);
}

// Only changed fields go out. A locked part never sends a value the server would reject, but clearing it (null) is
// always allowed.
export function buildPlusAppearancePatch(
	remote: PlusAppearanceValues,
	draft: PlusAppearanceValues,
	access: PlusAppearanceAccess,
): Partial<PlusAppearanceValues> {
	const patch: Partial<PlusAppearanceValues> = {};
	if (!sameNameStyle(remote.name_style, draft.name_style) && (access.nameStyle || draft.name_style === null)) {
		patch.name_style = draft.name_style;
	}
	if (!sameColors(remote.theme_colors, draft.theme_colors) && (access.profileTheme || draft.theme_colors === null)) {
		patch.theme_colors = draft.theme_colors;
	}
	return patch;
}

export function withNameFont(nameStyle: NameStyle | null, fontId: NameStyleFontId): NameStyle {
	return {font_id: fontId, colors: nameStyle?.colors ?? [DEFAULT_NAME_COLOR]};
}

export function withNameColorMode(nameStyle: NameStyle, mode: NameColorMode, secondColor: number): NameStyle {
	const [first, second] = nameStyle.colors;
	return {...nameStyle, colors: mode === 'solid' ? [first] : [first, second ?? secondColor]};
}

export function withNameColor(nameStyle: NameStyle, index: 0 | 1, color: number): NameStyle {
	const colors = [...nameStyle.colors];
	colors[index] = color;
	return {...nameStyle, colors};
}

export function withThemeColor(themeColors: ThemeColors | null, index: 0 | 1, color: number): ThemeColors {
	const next: ThemeColors = [...(themeColors ?? PROFILE_THEME_PRESETS[0])];
	next[index] = color;
	return next;
}

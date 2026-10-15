// SPDX-License-Identifier: AGPL-3.0-or-later

import {nameStyleFontFamily, nameStyleFontKey} from '@app/features/name_style/NameStyleFonts';
import {
	isNameColorsReadableOnLight,
	type Lab,
	labDeltaE2000,
	NAME_COLOR_ROLE_MIN_DELTA_E,
	paintedNameColors,
	srgbToLab,
} from '@fluxer/constants/src/ColorContrast';
import type {NameStyle} from '@fluxer/schema/src/domains/user/PlusAppearanceSchemas';

export interface NameStyleView {
	fontKey: string | null;
	fontFamily: string | null;
	solid: string | null;
	gradient: readonly [string, string] | null;
	// The colours fail 3:1 on the light theme, which then draws the surface's default colour (a CSS rule on
	// html.theme-light, so a theme switch re-renders nothing).
	defaultOnLight: boolean;
}

export type GuildRoleColors = Readonly<
	Record<string, {readonly color: number; readonly colorSecondary?: number | null}>
>;

export interface NameStyleContext {
	// The surface keeps its own colour (a profile theme the colours cannot be read on); only the font is drawn.
	fontOnly?: boolean;
	// The roles of the guild the name is drawn in; outside a guild the whole style is drawn.
	guildRoles?: GuildRoleColors;
}

const MAX_DECISIONS_PER_ROLES_VERSION = 2048;

export function colorToHex(color: number): string {
	return `#${color.toString(16).padStart(6, '0')}`;
}

function isColor(value: number): boolean {
	return Number.isInteger(value) && value >= 0 && value <= 0xffffff;
}

// Every colour the name paints, along the whole gradient: one can pass through a role colour between its ends.
function clashes(colors: ReadonlyArray<number>, roleLabs: ReadonlyArray<Lab>): boolean {
	if (roleLabs.length === 0) return false;
	return paintedNameColors(colors).some((color) => {
		const lab = srgbToLab(color);
		return roleLabs.some((role) => labDeltaE2000(lab, role) < NAME_COLOR_ROLE_MIN_DELTA_E);
	});
}

// A name colour this close to a coloured role could pass for that role, a moderator's red for one.
export function nameColorsClashWithRoles(colors: ReadonlyArray<number>, roleColors: ReadonlyArray<number>): boolean {
	return clashes(colors, roleColors.map(srgbToLab));
}

interface RoleColorDecisions {
	roleLabs: ReadonlyArray<Lab>;
	byColors: Map<string, boolean>;
}

// Keyed on the guild's roles record: the guild model replaces the record whenever the guild changes, so a new record is
// the next role version and the old decisions are collected with the old record.
const decisionsByRoles = new WeakMap<GuildRoleColors, RoleColorDecisions>();

export function nameColorsClashInGuild(roles: GuildRoleColors, colors: ReadonlyArray<number>): boolean {
	let decisions = decisionsByRoles.get(roles);
	if (!decisions) {
		const roleColors = new Set<number>();
		for (const role of Object.values(roles)) {
			if (!role.color) continue;
			roleColors.add(role.color);
			if (role.colorSecondary != null) roleColors.add(role.colorSecondary);
		}
		decisions = {roleLabs: [...roleColors].map(srgbToLab), byColors: new Map()};
		decisionsByRoles.set(roles, decisions);
	}
	const key = colors.join(',');
	let clash = decisions.byColors.get(key);
	if (clash === undefined) {
		clash = clashes(colors, decisions.roleLabs);
		if (decisions.byColors.size >= MAX_DECISIONS_PER_ROLES_VERSION) decisions.byColors.clear();
		decisions.byColors.set(key, clash);
	}
	return clash;
}

// The font always shows. The colours give way to the surface's own colour where the surface asks for the font alone
// and where they could pass for a coloured role of the guild; on the light theme also when they fail 3:1 there.
export function resolveNameStyleView(style: NameStyle | null, context: NameStyleContext): NameStyleView | null {
	if (!style) return null;
	const fontKey = nameStyleFontKey(style.font_id);
	const colors = style.colors.filter(isColor).slice(0, 2);
	const defaultColor =
		colors.length === 0 ||
		context.fontOnly === true ||
		(context.guildRoles !== undefined && nameColorsClashInGuild(context.guildRoles, colors));
	const hex = defaultColor ? [] : colors.map(colorToHex);
	if (fontKey === null && hex.length === 0) return null;
	return {
		fontKey,
		fontFamily: fontKey === null ? null : nameStyleFontFamily(fontKey),
		solid: hex.length === 1 ? hex[0] : null,
		gradient: hex.length === 2 ? [hex[0], hex[1]] : null,
		defaultOnLight: hex.length > 0 && !isNameColorsReadableOnLight(colors),
	};
}

// SPDX-License-Identifier: AGPL-3.0-or-later

import {NAME_STYLE_FONTS} from '@fluxer/constants/src/NameStyleConstants';
import {ColorType, createInt32EnumType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

export const NameStyleFontIdType = createInt32EnumType(
	NAME_STYLE_FONTS.map(({id, key, family}) => [id, key.toUpperCase(), family] as const),
	'The name font; ids are stable and never reused',
	'NameStyleFontId',
);

export const NameStyleSchema = z
	.object({
		font_id: NameStyleFontIdType,
		colors: z.array(ColorType).min(1).max(2).describe('One colour for a solid name, two for a gradient'),
	})
	.describe('The name font and colour');

export type NameStyle = z.infer<typeof NameStyleSchema>;

export const ThemeColorsSchema = z
	.tuple([ColorType, ColorType])
	.describe('The profile card gradient, top colour then bottom colour');

export type ThemeColors = z.infer<typeof ThemeColorsSchema>;

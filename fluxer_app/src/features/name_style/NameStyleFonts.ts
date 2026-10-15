// SPDX-License-Identifier: AGPL-3.0-or-later

import {NAME_STYLE_FONTS} from '@fluxer/constants/src/NameStyleConstants';

const FONT_KEYS: ReadonlyMap<number, string> = new Map(NAME_STYLE_FONTS.map(({id, key}) => [id, key]));

// The stored font_id to the key that names the font's files (packages/fonts/name-styles.json); null for an id this
// client does not know yet.
export function nameStyleFontKey(fontId: number): string | null {
	return FONT_KEYS.get(fontId) ?? null;
}

export function nameStyleFontFamily(fontKey: string): string {
	return `'sanalyer Name ${fontKey}', var(--font-sans)`;
}

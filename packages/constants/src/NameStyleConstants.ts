// SPDX-License-Identifier: AGPL-3.0-or-later

// Name style fonts. `id` is the stored font_id: never renumber or reuse one; a dropped font keeps its id retired.
// `key` names the font's files in packages/fonts/name-styles.json.
export const NAME_STYLE_FONTS = [
	{id: 1, key: 'baloo', family: 'Baloo 2'},
	{id: 2, key: 'playpen', family: 'Playpen Sans'},
	{id: 3, key: 'pacifico', family: 'Pacifico'},
	{id: 4, key: 'caveat', family: 'Caveat'},
	{id: 5, key: 'pixelify', family: 'Pixelify Sans'},
	{id: 6, key: 'pressstart', family: 'Press Start 2P'},
	{id: 7, key: 'vt323', family: 'VT323'},
	{id: 8, key: 'audiowide', family: 'Audiowide'},
	{id: 9, key: 'grenze', family: 'Grenze Gotisch'},
	{id: 10, key: 'newrocker', family: 'New Rocker'},
	{id: 11, key: 'bungee', family: 'Bungee'},
	{id: 12, key: 'righteous', family: 'Righteous'},
] as const;

export type NameStyleFont = (typeof NAME_STYLE_FONTS)[number];
export type NameStyleFontId = NameStyleFont['id'];

const FONT_IDS: ReadonlySet<number> = new Set(NAME_STYLE_FONTS.map(({id}) => id));

export function isNameStyleFontId(value: number): value is NameStyleFontId {
	return FONT_IDS.has(value);
}

// SPDX-License-Identifier: AGPL-3.0-or-later

import {isNameStyleFontId, NAME_STYLE_FONTS} from '@fluxer/constants/src/NameStyleConstants';
import {describe, expect, it} from 'vitest';

describe('NAME_STYLE_FONTS', () => {
	// font_id is stored on the user row: an id never moves to another font and is never reused.
	it('keeps every font on its stored id', () => {
		expect(NAME_STYLE_FONTS.map(({id, key, family}) => [id, key, family])).toEqual([
			[1, 'baloo', 'Baloo 2'],
			[2, 'playpen', 'Playpen Sans'],
			[3, 'pacifico', 'Pacifico'],
			[4, 'caveat', 'Caveat'],
			[5, 'pixelify', 'Pixelify Sans'],
			[6, 'pressstart', 'Press Start 2P'],
			[7, 'vt323', 'VT323'],
			[8, 'audiowide', 'Audiowide'],
			[9, 'grenze', 'Grenze Gotisch'],
			[10, 'newrocker', 'New Rocker'],
			[11, 'bungee', 'Bungee'],
			[12, 'righteous', 'Righteous'],
		]);
	});

	it('has unique ids and keys', () => {
		expect(new Set(NAME_STYLE_FONTS.map(({id}) => id)).size).toBe(NAME_STYLE_FONTS.length);
		expect(new Set(NAME_STYLE_FONTS.map(({key}) => key)).size).toBe(NAME_STYLE_FONTS.length);
	});
});

describe('isNameStyleFontId', () => {
	it('accepts the listed ids only', () => {
		for (const {id} of NAME_STYLE_FONTS) expect(isNameStyleFontId(id)).toBe(true);
		for (const id of [0, 13, -1, 1.5, Number.NaN]) expect(isNameStyleFontId(id)).toBe(false);
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {isReservedVanityCode} from '@fluxer/schema/src/primitives/MicupBrandGuard';
import {describe, expect, it} from 'vitest';

describe('isReservedVanityCode app paths', () => {
	it.each(['bots', 'docs'])('refuses %s so a short invite cannot shadow the path', (code) => {
		expect(isReservedVanityCode(code)).toBe(true);
	});

	it('refuses indir, the desktop download redirect on micup.gg', () => {
		expect(isReservedVanityCode('indir')).toBe(true);
	});

	it('accepts a code that only starts with indir', () => {
		expect(isReservedVanityCode('indirim')).toBe(false);
	});

	it('refuses download, which the edge sends to the download page', () => {
		expect(isReservedVanityCode('download')).toBe(true);
	});

	it('accepts a code that only starts with download', () => {
		expect(isReservedVanityCode('downloads')).toBe(false);
	});

	it.each(['premium', 'shop'])('refuses %s, a page of the app beside the DM list', (code) => {
		expect(isReservedVanityCode(code)).toBe(true);
	});

	it.each(['premiumlar', 'shopping'])('accepts %s, which only starts with an app page', (code) => {
		expect(isReservedVanityCode(code)).toBe(false);
	});
});

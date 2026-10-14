// SPDX-License-Identifier: AGPL-3.0-or-later

import {isReservedVanityCode} from '@fluxer/schema/src/primitives/MicupBrandGuard';
import {describe, expect, it} from 'vitest';

describe('isReservedVanityCode', () => {
	it.each([
		['m1cup', 'digit look-alike of the brand'],
		['rnicup', 'rn read as m'],
		['mi-cup', 'brand split by a hyphen'],
		['micupdestek', 'brand inside the code'],
		['resmidestek', 'official words run together'],
		['destekekibi', 'official word followed by more text'],
		['supp0rt', 'digit look-alike of an official word'],
		['0fficia1', 'several digit look-alikes, 1 read as l'],
		['adm1n', '1 read as i'],
		['yonetirn', 'rn read as m in an official word'],
		['m0derator', 'long moderator word'],
		['epha', 'founder name'],
		['ephax', 'founder handle'],
		['epha1', 'founder name with a digit'],
		['e-pha', 'founder name split by a hyphen'],
		['resmi-destek', 'official words as parts'],
		['mod', 'short word as the whole code'],
		['oyun-m0d', 'short word as a part'],
		['badmintonadmin', 'official word next to a word that hosts it'],
		// Accepted side effect: an ordinary word that contains an official word is refused too.
		['ekipler', 'ordinary word containing ekip'],
		['login', 'app path'],
		['marketing', 'static prefix of the app proxy'],
		['feed', 'feed page of the app'],
	])('refuses %s (%s)', (code) => {
		expect(isReservedVanityCode(code)).toBe(true);
	});

	it.each([
		['oyuncular', 'ordinary word'],
		['badminton', 'hosts admin but reads as the sport'],
		['stephan', 'contains epha but does not start with it'],
		['cephane', 'contains epha but does not start with it'],
		['modern', 'starts with the short word mod'],
		['moda', 'starts with the short word mod'],
		['loginler', 'app paths match only as the whole code'],
		['l0gin', 'app paths are not folded'],
		['duyurular', 'staff words guard display names only'],
		['oyunsistemi', 'staff words guard display names only'],
	])('accepts %s (%s)', (code) => {
		expect(isReservedVanityCode(code)).toBe(false);
	});
});

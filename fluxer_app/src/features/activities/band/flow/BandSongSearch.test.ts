// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandSongSummary} from '@app/features/activities/band/BandProtocol';
import {foldSongText, searchSongs} from '@app/features/activities/band/flow/BandSongSearch';
import {describe, expect, it} from 'vitest';

function song(id: string, name: string, artist: string): BandSongSummary {
	return {
		id,
		name,
		artist,
		lengthMs: 1,
		parts: {},
		stems: false,
		coverUrl: null,
		packageUrl: '',
		packageBytes: 0,
		addedBy: null,
		groups: [],
		genre: null,
		year: null,
		previewStartMs: null,
	};
}

const LIBRARY = [
	song('araf', 'Araf', 'mor ve Ötesi'),
	song('isik', 'IŞIK', 'Duman'),
	song('istanbul', 'İstanbul', 'Duman'),
	song('ben', 'Ben Şarkımı Söylerken', 'Şebnem Ferah'),
	song('deli', 'Deli', 'mor ve Ötesi'),
	song('gibi', 'Duman Gibi', 'Ceza'),
];

describe('foldSongText', () => {
	it('folds Turkish capitals and drops the marks', () => {
		expect(foldSongText('İSTANBUL')).toBe('istanbul');
		expect(foldSongText('IŞIK')).toBe('isik');
		expect(foldSongText('Şarkımı Söylerken')).toBe('sarkimi soylerken');
	});
});

describe('searchSongs', () => {
	it('returns the whole library for an empty query', () => {
		expect(searchSongs(LIBRARY, '  ')).toHaveLength(LIBRARY.length);
	});

	it('matches with or without Turkish letters and casing', () => {
		expect(searchSongs(LIBRARY, 'ışık').map((entry) => entry.id)).toEqual(['isik']);
		expect(searchSongs(LIBRARY, 'istan').map((entry) => entry.id)).toEqual(['istanbul']);
		expect(searchSongs(LIBRARY, 'sarkimi').map((entry) => entry.id)).toEqual(['ben']);
	});

	it('lists name matches before artist matches', () => {
		expect(searchSongs(LIBRARY, 'duman').map((entry) => entry.id)).toEqual(['gibi', 'isik', 'istanbul']);
		expect(searchSongs(LIBRARY, 'MOR VE').map((entry) => entry.id)).toEqual(['araf', 'deli']);
	});
});

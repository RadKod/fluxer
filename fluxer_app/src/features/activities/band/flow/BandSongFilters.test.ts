// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandGenreGroup, BandSongSummary} from '@app/features/activities/band/BandProtocol';
import {
	decadeOf,
	filterSongs,
	groupCounts,
	NO_SONG_FILTER,
	randomSong,
} from '@app/features/activities/band/flow/BandSongFilters';
import {describe, expect, it} from 'vitest';

function song(
	id: string,
	groups: ReadonlyArray<BandGenreGroup>,
	year: number | null,
	artist = 'Artist',
): BandSongSummary {
	return {
		id,
		name: id,
		artist,
		lengthMs: 1,
		parts: {},
		stems: false,
		coverUrl: null,
		packageUrl: '',
		packageBytes: 0,
		addedBy: null,
		groups,
		genre: null,
		year,
		previewStartMs: null,
	};
}

const LIBRARY = [
	song('Araf', ['turkce', 'rock'], 2004, 'mor ve Ötesi'),
	song('Paranoid', ['rock', 'metal'], 1970, 'Black Sabbath'),
	song('Numb', ['alternatif', 'rock'], 2003, 'Linkin Park'),
	song('Take On Me', ['pop'], 1985, 'a-ha'),
	song('Uptown Funk', ['pop'], 2014, 'Mark Ronson'),
	song('Old Kind', ['country'], 1969, 'Someone'),
	song('Unshelved', [], null),
];

const ids = (songs: ReadonlyArray<BandSongSummary>) => songs.map((entry) => entry.id);

describe('decadeOf', () => {
	it('puts years on the chips and folds 2010 onwards into the last one', () => {
		expect(decadeOf(1970)).toBe(1970);
		expect(decadeOf(1979)).toBe(1970);
		expect(decadeOf(1999)).toBe(1990);
		expect(decadeOf(2010)).toBe(2010);
		expect(decadeOf(2023)).toBe(2010);
		expect(decadeOf(1969)).toBeNull();
		expect(decadeOf(null)).toBeNull();
	});
});

describe('filterSongs', () => {
	it('shows the whole library without a filter', () => {
		expect(ids(filterSongs(LIBRARY, NO_SONG_FILTER))).toEqual(ids(LIBRARY));
	});

	it('narrows by group, a song filed under two groups showing in both', () => {
		expect(ids(filterSongs(LIBRARY, {...NO_SONG_FILTER, group: 'rock'}))).toEqual(['Araf', 'Paranoid', 'Numb']);
		expect(ids(filterSongs(LIBRARY, {...NO_SONG_FILTER, group: 'turkce'}))).toEqual(['Araf']);
	});

	it('combines group, decade and search', () => {
		expect(ids(filterSongs(LIBRARY, {group: 'rock', decade: 2000, query: ''}))).toEqual(['Araf', 'Numb']);
		expect(ids(filterSongs(LIBRARY, {group: 'rock', decade: 2000, query: 'linkin'}))).toEqual(['Numb']);
		expect(ids(filterSongs(LIBRARY, {group: null, decade: 2010, query: ''}))).toEqual(['Uptown Funk']);
		expect(ids(filterSongs(LIBRARY, {group: 'country', decade: 1970, query: ''}))).toEqual([]);
	});
});

describe('groupCounts', () => {
	it('counts every song and each group, songs in two groups in both', () => {
		expect(groupCounts(LIBRARY, NO_SONG_FILTER)).toEqual([
			{group: null, count: 7},
			{group: 'turkce', count: 1},
			{group: 'rock', count: 3},
			{group: 'metal', count: 1},
			{group: 'alternatif', count: 1},
			{group: 'pop', count: 2},
			{group: 'country', count: 1},
			{group: 'klasik', count: 0},
		]);
	});

	it('follows the decade and search but not the selected group', () => {
		const counts = groupCounts(LIBRARY, {group: 'pop', decade: 2000, query: ''});
		expect(counts.map((entry) => entry.count)).toEqual([2, 1, 2, 0, 1, 0, 0, 0]);
		const searched = groupCounts(LIBRARY, {group: null, decade: null, query: 'take'});
		expect(searched.find((entry) => entry.group === 'pop')?.count).toBe(1);
		expect(searched[0].count).toBe(1);
	});
});

describe('randomSong', () => {
	it('picks from the shown songs and steers clear of my current vote', () => {
		const shown = filterSongs(LIBRARY, {...NO_SONG_FILTER, group: 'pop'});
		expect(randomSong(shown, null, () => 0)?.id).toBe('Take On Me');
		expect(randomSong(shown, 'Take On Me', () => 0)?.id).toBe('Uptown Funk');
		expect(randomSong(shown, 'Take On Me', () => 0.999)?.id).toBe('Uptown Funk');
	});

	it('still offers the only song shown, and nothing from an empty shelf', () => {
		expect(randomSong([LIBRARY[0]], 'Araf', () => 0.5)?.id).toBe('Araf');
		expect(randomSong([], null)).toBeNull();
	});
});

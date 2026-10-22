// SPDX-License-Identifier: AGPL-3.0-or-later

// The song picker's shelves: a genre group, a decade and the search text narrow the library together. Counts on the
// genre rail follow the other two, so a number always says how many songs that click would show.

import {BAND_GENRE_GROUPS, type BandGenreGroup, type BandSongSummary} from '@app/features/activities/band/BandProtocol';
import {searchSongs} from '@app/features/activities/band/flow/BandSongSearch';

// Start year of each decade chip; the last one also takes everything after it.
export const BAND_DECADES = [1970, 1980, 1990, 2000, 2010] as const;
export type BandDecade = (typeof BAND_DECADES)[number];
const LAST_DECADE: BandDecade = 2010;

export interface BandSongFilter {
	// Null is every song.
	readonly group: BandGenreGroup | null;
	readonly decade: BandDecade | null;
	readonly query: string;
}

export const NO_SONG_FILTER: BandSongFilter = {group: null, decade: null, query: ''};

export function decadeOf(year: number | null): BandDecade | null {
	if (year === null || year < BAND_DECADES[0]) return null;
	if (year >= LAST_DECADE) return LAST_DECADE;
	return (Math.floor(year / 10) * 10) as BandDecade;
}

function inDecade(song: BandSongSummary, decade: BandDecade | null): boolean {
	return decade === null || decadeOf(song.year) === decade;
}

function inGroup(song: BandSongSummary, group: BandGenreGroup | null): boolean {
	return group === null || song.groups.includes(group);
}

// Library order, or name matches first while searching (searchSongs).
export function filterSongs(songs: ReadonlyArray<BandSongSummary>, filter: BandSongFilter): Array<BandSongSummary> {
	return searchSongs(
		songs.filter((song) => inGroup(song, filter.group) && inDecade(song, filter.decade)),
		filter.query,
	);
}

export interface BandGroupCount {
	readonly group: BandGenreGroup | null;
	readonly count: number;
}

// Every song first, then the groups in rail order; the selected group does not narrow its own counts.
export function groupCounts(songs: ReadonlyArray<BandSongSummary>, filter: BandSongFilter): Array<BandGroupCount> {
	const matching = filterSongs(songs, {...filter, group: null});
	return [
		{group: null, count: matching.length},
		...BAND_GENRE_GROUPS.map((group) => ({
			group,
			count: matching.filter((song) => song.groups.includes(group)).length,
		})),
	];
}

// A song to vote for from what the shelves show, preferring one other than my current vote.
export function randomSong(
	songs: ReadonlyArray<BandSongSummary>,
	avoidSongId: string | null,
	random: () => number = Math.random,
): BandSongSummary | null {
	const pool = songs.length > 1 ? songs.filter((song) => song.id !== avoidSongId) : songs;
	if (pool.length === 0) return null;
	return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

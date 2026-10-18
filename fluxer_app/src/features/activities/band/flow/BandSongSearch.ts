// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandSongSummary} from '@app/features/activities/band/BandProtocol';

// Turkish casing (İ→i, I→ı) without the marks, and dotless ı as i: "sarki" finds "Şarkı", "isik" finds "IŞIK".
export function foldSongText(text: string): string {
	return text.toLocaleLowerCase('tr').normalize('NFD').replace(/\p{M}/gu, '').replace(/ı/g, 'i');
}

// Songs whose name or artist holds the query, name matches first, each group in library order.
export function searchSongs(songs: ReadonlyArray<BandSongSummary>, query: string): Array<BandSongSummary> {
	const needle = foldSongText(query.trim());
	if (!needle) return [...songs];
	const byName: Array<BandSongSummary> = [];
	const byArtist: Array<BandSongSummary> = [];
	for (const song of songs) {
		if (foldSongText(song.name).includes(needle)) byName.push(song);
		else if (foldSongText(song.artist).includes(needle)) byArtist.push(song);
	}
	return [...byName, ...byArtist];
}

// SPDX-License-Identifier: AGPL-3.0-or-later

// What the picker and the call tile know about the song library without loading the game: its size and the song
// titles, from the last index this client loaded. Empty until someone here has played; the game's own library fills
// it, so it never fetches anything by itself.

import {action, makeObservable, observable, observableRef} from 'mobx';

export interface BandCatalogSong {
	readonly id: string;
	readonly name: string;
}

class BandCatalog {
	songCount: number | null = null;
	private titles: ReadonlyMap<string, string> = new Map();

	constructor() {
		makeObservable<BandCatalog, 'titles'>(this, {
			songCount: observable,
			titles: observableRef,
			publish: action,
		});
	}

	title(songId: string): string | null {
		return this.titles.get(songId) ?? null;
	}

	publish(songs: ReadonlyArray<BandCatalogSong>): void {
		this.songCount = songs.length;
		this.titles = new Map(songs.map((song) => [song.id, song.name]));
	}
}

export default new BandCatalog();

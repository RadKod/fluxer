// SPDX-License-Identifier: AGPL-3.0-or-later

// The harness's own view of the local song library, read with the game's index parser: the bots need the index to
// pick parts and the charts to know when their notes fall. The game loads songs through BandSongLibrary itself.

import type {BandSongSummary} from '@app/features/activities/band/BandProtocol';
import type {BandBotChartProvider} from '@app/features/activities/band/dev/BandBots';
import type {BandDifficulty, BandPart} from '@app/features/activities/band/engine/ChartModel';
import {SongPackage} from '@app/features/activities/band/engine/SongPackage';
import {parseSongIndex} from '@app/features/activities/band/flow/BandSongLibrary';
import {action, makeObservable, observable, observableRef} from 'mobx';

export const DEFAULT_SONG_SERVER_URL = 'http://127.0.0.1:8787/';

export function songServerUrlFromLocation(location: Location): string {
	const configured = new URLSearchParams(location.search).get('songs');
	const url = configured && configured.length > 0 ? configured : DEFAULT_SONG_SERVER_URL;
	return url.endsWith('/') ? url : `${url}/`;
}

export class BandDevSongs {
	songs: ReadonlyArray<BandSongSummary> = [];
	error: string | null = null;
	loading = false;
	private readonly packages = new Map<string, Promise<SongPackage>>();

	constructor(readonly baseUrl: string) {
		makeObservable<BandDevSongs, 'finish'>(this, {
			songs: observableRef,
			error: observable,
			loading: observable,
			load: action,
			finish: action,
		});
	}

	async load(): Promise<void> {
		this.loading = true;
		this.error = null;
		try {
			const indexUrl = new URL('index.json', this.baseUrl).toString();
			const response = await fetch(indexUrl, {cache: 'no-store'});
			if (!response.ok) throw new Error(`index.json: HTTP ${response.status}`);
			this.finish(parseSongIndex(await response.json(), indexUrl).songs, null);
		} catch (error) {
			this.finish([], error instanceof Error ? error.message : String(error));
		}
	}

	readonly chart: BandBotChartProvider = async (songId: string, part: BandPart, difficulty: BandDifficulty) => {
		const song = this.songs.find((candidate) => candidate.id === songId);
		if (!song) return null;
		const chart = (await this.packageOf(song)).chart();
		if (part === 'vocals') {
			const notes = chart.vocals?.notes.map((note) => note.msTime);
			return notes ? {notes, finale: null} : null;
		}
		const partChart = chart.partChart(part, difficulty);
		return partChart ? {notes: partChart.groups.map((group) => group.msTime), finale: chart.bigRockEnding} : null;
	};

	private packageOf(song: BandSongSummary): Promise<SongPackage> {
		let pending = this.packages.get(song.id);
		if (!pending) {
			pending = fetch(song.packageUrl)
				.then((response) => {
					if (!response.ok) throw new Error(`${song.packageUrl}: HTTP ${response.status}`);
					return response.arrayBuffer();
				})
				.then((buffer) => SongPackage.fromSng(new Uint8Array(buffer)));
			pending.catch(() => this.packages.delete(song.id));
			this.packages.set(song.id, pending);
		}
		return pending;
	}

	private finish(songs: ReadonlyArray<BandSongSummary>, error: string | null): void {
		this.songs = songs;
		this.error = error;
		this.loading = false;
	}
}

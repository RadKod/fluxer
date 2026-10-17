// SPDX-License-Identifier: AGPL-3.0-or-later

import {buildMidi, buildSng, EXPERT_NOTE_BASE} from '@app/features/activities/band/engine/BandTestFixtures';
import type {SongFile} from '@app/features/activities/band/engine/SngFile';
import {mapAudioStems, SongPackage, SongPackageError} from '@app/features/activities/band/engine/SongPackage';
import {describe, expect, it} from 'vitest';

const bytes = (text: string) => new TextEncoder().encode(text);
const file = (fileName: string, data: Uint8Array = new Uint8Array([1])): SongFile => ({fileName, data});

const NOTES_MID = buildMidi({
	tracks: [{name: 'PART GUITAR', notes: [{tick: 0, note: EXPERT_NOTE_BASE}]}],
});

describe('mapAudioStems', () => {
	it('maps Clone Hero stem names onto band parts', () => {
		const stems = mapAudioStems([
			file('song.opus'),
			file('guitar.ogg'),
			file('bass.opus'),
			file('rhythm.opus'),
			file('drums_1.opus'),
			file('drums_2.opus'),
			file('drums_3.opus'),
			file('drums_4.opus'),
			file('vocals.opus'),
			file('keys.ogg'),
			file('crowd.ogg'),
			file('preview.opus'),
			file('album.jpg'),
			file('guitar.mp3'),
			file('unknown.opus'),
		]);
		expect(stems.map((stem) => [stem.role, stem.fileName, stem.format])).toEqual([
			['bass', 'bass.opus', 'opus'],
			['crowd', 'crowd.ogg', 'ogg'],
			['drums', 'drums_1.opus', 'opus'],
			['drums', 'drums_2.opus', 'opus'],
			['drums', 'drums_3.opus', 'opus'],
			['drums', 'drums_4.opus', 'opus'],
			['guitar', 'guitar.ogg', 'ogg'],
			['keys', 'keys.ogg', 'ogg'],
			['preview', 'preview.opus', 'opus'],
			['backing', 'rhythm.opus', 'opus'],
			['backing', 'song.opus', 'opus'],
			['vocals', 'vocals.opus', 'opus'],
		]);
	});

	it('uses rhythm as the bass stem when there is no bass stem', () => {
		expect(mapAudioStems([file('rhythm.opus'), file('drums.ogg')]).map((stem) => stem.role)).toEqual(['drums', 'bass']);
	});

	it('prefers opus when a stem exists in both formats, regardless of order', () => {
		expect(mapAudioStems([file('Guitar.OPUS'), file('guitar.ogg')])).toMatchObject([{fileName: 'Guitar.OPUS'}]);
		expect(mapAudioStems([file('guitar.ogg'), file('guitar.opus')])).toMatchObject([{fileName: 'guitar.opus'}]);
	});
});

describe('SongPackage', () => {
	it('loads a folder, reading song.ini and finding files inside subdirectories', () => {
		const song = SongPackage.fromFolder([
			file('My Song/song.ini', bytes('[song]\nname = Test\npro_drums = True\n')),
			file('My Song/notes.mid', NOTES_MID),
			file('My Song/guitar.opus'),
			file('My Song/album.png'),
		]);
		expect(song.metadata.name).toBe('Test');
		expect(song.metadata.chartModifiers).toEqual({pro_drums: true});
		expect(song.chartFile).toMatchObject({fileName: 'My Song/notes.mid', format: 'mid'});
		expect(song.stemsFor('guitar')).toHaveLength(1);
		expect(song.albumArt?.fileName).toBe('My Song/album.png');
		expect(song.chart().availableParts()).toEqual([
			{part: 'guitar', charted: ['expert'], playable: ['easy', 'medium', 'hard', 'expert']},
		]);
	});

	it('prefers notes.mid over notes.chart', () => {
		const song = SongPackage.fromFolder([file('notes.chart', bytes('[Song]\n{\n}\n')), file('notes.mid', NOTES_MID)]);
		expect(song.chartFile.format).toBe('mid');
	});

	it('loads a .sng with its header metadata as song.ini values', () => {
		const sng = buildSng({Name: 'From Sng', diff_drums: '3'}, [file('notes.mid', NOTES_MID), file('drums_1.opus')]);
		const song = SongPackage.fromSng(sng);
		expect(song.ini).toEqual({name: 'From Sng', diff_drums: '3'});
		expect(song.metadata.ratings).toEqual({drums: 3});
		expect(song.stemsFor('drums').map((stem) => stem.fileName)).toEqual(['drums_1.opus']);
		expect(song.chart().partChart('guitar', 'expert')?.groups).toHaveLength(1);
	});

	it('requires a chart file', () => {
		expect(() => SongPackage.fromFolder([file('song.ini', bytes('[song]\n')), file('song.opus')])).toThrow(
			SongPackageError,
		);
	});

	it('wraps chart parser failures in SongPackageError', () => {
		const song = SongPackage.fromFolder([file('notes.chart', bytes('[Song]\n{\n  Name = "x"\n}\n'))]);
		expect(() => song.chart()).toThrow(/notes.chart could not be parsed: Invalid .chart file: resolution not found/);
	});
});

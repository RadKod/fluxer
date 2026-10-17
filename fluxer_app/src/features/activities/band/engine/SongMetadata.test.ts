// SPDX-License-Identifier: AGPL-3.0-or-later

import {parseSongIni, songMetadataFromIni} from '@app/features/activities/band/engine/SongMetadata';
import {describe, expect, it} from 'vitest';

const ini = (text: string) => new TextEncoder().encode(text);

describe('parseSongIni', () => {
	it('reads only the [song] section, case-insensitively, with lowercased keys', () => {
		const values = parseSongIni(
			ini('﻿; comment\nstray = 1\n[Song]\r\nName = Snow\r\nARTIST= RHCP \n\n[other]\nname = wrong\n'),
		);
		expect(values).toEqual({name: 'Snow', artist: 'RHCP'});
	});

	it('keeps "=" inside values', () => {
		expect(parseSongIni(ini('[song]\nloading_phrase = a = b\n'))).toEqual({loading_phrase: 'a = b'});
	});

	it('decodes UTF-16 files with a byte order mark', () => {
		const text = '[song]\nname = Çay\n';
		const bytes = new Uint8Array(2 + text.length * 2);
		bytes.set([0xff, 0xfe]);
		for (let i = 0; i < text.length; i++) bytes[2 + i * 2] = text.charCodeAt(i) & 0xff;
		bytes[2 + text.indexOf('Ç') * 2] = 0xc7;
		expect(parseSongIni(bytes).name).toBe('Çay');
	});
});

describe('songMetadataFromIni', () => {
	it('maps text, timing, ratings and chart modifiers', () => {
		const metadata = songMetadataFromIni({
			name: 'Snow',
			artist: 'RHCP',
			album: '',
			song_length: '338000',
			preview_start_time: '40936',
			delay: '-20',
			diff_guitar: '5',
			diff_bass: '-1',
			diff_vocals: '0',
			hopo_frequency: '80',
			pro_drums: 'True',
			five_lane_drums: '0',
			eighthnote_hopo: 'maybe',
		});

		expect(metadata).toMatchObject({
			name: 'Snow',
			artist: 'RHCP',
			album: null,
			songLengthMs: 338000,
			previewStartMs: 40936,
			delayMs: -20,
			ratings: {guitar: 5, vocals: 0},
			chartModifiers: {song_length: 338000, hopo_frequency: 80, pro_drums: true, five_lane_drums: false},
		});
		expect(metadata.chartModifiers).not.toHaveProperty('eighthnote_hopo');
	});

	it('treats unset preview and length as null and falls back to the frets charter key', () => {
		const metadata = songMetadataFromIni({preview_start_time: '-1', song_length: '0', frets: 'Harmonix'});
		expect(metadata).toMatchObject({previewStartMs: null, songLengthMs: null, delayMs: 0, charter: 'Harmonix'});
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {buildSng} from '@app/features/activities/band/engine/BandTestFixtures';
import {parseSng, SngFormatError} from '@app/features/activities/band/engine/SngFile';
import {describe, expect, it} from 'vitest';

const encoder = new TextEncoder();

describe('parseSng', () => {
	it('reads metadata and unmasks every file', () => {
		const long = Uint8Array.from({length: 700}, (_, i) => (i * 7) & 0xff);
		const sng = buildSng({name: 'Şarkı', diff_guitar: '4'}, [
			{fileName: 'notes.mid', data: encoder.encode('MThd fake')},
			{fileName: 'guitar.opus', data: long},
			{fileName: 'empty.ogg', data: new Uint8Array()},
		]);

		const parsed = parseSng(sng);

		expect(parsed.version).toBe(1);
		expect(parsed.metadata).toEqual({name: 'Şarkı', diff_guitar: '4'});
		expect(parsed.files.map((file) => file.fileName)).toEqual(['notes.mid', 'guitar.opus', 'empty.ogg']);
		expect(new TextDecoder().decode(parsed.files[0].data)).toBe('MThd fake');
		expect(parsed.files[1].data).toEqual(long);
		expect(parsed.files[2].data).toHaveLength(0);
	});

	it('restarts the mask cycle for each file', () => {
		const data = Uint8Array.from({length: 300}, () => 0);
		const parsed = parseSng(
			buildSng({}, [
				{fileName: 'a', data},
				{fileName: 'b', data},
			]),
		);
		expect(parsed.files[0].data).toEqual(data);
		expect(parsed.files[1].data).toEqual(data);
	});

	it('rejects a file without the SNGPKG identifier', () => {
		const sng = buildSng({}, []);
		sng[0] = 'X'.charCodeAt(0);
		expect(() => parseSng(sng)).toThrow(SngFormatError);
	});

	it('rejects a truncated header', () => {
		const sng = buildSng({name: 'x'}, [{fileName: 'notes.mid', data: new Uint8Array(4)}]);
		expect(() => parseSng(sng.subarray(0, 40))).toThrow(/ended early/);
	});

	it('rejects a file entry pointing past the end', () => {
		const sng = buildSng({}, [{fileName: 'notes.mid', data: new Uint8Array(32)}]);
		expect(() => parseSng(sng.subarray(0, sng.length - 1))).toThrow(/past the end/);
	});
});

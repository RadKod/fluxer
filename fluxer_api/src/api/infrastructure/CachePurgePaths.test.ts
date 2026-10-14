// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {canonicalizePurgeUrl} from '@app/api/infrastructure/CachePurgePaths';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const MEDIA = 'https://media.test';

describe('canonicalizePurgeUrl', () => {
	let previousMedia: string;

	beforeEach(() => {
		previousMedia = Config.endpoints.media;
		Config.endpoints.media = MEDIA;
	});

	afterEach(() => {
		Config.endpoints.media = previousMedia;
	});

	it('qualifies every prefix with the media host and no scheme', () => {
		expect(canonicalizePurgeUrl(`${MEDIA}/attachments/1/2/photo.png`)).toEqual(['media.test/attachments/1/2/photo']);
	});

	it('drops the file extension so every served format is covered', () => {
		expect(canonicalizePurgeUrl(`${MEDIA}/emojis/1531309058777157632.webp`)).toEqual([
			'media.test/emojis/1531309058777157632',
		]);
	});

	it('pairs an asset hash with its animated spelling in both directions', () => {
		expect(canonicalizePurgeUrl(`${MEDIA}/avatars/1/a_b35cc3d3`)).toEqual([
			'media.test/avatars/1/a_b35cc3d3',
			'media.test/avatars/1/b35cc3d3',
		]);
		expect(canonicalizePurgeUrl(`${MEDIA}/icons/1/808b11fa.webp`)).toEqual([
			'media.test/icons/1/808b11fa',
			'media.test/icons/1/a_808b11fa',
		]);
	});

	it('leaves a non-hash stem alone', () => {
		expect(canonicalizePurgeUrl(`${MEDIA}/attachments/1/2/holiday.jpg`)).toEqual([
			'media.test/attachments/1/2/holiday',
		]);
	});

	it('drops the query and fragment and decodes the path', () => {
		expect(canonicalizePurgeUrl(`${MEDIA}/attachments/1/2/ação.png?size=128#x`)).toEqual([
			'media.test/attachments/1/2/ação',
		]);
	});

	it('keeps a base path when the media endpoint has one', () => {
		Config.endpoints.media = `${MEDIA}/media`;
		expect(canonicalizePurgeUrl(`${MEDIA}/media/avatars/1/b35cc3d3`)).toEqual([
			'media.test/media/avatars/1/b35cc3d3',
			'media.test/media/avatars/1/a_b35cc3d3',
		]);
		expect(canonicalizePurgeUrl(`${MEDIA}/avatars/1/b35cc3d3`)).toEqual([]);
	});

	it('refuses anything that is not a media CDN object', () => {
		expect(canonicalizePurgeUrl('https://elsewhere.test/avatars/1/b35cc3d3')).toEqual([]);
		expect(canonicalizePurgeUrl(`${MEDIA}/avatars`)).toEqual([]);
		expect(canonicalizePurgeUrl(`${MEDIA}/`)).toEqual([]);
		expect(canonicalizePurgeUrl(`${MEDIA}/emojis/.webp`)).toEqual([]);
		expect(canonicalizePurgeUrl('not-a-url')).toEqual([]);
	});

	describe('Bunny Stream videos', () => {
		const STREAM = 'vz-test.b-cdn.test';
		const GUID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
		let previousHost: string;

		beforeEach(() => {
			previousHost = Config.bunnyStream.cdnHostname;
			Config.bunnyStream.cdnHostname = STREAM;
		});

		afterEach(() => {
			Config.bunnyStream.cdnHostname = previousHost;
		});

		it('turns a stream video directory into one purge prefix', () => {
			expect(canonicalizePurgeUrl(`https://${STREAM}/${GUID}/`)).toEqual([`${STREAM}/${GUID}/`]);
		});

		it('ignores other hosts and malformed guids', () => {
			expect(canonicalizePurgeUrl(`https://elsewhere.test/${GUID}/`)).toEqual([]);
			expect(canonicalizePurgeUrl(`http://${STREAM}/${GUID}/`)).toEqual([]);
			expect(canonicalizePurgeUrl(`https://${STREAM}:8443/${GUID}/`)).toEqual([]);
			expect(canonicalizePurgeUrl(`https://${STREAM}/${GUID.toUpperCase()}/`)).toEqual([]);
			expect(canonicalizePurgeUrl(`https://${STREAM}/not-a-guid/`)).toEqual([]);
			expect(canonicalizePurgeUrl(`https://${STREAM}/${GUID}`)).toEqual([]);
			expect(canonicalizePurgeUrl(`https://${STREAM}/${GUID}/playlist.m3u8`)).toEqual([]);
			expect(canonicalizePurgeUrl(`https://${STREAM}/`)).toEqual([]);
			// Without a configured stream host nothing is a stream video.
			Config.bunnyStream.cdnHostname = '';
			expect(canonicalizePurgeUrl(`https://${STREAM}/${GUID}/`)).toEqual([]);
		});
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {feedGifUrl, isFeedGifUrl, splitFeedGifs} from '@app/features/feed/utils/FeedGifUtils';
import {describe, expect, it} from 'vitest';

const MEDIA = 'https://media.micup.test';
const KLIPY_GIF = `${MEDIA}/external/AbC-_123/https/static.klipy.com/ii/c8/28/HkAKKCzZ.webp`;

describe('isFeedGifUrl', () => {
	it('takes a Klipy GIF behind our media proxy', () => {
		expect(isFeedGifUrl(KLIPY_GIF, MEDIA)).toBe(true);
		expect(isFeedGifUrl(`${MEDIA}/external/sig/https/static.klipy.com/ii/a/b.gif`, MEDIA)).toBe(true);
	});

	it.each([
		['any other host', 'https://evil.test/a.gif'],
		['Klipy without the proxy', 'https://static.klipy.com/ii/a/b.gif'],
		['the proxy fetching another site', `${MEDIA}/external/sig/https/evil.test/a.gif`],
		['a look-alike Klipy host', `${MEDIA}/external/sig/https/static.klipy.com.evil.test/a.gif`],
		['plain http to Klipy', `${MEDIA}/external/sig/http/static.klipy.com/a.gif`],
		['a query in front of the path', `${MEDIA}/external/sig/%3Fx%3D1/https/static.klipy.com/a.gif`],
		['a query on the proxy URL', `${KLIPY_GIF}?x=1`],
		['a video file', `${MEDIA}/external/sig/https/static.klipy.com/ii/a/b.mp4`],
		['an uploaded attachment', `${MEDIA}/attachments/1/2/a.gif`],
		['another origin that starts the same', `${MEDIA}.evil.test/external/sig/https/static.klipy.com/a.gif`],
		[
			'credentials in front of the host',
			`https://media.micup.test@evil.test/external/sig/https/static.klipy.com/a.gif`,
		],
		['not a URL', 'static.klipy.com/a.gif'],
		['a dot-dot segment', `${MEDIA}/external/sig/https/static.klipy.com/ii/../a.gif`],
		['an encoded dot-dot segment', `${MEDIA}/external/sig/https/static.klipy.com/ii/%2e%2e/a.gif`],
		['an upper-case media host', 'https://MEDIA.micup.test/external/sig/https/static.klipy.com/ii/a.gif'],
		['an upper-case Klipy host', `${MEDIA}/external/sig/https/STATIC.KLIPY.COM/ii/a.gif`],
		['the default port written out', 'https://media.micup.test:443/external/sig/https/static.klipy.com/ii/a.gif'],
		['backslashes', String.raw`https://media.micup.test\external\sig\https\static.klipy.com\ii\a.gif`],
		['a bare question mark', `${KLIPY_GIF}?`],
		['a bare hash', `${KLIPY_GIF}#`],
	])('refuses %s', (_label, url) => {
		expect(isFeedGifUrl(url, MEDIA)).toBe(false);
	});
});

describe('splitFeedGifs', () => {
	it('takes allowed GIF links out of the text', () => {
		expect(splitFeedGifs(`haha\n${KLIPY_GIF}`, MEDIA)).toEqual({text: 'haha', gifs: [KLIPY_GIF]});
		expect(splitFeedGifs(KLIPY_GIF, MEDIA)).toEqual({text: '', gifs: [KLIPY_GIF]});
	});

	it('leaves every other link in the text', () => {
		const content = 'look https://evil.test/a.gif';
		expect(splitFeedGifs(content, MEDIA)).toEqual({text: content, gifs: []});
	});

	it('draws at most four GIFs and keeps the rest as text', () => {
		const content = Array.from({length: 5}, () => KLIPY_GIF).join(' ');
		const {text, gifs} = splitFeedGifs(content, MEDIA);
		expect(gifs).toHaveLength(4);
		expect(text).toBe(KLIPY_GIF);
	});
});

describe('feedGifUrl', () => {
	const gif = (media: Record<string, {proxy_src: string}>) =>
		({provider: 'klipy', url: 'https://klipy.com/gifs/cat-1', slug: 'cat-1', media}) as never;

	it('picks an image format behind the proxy, animated WebP first', () => {
		const gifUrl = `${MEDIA}/external/s/https/static.klipy.com/ii/a/b.gif`;
		expect(
			feedGifUrl(gif({mp4: {proxy_src: 'x'}, gif: {proxy_src: gifUrl}, webp: {proxy_src: KLIPY_GIF}}), MEDIA),
		).toBe(KLIPY_GIF);
		expect(feedGifUrl(gif({gif: {proxy_src: gifUrl}}), MEDIA)).toBe(gifUrl);
	});

	it('falls back to the Klipy share link, which shows as a plain link', () => {
		expect(feedGifUrl(gif({webp: {proxy_src: 'https://evil.test/a.webp'}}), MEDIA)).toBe(
			'https://klipy.com/gifs/cat-1',
		);
	});
});

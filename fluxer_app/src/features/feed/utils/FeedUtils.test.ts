// SPDX-License-Identifier: AGPL-3.0-or-later

import {FEED_VIDEO_CONTENT_TYPES, FEED_VIDEO_MAX_BYTES} from '@fluxer/schema/src/domains/feed/FeedRequestSchemas';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const limits = vi.hoisted((): Record<string, number> => ({feature_feed: 1, feature_feed_discover: 1}));

vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({
	LimitResolver: {
		resolve: ({key, fallback}: {key: string; fallback: number}) => limits[key] ?? fallback,
	},
}));

const {
	FEED_MAX_IMAGES,
	FEED_MAX_IMAGE_BYTES,
	FEED_MAX_VIDEO_BYTES,
	FEED_VIDEO_ACCEPT,
	FEED_VIDEO_TYPES,
	feedVideoFile,
	isFeedDiscoverEnabled,
	isFeedEnabled,
	isFeedSuggestionsEnabled,
	isFeedVideoEnabled,
	validateFeedImages,
	validateFeedVideo,
} = await import('@app/features/feed/utils/FeedUtils');

function image(name: string, type: string, size = 1024): File {
	return new File([new Uint8Array(size)], name, {type});
}

describe('isFeedEnabled', () => {
	beforeEach(() => {
		limits.feature_feed = 1;
		limits.feature_feed_discover = 1;
	});

	it('follows the feature_feed limit', () => {
		expect(isFeedEnabled()).toBe(true);
		limits.feature_feed = 0;
		expect(isFeedEnabled()).toBe(false);
	});

	it('isFeedDiscoverEnabled follows feature_feed_discover', () => {
		expect(isFeedDiscoverEnabled()).toBe(true);
		limits.feature_feed_discover = 0;
		expect(isFeedDiscoverEnabled()).toBe(false);
		expect(isFeedEnabled()).toBe(true);
	});

	it('isFeedVideoEnabled follows feature_feed_video and is off when it is not set', () => {
		expect(isFeedVideoEnabled()).toBe(false);
		limits.feature_feed_video = 1;
		expect(isFeedVideoEnabled()).toBe(true);
		limits.feature_feed_video = 0;
		expect(isFeedVideoEnabled()).toBe(false);
		delete limits.feature_feed_video;
	});

	it('isFeedSuggestionsEnabled follows feature_feed_suggestions and is off without it', () => {
		expect(isFeedSuggestionsEnabled()).toBe(false);
		limits.feature_feed_suggestions = 1;
		expect(isFeedSuggestionsEnabled()).toBe(true);
		limits.feature_feed_suggestions = 0;
		expect(isFeedSuggestionsEnabled()).toBe(false);
		delete limits.feature_feed_suggestions;
	});
});

describe('validateFeedVideo', () => {
	const video = (type: string, size = 1024) => new File([new Uint8Array(size)], 'clip', {type});

	it('takes the server limits from the schema: 500 MB of MP4, WebM, QuickTime or Matroska, any length', () => {
		expect(FEED_MAX_VIDEO_BYTES).toBe(FEED_VIDEO_MAX_BYTES);
		expect([...FEED_VIDEO_TYPES]).toEqual([...FEED_VIDEO_CONTENT_TYPES]);
		// The extensions too: a system that knows no type for .mkv or .mov would hide those files from the picker.
		expect(FEED_VIDEO_ACCEPT).toBe('video/mp4,video/webm,video/quicktime,video/x-matroska,.mov,.mkv');
	});

	it('names the video type from the file name when the browser gives none', () => {
		const untyped = (name: string) => new File([new Uint8Array(4)], name, {type: ''});
		expect(feedVideoFile(untyped('match.MKV'))).toMatchObject({name: 'match.MKV', type: 'video/x-matroska', size: 4});
		expect(feedVideoFile(untyped('clip.mov')).type).toBe('video/quicktime');
		expect(feedVideoFile(untyped('clip.avi')).type).toBe('');
		const typed = video('video/mp4');
		expect(feedVideoFile(typed)).toBe(typed);
	});

	it.each([
		['an mp4', video('video/mp4'), null],
		['a webm', video('video/webm'), null],
		['a QuickTime video', video('video/quicktime'), null],
		['a Matroska video', video('video/x-matroska'), null],
		['an AVI video', video('video/x-msvideo'), 'type'],
		['an image', video('image/png'), 'type'],
		['a file without a type', video(''), 'type'],
		['a file at the size limit', video('video/mp4', 2048), null],
		['a file over the size limit', video('video/mp4', 2049), 'size'],
	] as const)('%s', (_, file, expected) => {
		expect(validateFeedVideo(file, 2048)).toBe(expected);
	});
});

describe('validateFeedImages', () => {
	it('takes png, jpeg, webp and gif images', () => {
		const files = [
			image('a.png', 'image/png'),
			image('b.jpg', 'image/jpeg'),
			image('c.webp', 'image/webp'),
			image('d.gif', 'image/gif'),
		];
		expect(validateFeedImages([], files, FEED_MAX_IMAGE_BYTES)).toEqual({accepted: files, rejection: null});
	});

	it('rejects other types, whatever the file name says', () => {
		const svg = image('logo.png', 'image/svg+xml');
		const pdf = image('doc.pdf', 'application/pdf');
		const untyped = image('photo.png', '');
		const png = image('ok.png', 'image/png');
		expect(validateFeedImages([], [svg, png, pdf, untyped], FEED_MAX_IMAGE_BYTES)).toEqual({
			accepted: [png],
			rejection: 'type',
		});
	});

	it(`keeps at most ${FEED_MAX_IMAGES} images per post`, () => {
		const current = [image('1.png', 'image/png'), image('2.png', 'image/png'), image('3.png', 'image/png')];
		const added = [image('4.png', 'image/png'), image('5.png', 'image/png')];
		expect(validateFeedImages(current, added, FEED_MAX_IMAGE_BYTES)).toEqual({
			accepted: [added[0]],
			rejection: 'count',
		});
		expect(validateFeedImages([...current, added[0]!], [added[1]!], FEED_MAX_IMAGE_BYTES)).toEqual({
			accepted: [],
			rejection: 'count',
		});
	});

	it('rejects images over the size limit', () => {
		const big = image('big.png', 'image/png', 2049);
		const small = image('small.png', 'image/png', 2048);
		expect(validateFeedImages([], [big, small], 2048)).toEqual({accepted: [small], rejection: 'size'});
	});
});

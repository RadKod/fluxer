// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash, createHmac} from 'node:crypto';
import {createUserID} from '@app/api/BrandedTypes';
import type {FeedMedia} from '@app/api/database/types/FeedTypes';
import {
	FEED_VIDEO_URL_GRID_MS,
	feedStreamEvidenceKey,
	feedVideoBaseOf,
	feedVideoUrlExpiry,
	isStreamMedia,
	mapFeedVideoToResponse,
	signCdnToken,
	signTusUpload,
	streamFileUrl,
	streamPlaylistUrl,
	verifyWebhookSignature,
} from '@app/api/feed/video/FeedVideoUrls';
import {BUNNY_TEST_SETTINGS} from '@app/api/test/msw/handlers/BunnyStreamHandlers';
import {describe, expect, it} from 'vitest';

const GUID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const EXPIRES = 1_900_000_000;

function hs256(key: string, message: string): string {
	return `HS256-${createHmac('sha256', key).update(message).digest('base64url')}`;
}

function streamMedia(overrides: Partial<FeedMedia> = {}): FeedMedia {
	return {
		attachment_id: 123n,
		filename: 'evidence.ts',
		size: 1000n,
		description: null,
		width: 1080,
		height: 1920,
		content_type: 'video/mp2t',
		content_hash: null,
		placeholder: null,
		flags: 0,
		nsfw: false,
		duration: 90,
		stream_video_id: GUID,
		stream_mp4_file: 'play_720p.mp4',
		...overrides,
	};
}

describe('FeedVideoUrls', () => {
	it('signs the TUS upload as sha256 of library id, key, expiry and guid', () => {
		const expected = createHash('sha256')
			.update(`${BUNNY_TEST_SETTINGS.libraryId}${BUNNY_TEST_SETTINGS.apiKey}${EXPIRES}${GUID}`)
			.digest('hex');
		expect(signTusUpload(BUNNY_TEST_SETTINGS, GUID, EXPIRES)).toBe(expected);
		expect(signTusUpload(BUNNY_TEST_SETTINGS, GUID, EXPIRES + 1)).not.toBe(expected);
	});

	it('builds the HLS url with the token in the path so segments inherit it', () => {
		const url = streamPlaylistUrl(BUNNY_TEST_SETTINGS, GUID, EXPIRES);
		const token = hs256(BUNNY_TEST_SETTINGS.tokenKey, `/${GUID}/${EXPIRES}token_path=/${GUID}/`);
		expect(url).toBe(
			`https://${BUNNY_TEST_SETTINGS.cdnHostname}/bcdn_token=${token}&expires=${EXPIRES}&token_path=%2F${GUID}%2F/${GUID}/playlist.m3u8`,
		);
	});

	it('signs a file url with HS256 and base64url', () => {
		const url = streamFileUrl(BUNNY_TEST_SETTINGS, GUID, 'play_720p.mp4', EXPIRES);
		const token = hs256(BUNNY_TEST_SETTINGS.tokenKey, `/${GUID}/play_720p.mp4${EXPIRES}`);
		expect(url).toBe(
			`https://${BUNNY_TEST_SETTINGS.cdnHostname}/${GUID}/play_720p.mp4?token=${token}&expires=${EXPIRES}`,
		);
		expect(token).toMatch(/^HS256-[A-Za-z0-9_-]{43}$/);
		expect(signCdnToken(BUNNY_TEST_SETTINGS.tokenKey, `/${GUID}/thumbnail.jpg`, EXPIRES)).toBe(
			hs256(BUNNY_TEST_SETTINGS.tokenKey, `/${GUID}/thumbnail.jpg${EXPIRES}`),
		);
	});

	it('refuses to sign without a token key', () => {
		const unsigned = {...BUNNY_TEST_SETTINGS, tokenKey: ''};
		expect(() => signCdnToken('', `/${GUID}/thumbnail.jpg`, EXPIRES)).toThrow();
		expect(() => streamFileUrl(unsigned, GUID, 'thumbnail.jpg', EXPIRES)).toThrow();
		expect(() => streamPlaylistUrl(unsigned, GUID, EXPIRES)).toThrow();
		expect(() => mapFeedVideoToResponse(unsigned, feedVideoBaseOf(streamMedia()), Date.now())).toThrow();
	});

	it('serves a repeated signature from the process map within its window', () => {
		const guid = '0b1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
		const base = feedVideoBaseOf(streamMedia({stream_video_id: guid}));
		const windowStart = Math.floor(Date.now() / FEED_VIDEO_URL_GRID_MS) * FEED_VIDEO_URL_GRID_MS;
		const first = mapFeedVideoToResponse(BUNNY_TEST_SETTINGS, base, windowStart + 1000);
		const expires = feedVideoUrlExpiry(windowStart + 1000, 90);
		expect(first).toEqual({
			id: guid,
			width: 1080,
			height: 1920,
			duration: 90,
			poster_url: streamFileUrl(BUNNY_TEST_SETTINGS, guid, 'thumbnail.jpg', expires),
			hls_url: streamPlaylistUrl(BUNNY_TEST_SETTINGS, guid, expires),
			mp4_url: streamFileUrl(BUNNY_TEST_SETTINGS, guid, 'play_720p.mp4', expires),
			expires_at: new Date(expires * 1000).toISOString(),
		});
		// A different key in the same window still gets the stored URLs: they came from the map, not a new HMAC.
		const rotated = {...BUNNY_TEST_SETTINGS, tokenKey: 'another-token-key'};
		expect(mapFeedVideoToResponse(rotated, base, windowStart + FEED_VIDEO_URL_GRID_MS - 1)).toEqual(first);
		const next = mapFeedVideoToResponse(BUNNY_TEST_SETTINGS, base, windowStart + FEED_VIDEO_URL_GRID_MS);
		expect(next.expires_at).not.toBe(first.expires_at);
		expect(next.hls_url).not.toBe(first.hls_url);
		const withoutMp4 = mapFeedVideoToResponse(
			BUNNY_TEST_SETTINGS,
			feedVideoBaseOf(streamMedia({stream_video_id: '1b1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f', stream_mp4_file: null})),
			windowStart,
		);
		expect(withoutMp4.mp4_url).toBeNull();
	});

	// A removed video (CSAM included) stops playing for those who hold its URLs within hours, not a day.
	it('signs for 2 h on the hour grid, or for the video and 30 more minutes when that is longer', () => {
		const HOUR = 3_600_000;
		expect(FEED_VIDEO_URL_GRID_MS).toBe(HOUR);
		const hourStart = 400_000 * HOUR;
		for (const duration of [null, 0, 90, 5400]) {
			for (const now of [hourStart, hourStart + 1, hourStart + HOUR - 1]) {
				const expires = feedVideoUrlExpiry(now, duration);
				expect(expires).toBe((hourStart + 3 * HOUR) / 1000);
				expect(expires * 1000 - now).toBeGreaterThan(2 * HOUR);
				expect(expires * 1000 - now).toBeLessThanOrEqual(3 * HOUR);
			}
		}
		expect(feedVideoUrlExpiry(hourStart + HOUR, 90)).toBe((hourStart + 4 * HOUR) / 1000);
		// 3 h of video: at least 3.5 h, on the grid.
		for (const now of [hourStart, hourStart + HOUR - 1]) {
			const expires = feedVideoUrlExpiry(now, 10_800);
			expect(expires).toBe((hourStart + 5 * HOUR) / 1000);
			expect(expires * 1000 - now).toBeGreaterThanOrEqual(10_800_000 + 30 * 60_000);
		}
		// never more than 6 h (and the hour), however long the video.
		for (const duration of [36_000, 1_000_000]) {
			for (const now of [hourStart, hourStart + HOUR - 1]) {
				expect(feedVideoUrlExpiry(now, duration)).toBe((hourStart + 7 * HOUR) / 1000);
			}
		}
	});

	it('verifies a webhook signature with timingSafeEqual and refuses a wrong length or a tampered body', () => {
		const key = BUNNY_TEST_SETTINGS.readOnlyApiKey;
		const body = JSON.stringify({VideoLibraryId: BUNNY_TEST_SETTINGS.libraryId, VideoGuid: GUID, Status: 3});
		const signature = createHmac('sha256', key).update(body).digest('hex');
		expect(verifyWebhookSignature(key, body, signature)).toBe(true);
		expect(verifyWebhookSignature(key, `${body} `, signature)).toBe(false);
		expect(verifyWebhookSignature(key, body, signature.slice(0, 62))).toBe(false);
		expect(verifyWebhookSignature(key, body, `${signature}00`)).toBe(false);
		expect(verifyWebhookSignature(key, body, `${signature.slice(0, 62)}zz`)).toBe(false);
		expect(verifyWebhookSignature(key, body, '')).toBe(false);
		expect(verifyWebhookSignature('another-key', body, signature)).toBe(false);
		expect(verifyWebhookSignature('', body, createHmac('sha256', '').update(body).digest('hex'))).toBe(false);
	});

	it('tells stream media apart and maps it to its video base', () => {
		expect(isStreamMedia(streamMedia())).toBe(true);
		expect(isStreamMedia(streamMedia({stream_video_id: null}))).toBe(false);
		expect(isStreamMedia({stream_video_id: undefined})).toBe(false);
		expect(feedVideoBaseOf(streamMedia())).toEqual({
			id: GUID,
			width: 1080,
			height: 1920,
			duration: 90,
			mp4_file: 'play_720p.mp4',
		});
	});

	it("keys a video's evidence under the author's channel by its media file name", () => {
		expect(feedStreamEvidenceKey(createUserID(42n), streamMedia())).toBe('attachments/42/123/evidence.ts');
	});
});

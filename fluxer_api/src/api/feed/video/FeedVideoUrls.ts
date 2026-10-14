// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {type UserID, userIdToChannelId} from '@app/api/BrandedTypes';
import {makeAttachmentCdnKey} from '@app/api/channel/services/message/MessageHelpers';
import type {FeedMedia} from '@app/api/database/types/FeedTypes';
import type {FeedVideoResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';

/** Bunny Stream settings (Config.bunnyStream); secrets stay on the server, clients get derived signatures only. */
export interface FeedStreamSettings {
	enabled: boolean;
	libraryId: number;
	apiKey: string;
	readOnlyApiKey: string;
	cdnHostname: string;
	tokenKey: string;
	apiBase: string;
	tusEndpoint: string;
	timeoutMs: number;
	storageHost: string;
	storageZone: string;
	// The storage zone's ReadOnlyPassword: the client only lists and reads.
	storagePassword: string;
}

export const FEED_VIDEO_URL_GRID_MS = 3_600_000;
// A removed video (CSAM included) keeps playing for whoever holds its URLs until they expire: 2 h, or the video's
// length and 30 min when longer, so a long video does not stop mid-play (the client renews ahead of the end), but
// never more than 6 h. Kalan risk: the client renews only before playing, so a video over about 5.5 h stops
// once its URLs end mid-play, and its every play reloads the post first.
const URL_MIN_MS = 2 * FEED_VIDEO_URL_GRID_MS;
const URL_MAX_MS = 6 * FEED_VIDEO_URL_GRID_MS;
const URL_PLAY_MARGIN_MS = 30 * 60_000;
export const BUNNY_GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WEBHOOK_SIGNATURE_PATTERN = /^[0-9a-f]{64}$/i;
// TEMPORARY: one process-wide map, cleared whole when full; at 3 HMACs a video it only saves CPU, never correctness.
const SIGNED_CACHE_LIMIT = 10_000;
const signedCache = new Map<string, FeedVideoResponse>();

/** What a post stores about its video; the signed URLs are made per request. */
export interface FeedVideoBase {
	id: string;
	width: number | null;
	height: number | null;
	duration: number | null;
	mp4_file: string | null;
}

/**
 * Unix seconds on the hour grid at least 2 h (or the video and 30 min, at most 6 h) after the end of this hour, so a
 * URL lives that long plus at most an hour and stays the same for every request of the hour.
 */
export function feedVideoUrlExpiry(nowMs: number, durationSeconds: number | null): number {
	const lifetime = Math.min(URL_MAX_MS, Math.max(URL_MIN_MS, (durationSeconds ?? 0) * 1000 + URL_PLAY_MARGIN_MS));
	const hours = Math.floor(nowMs / FEED_VIDEO_URL_GRID_MS) + 1 + Math.ceil(lifetime / FEED_VIDEO_URL_GRID_MS);
	return (hours * FEED_VIDEO_URL_GRID_MS) / 1000;
}

/** TUS AuthorizationSignature: hex SHA-256 of library id, API key, expiry and video id. */
export function signTusUpload(
	s: Pick<FeedStreamSettings, 'libraryId' | 'apiKey'>,
	guid: string,
	expires: number,
): string {
	return createHash('sha256').update(`${s.libraryId}${s.apiKey}${expires}${guid}`).digest('hex');
}

/**
 * Bunny CDN advanced token: "HS256-" + base64url(HMAC-SHA256(key, path + expires + signingData)), where signingData is
 * the sorted extra parameters as raw key=value pairs joined by & (here only token_path). There is no unsigned mode.
 * TEMPORARY: Bunny's advanced token format; verify compatibility with a live smoke test.
 */
export function signCdnToken(key: string, signaturePath: string, expires: number, signingData = ''): string {
	if (key === '') {
		throw new Error('Refusing to build a Bunny Stream URL without a token key');
	}
	return `HS256-${createHmac('sha256', key).update(`${signaturePath}${expires}${signingData}`).digest('base64url')}`;
}

export function streamFileUrl(s: FeedStreamSettings, guid: string, file: string, expires: number): string {
	const token = signCdnToken(s.tokenKey, `/${guid}/${file}`, expires);
	return `https://${s.cdnHostname}/${guid}/${file}?token=${token}&expires=${expires}`;
}

/** The token sits in the path and covers /<guid>/, so every playlist and segment under it inherits it. */
export function streamPlaylistUrl(s: FeedStreamSettings, guid: string, expires: number): string {
	const tokenPath = `/${guid}/`;
	const token = signCdnToken(s.tokenKey, tokenPath, expires, `token_path=${tokenPath}`);
	return `https://${s.cdnHostname}/bcdn_token=${token}&expires=${expires}&token_path=${encodeURIComponent(tokenPath)}${tokenPath}playlist.m3u8`;
}

/** Bunny's webhook signature: lowercase hex HMAC-SHA256 of the raw body, keyed with the read-only API key. */
export function verifyWebhookSignature(readOnlyKey: string, rawBody: string, signatureHex: string): boolean {
	if (readOnlyKey === '' || !WEBHOOK_SIGNATURE_PATTERN.test(signatureHex)) return false;
	const expected = createHmac('sha256', readOnlyKey).update(rawBody).digest();
	return timingSafeEqual(expected, Buffer.from(signatureHex, 'hex'));
}

export function isStreamMedia(media: Pick<FeedMedia, 'stream_video_id'>): boolean {
	return media.stream_video_id != null && media.stream_video_id !== '';
}

export function feedVideoBaseOf(media: FeedMedia): FeedVideoBase {
	return {
		id: media.stream_video_id ?? '',
		width: media.width,
		height: media.height,
		duration: media.duration ?? null,
		mp4_file: media.stream_mp4_file ?? null,
	};
}

/** Signed URLs for one viewer request; call it only after the viewer passed the post's access check. */
export function mapFeedVideoToResponse(s: FeedStreamSettings, base: FeedVideoBase, nowMs: number): FeedVideoResponse {
	if (s.tokenKey === '') {
		throw new Error('Refusing to build a Bunny Stream URL without a token key');
	}
	const expires = feedVideoUrlExpiry(nowMs, base.duration);
	const cacheKey = `${base.id}:${expires}`;
	const cached = signedCache.get(cacheKey);
	if (cached) return cached;
	const response: FeedVideoResponse = {
		id: base.id,
		width: base.width,
		height: base.height,
		duration: base.duration,
		poster_url: streamFileUrl(s, base.id, 'thumbnail.jpg', expires),
		hls_url: streamPlaylistUrl(s, base.id, expires),
		mp4_url: base.mp4_file ? streamFileUrl(s, base.id, base.mp4_file, expires) : null,
		expires_at: new Date(expires * 1000).toISOString(),
	};
	if (signedCache.size >= SIGNED_CACHE_LIMIT) signedCache.clear();
	signedCache.set(cacheKey, response);
	return response;
}

/** The reports bucket key of a video's evidence copy: the attachment key of its media file name (evidence.ts). */
export function feedStreamEvidenceKey(authorId: UserID, media: FeedMedia): string {
	return makeAttachmentCdnKey(userIdToChannelId(authorId), media.attachment_id, media.filename);
}

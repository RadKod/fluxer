// SPDX-License-Identifier: AGPL-3.0-or-later

import {LimitResolver} from '@app/features/app/utils/LimitResolverAdapter';
import {ATTACHMENT_UPLOAD_CHUNK_THRESHOLD} from '@fluxer/constants/src/LimitConstants';
import {FEED_VIDEO_CONTENT_TYPES, FEED_VIDEO_MAX_BYTES} from '@fluxer/schema/src/domains/feed/FeedRequestSchemas';

export const FEED_MAX_IMAGES = 4;
export const FEED_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const FEED_IMAGE_ACCEPT = [...FEED_IMAGE_TYPES].join(',');
// POST /feed/attachments has no multipart completion step, so an image must fit one presigned PUT (the server plans
// larger files as multipart). The composer also applies the user's max_attachment_file_size when it is smaller.
export const FEED_MAX_IMAGE_BYTES = ATTACHMENT_UPLOAD_CHUNK_THRESHOLD;

export type FeedImageRejection = 'type' | 'count' | 'size';

// One video per post, alone (no images, no poll), uploaded to Bunny Stream with TUS (POST /feed/videos). The server's
// four types and 500 MB for everyone (FeedVideoCreateRequest); any length. The picker also names the extensions a
// system may know no type for, so those files are not hidden from it.
export const FEED_VIDEO_TYPES: ReadonlySet<string> = new Set(FEED_VIDEO_CONTENT_TYPES);
export const FEED_VIDEO_ACCEPT = [...FEED_VIDEO_TYPES, '.mov', '.mkv'].join(',');
export const FEED_MAX_VIDEO_BYTES = FEED_VIDEO_MAX_BYTES;
const FEED_VIDEO_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
	mp4: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime',
	mkv: 'video/x-matroska',
};

export type FeedVideoRejection = 'type' | 'size';

// Single choice; the server checks the same bounds and refuses repeated options.
export const FEED_POLL_MIN_OPTIONS = 2;
export const FEED_POLL_MAX_OPTIONS = 4;
export const FEED_POLL_OPTION_MAX_LENGTH = 80;
export const FEED_POLL_DURATIONS_HOURS = [1, 24, 72, 168] as const;

export function isFeedEnabled(): boolean {
	return LimitResolver.resolve({key: 'feature_feed', fallback: 0}) > 0;
}

// Off: no tabs, the page shows only the posts of the accounts you follow (GET /feed/discover answers 403).
export function isFeedDiscoverEnabled(): boolean {
	return LimitResolver.resolve({key: 'feature_feed_discover', fallback: 0}) > 0;
}

// Off: no suggestions beside the feed and no request (GET /feed/suggestions answers 403).
export function isFeedSuggestionsEnabled(): boolean {
	return LimitResolver.resolve({key: 'feature_feed_suggestions', fallback: 0}) > 0;
}

// Keşfet's image arm: off, a stranger's Discover post shows no media, and its comment GIFs stay links too.
export function isFeedDiscoverMediaEnabled(): boolean {
	return LimitResolver.resolve({key: 'feature_feed_discover_media', fallback: 0}) > 0;
}

// Off by default: the composer shows no video button (POST /feed/videos answers 403).
export function isFeedVideoEnabled(): boolean {
	return LimitResolver.resolve({key: 'feature_feed_video', fallback: 0}) > 0;
}

// Browsers give no type for a file the system has none for (often .mkv on Windows); the server needs one of its four.
// The copy only points at the picked file's bytes.
export function feedVideoFile(file: File): File {
	if (file.type) return file;
	const type = FEED_VIDEO_TYPE_BY_EXTENSION[file.name.split('.').pop()?.toLowerCase() ?? ''];
	return type ? new File([file], file.name, {type, lastModified: file.lastModified}) : file;
}

export function validateFeedVideo(file: File, maxBytes: number): FeedVideoRejection | null {
	if (!FEED_VIDEO_TYPES.has(file.type)) return 'type';
	if (file.size > maxBytes) return 'size';
	return null;
}

// Keeps the added files that fit a post and names the first reason one was left out. The server checks again; this
// only spares a request that would fail.
export function validateFeedImages(
	current: ReadonlyArray<File>,
	added: ReadonlyArray<File>,
	maxBytes: number,
): {accepted: Array<File>; rejection: FeedImageRejection | null} {
	const accepted: Array<File> = [];
	let rejection: FeedImageRejection | null = null;
	for (const file of added) {
		if (!FEED_IMAGE_TYPES.has(file.type)) {
			rejection ??= 'type';
		} else if (file.size > maxBytes) {
			rejection ??= 'size';
		} else if (current.length + accepted.length >= FEED_MAX_IMAGES) {
			rejection ??= 'count';
		} else {
			accepted.push(file);
		}
	}
	return {accepted, rejection};
}

// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {type FeedOutcome, outcomeOf} from '@app/features/feed/commands/FeedCommands';
import FeedPendingVideos from '@app/features/feed/state/FeedPendingVideos';
import FeedTimeline from '@app/features/feed/state/FeedTimeline';
import {FEED_MAX_VIDEO_BYTES, validateFeedVideo} from '@app/features/feed/utils/FeedUtils';
import {uploadFeedVideo} from '@app/features/feed/utils/FeedVideoUpload';
import {AccountScopedWork} from '@app/features/platform/state/AccountScopedWork';
import {http} from '@app/features/platform/transport/RestTransport';
import {HttpError} from '@app/features/platform/types/EndpointError';
import {Logger} from '@app/features/platform/utils/AppLogger';
import type {
	FeedPendingVideoListResponse,
	FeedPostResponse,
	FeedVideoUploadResponse,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';

const logger = new Logger('FeedVideoCommands');

// TEMPORARY: the author's client asks GET /feed/videos every 15 s while a video is encoded or checked and the list is
// on screen. Move to a gateway event to the author when the route passes 2 K requests/s.
export const FEED_VIDEO_POLL_MS = 15_000;

const uploads = new Map<string, AbortController>();
let pollTimer: ReturnType<typeof setTimeout> | null = null;
// How many lists of your videos are on screen (the post box of the feed page); polling runs only while one is.
let watchers = 0;
let generation = 0;

// Another account on this device (sign out, account switch) must not see the file names and first frames of these
// videos, nor keep sending them or asking for them. The server fails the unfinished uploads by itself after 9 h.
AccountScopedWork.registerCancellation(() => {
	generation++;
	for (const controller of uploads.values()) controller.abort();
	uploads.clear();
	stopPolling();
	FeedPendingVideos.reset();
});

AccountScopedWork.registerTransition({
	suspend: () => {},
	resume: () => {},
	released: (reason) => {
		if (reason !== 'logout' && watchers > 0) void refreshPending();
	},
});

// Starts the video post and gives 'ok' once the server holds it; the file then goes to Bunny in the background, shown
// by its row in FeedPendingVideos. The server posts the video with the text once it is encoded and checked.
export async function postVideo(file: File, options: {content: string}): Promise<FeedOutcome> {
	if (AccountScopedWork.isSuspended) return 'gone';
	const requestGeneration = generation;
	if (validateFeedVideo(file, FEED_MAX_VIDEO_BYTES)) return 'invalid';
	const text = options.content.trim();
	let ticket: FeedVideoUploadResponse;
	try {
		const response = await http.post<FeedVideoUploadResponse>(Endpoints.FEED_VIDEOS, {
			body: {
				filename: file.name.slice(0, 255),
				file_size: file.size,
				content_type: file.type,
				...(text.length > 0 && {content: text}),
			},
		});
		ticket = response.body;
	} catch (error) {
		if (requestGeneration !== generation) return 'gone';
		logger.warn('Failed to start a feed video:', error);
		if (error instanceof HttpError && error.status === 400) return 'invalid';
		return outcomeOf(error);
	}
	if (requestGeneration !== generation) return 'gone';
	FeedPendingVideos.handleUploadStarted(ticket.id, file);
	void upload(ticket.id, file, ticket);
	return 'ok';
}

async function upload(videoId: string, file: File, ticket: FeedVideoUploadResponse): Promise<void> {
	const requestGeneration = generation;
	const controller = new AbortController();
	uploads.set(videoId, controller);
	try {
		await uploadFeedVideo(file, ticket, {
			signal: controller.signal,
			uploadUrl: FeedPendingVideos.get(videoId)?.uploadUrl ?? undefined,
			onCreated: (uploadUrl) => {
				if (requestGeneration === generation) FeedPendingVideos.handleUploadCreated(videoId, uploadUrl);
			},
			onProgress: (sent, total) => {
				if (requestGeneration === generation) FeedPendingVideos.handleUploadProgress(videoId, sent / total);
			},
			resign: async () => {
				if (controller.signal.aborted || requestGeneration !== generation) {
					throw new DOMException('Upload cancelled', 'AbortError');
				}
				return (await http.post<FeedVideoUploadResponse>(Endpoints.FEED_VIDEO_SIGNATURE(videoId))).body;
			},
		});
		if (requestGeneration !== generation) return;
		FeedPendingVideos.handleUploaded(videoId);
		schedulePoll();
	} catch (error) {
		// Cancelled, or the account changed: whoever stopped it has dealt with the row.
		if (controller.signal.aborted) return;
		logger.warn(`Failed to upload feed video ${videoId}:`, error);
		// Never deleted here: the last PATCH may have landed although its answer was lost, and the server then encodes
		// the video. The row offers to resume; the server's list says whether it has the whole file after all.
		FeedPendingVideos.handleUploadFailed(videoId);
		void refreshPending();
	} finally {
		if (uploads.get(videoId) === controller) uploads.delete(videoId);
	}
}

// "Resume" on a failed row: a new signature (the server gives one for 6 h after the start), then the rest of the file
// from the offset Bunny has. 404: nothing to resume any more (the server has it all, failed it, or the 6 h passed).
export async function resumeVideo(videoId: string): Promise<FeedOutcome> {
	if (AccountScopedWork.isSuspended) return 'gone';
	const requestGeneration = generation;
	const video = FeedPendingVideos.get(videoId);
	if (!video?.file || !video.resumable || uploads.has(videoId)) return 'ok';
	let ticket: FeedVideoUploadResponse;
	try {
		ticket = (await http.post<FeedVideoUploadResponse>(Endpoints.FEED_VIDEO_SIGNATURE(videoId))).body;
	} catch (error) {
		if (requestGeneration !== generation) return 'gone';
		logger.warn(`Failed to resume feed video ${videoId}:`, error);
		const outcome = outcomeOf(error);
		if (outcome === 'gone') {
			FeedPendingVideos.handleResumeRefused(videoId);
			void refreshPending();
		}
		return outcome;
	}
	if (requestGeneration !== generation) return 'gone';
	FeedPendingVideos.handleUploadResumed(videoId);
	void upload(videoId, video.file, ticket);
	return 'ok';
}

// Stops sending and deletes the video, so it is never posted: only on your request. 404: already published or gone;
// the row goes either way.
export async function cancelVideo(videoId: string): Promise<FeedOutcome> {
	if (AccountScopedWork.isSuspended) return 'gone';
	const requestGeneration = generation;
	const sending = uploads.get(videoId);
	sending?.abort();
	try {
		await http.delete(Endpoints.FEED_VIDEO(videoId));
	} catch (error) {
		if (requestGeneration !== generation) return 'gone';
		const outcome = outcomeOf(error);
		if (outcome !== 'gone') {
			logger.warn(`Failed to cancel feed video ${videoId}:`, error);
			// Not sending any more: the row says so and can be removed again.
			if (sending) FeedPendingVideos.handleUploadFailed(videoId);
			return outcome;
		}
	}
	if (requestGeneration !== generation) return 'gone';
	FeedPendingVideos.handleRemoved(videoId);
	return 'ok';
}

// For a list of your videos on screen: loads the server's list and keeps it current until the returned stop runs.
export function watchPending(): () => void {
	let watching = true;
	watchers += 1;
	void refreshPending();
	return () => {
		if (!watching) return;
		watching = false;
		watchers -= 1;
		if (watchers === 0) stopPolling();
	};
}

// Your videos that are not posts yet; a video followed here that got published is added to your timelines. An answer
// that comes after the account changed belongs to the previous account and is dropped.
export async function refreshPending(): Promise<void> {
	if (AccountScopedWork.isSuspended) return;
	const requestGeneration = generation;
	try {
		const response = await http.get<FeedPendingVideoListResponse>(Endpoints.FEED_VIDEOS);
		if (requestGeneration !== generation) return;
		FeedPendingVideos.handleListed(response.body ?? []);
	} catch (error) {
		if (requestGeneration !== generation) return;
		logger.warn('Failed to list feed videos:', error);
	}
	const published = FeedPendingVideos.videos.flatMap((video) =>
		video.state === 'published' && video.postId ? [{videoId: video.id, postId: video.postId}] : [],
	);
	await Promise.all(
		published.map(async ({videoId, postId}) => {
			try {
				const response = await http.get<FeedPostResponse>(Endpoints.FEED_POST(postId));
				if (requestGeneration !== generation) return;
				if (response.body) FeedTimeline.handlePostCreated(response.body);
			} catch (error) {
				if (requestGeneration !== generation) return;
				logger.warn(`Failed to load the post of feed video ${videoId}:`, error);
			}
			if (requestGeneration !== generation) return;
			FeedPendingVideos.handleRemoved(videoId);
		}),
	);
	if (requestGeneration === generation) schedulePoll();
}

function schedulePoll(): void {
	if (AccountScopedWork.isSuspended || pollTimer !== null || watchers === 0 || !FeedPendingVideos.needsPolling) return;
	pollTimer = setTimeout(() => {
		pollTimer = null;
		if (document.visibilityState === 'visible') void refreshPending();
		else schedulePoll();
	}, FEED_VIDEO_POLL_MS);
}

function stopPolling(): void {
	if (pollTimer !== null) clearTimeout(pollTimer);
	pollTimer = null;
}

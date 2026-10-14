// SPDX-License-Identifier: AGPL-3.0-or-later

import {ResettableStates} from '@app/features/app/state/ResettableStates';
import {AccountScopedWork} from '@app/features/platform/state/AccountScopedWork';

import type {
	FeedPendingVideoResponse,
	FeedPendingVideoState,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {makeAutoObservable} from 'mobx';

// 'failed': the upload of this tab gave up while the server still waits for bytes; the row stays until you resume or
// remove it.
export type FeedPendingVideoStatus = FeedPendingVideoState | 'failed';

// Your videos on their way to becoming posts. Nobody else sees them before they are published (the server posts them).
export interface FeedPendingVideo {
	readonly id: string;
	readonly state: FeedPendingVideoStatus;
	readonly postId: string | null;
	// Only for an upload started in this tab: the picked file, and the share of it Bunny has while it is sent.
	readonly file: File | null;
	readonly progress: number | null;
	// The TUS upload Bunny made for it here, so a resumed upload goes on where the last one stopped.
	readonly uploadUrl: string | null;
	// Failed here with the file at hand, and the server has not refused a new signature for it.
	readonly resumable: boolean;
}

const STATE_ORDER: ReadonlyArray<FeedPendingVideoStatus> = ['uploading', 'processing', 'scanning', 'published'];

class FeedPendingVideos {
	videos: ReadonlyArray<FeedPendingVideo> = [];

	constructor() {
		makeAutoObservable(this, {}, {autoBind: true});
	}

	reset(): void {
		this.videos = [];
	}

	// The server only moves a video on by itself; polling is for those it is encoding or checking.
	get needsPolling(): boolean {
		return this.videos.some((video) => video.state === 'processing' || video.state === 'scanning');
	}

	get(videoId: string): FeedPendingVideo | null {
		return this.videos.find((video) => video.id === videoId) ?? null;
	}

	handleUploadStarted(videoId: string, file: File): void {
		this.videos = [
			{id: videoId, state: 'uploading', postId: null, file, progress: 0, uploadUrl: null, resumable: false},
			// A list asked for before the server made the video can come back after it and name it already.
			...this.videos.filter((video) => video.id !== videoId),
		];
	}

	handleUploadCreated(videoId: string, uploadUrl: string): void {
		this.update(videoId, {uploadUrl});
	}

	handleUploadResumed(videoId: string): void {
		this.update(videoId, {state: 'uploading', progress: 0, resumable: false});
	}

	handleResumeRefused(videoId: string): void {
		this.update(videoId, {resumable: false});
	}

	handleUploadProgress(videoId: string, progress: number): void {
		this.update(videoId, {progress});
	}

	handleUploaded(videoId: string): void {
		this.update(videoId, {state: 'processing', progress: null});
	}

	handleUploadFailed(videoId: string): void {
		const video = this.get(videoId);
		this.update(videoId, {state: 'failed', progress: null, resumable: video?.file != null});
	}

	handleRemoved(videoId: string): void {
		this.videos = this.videos.filter((video) => video.id !== videoId);
	}

	// GET /feed/videos. A video it lists never moves back (the server may not have seen the upload end yet), and one it
	// no longer lists is gone, unless this tab still sends it or it failed here. A failed upload stays failed only while
	// the server lists it as uploading: past that, the last bytes landed although their answer was lost. A published
	// video becomes a row only if it was followed before, so the posts of the last hour do not come back after a reload.
	handleListed(page: ReadonlyArray<FeedPendingVideoResponse>): void {
		const listedIds = new Set(page.map((entry) => entry.id));
		const kept = this.videos.filter(
			(video) => !listedIds.has(video.id) && (video.state === 'failed' || video.progress !== null),
		);
		const merged: Array<FeedPendingVideo> = [];
		for (const entry of page) {
			const known = this.get(entry.id);
			if (!known && entry.state === 'published') continue;
			const state =
				known &&
				((known.state === 'failed' && entry.state === 'uploading') ||
					STATE_ORDER.indexOf(known.state) > STATE_ORDER.indexOf(entry.state))
					? known.state
					: entry.state;
			merged.push({
				id: entry.id,
				state,
				postId: entry.post_id,
				file: known?.file ?? null,
				progress: state === 'uploading' ? (known?.progress ?? null) : null,
				uploadUrl: known?.uploadUrl ?? null,
				resumable: state === 'failed' && (known?.resumable ?? false),
			});
		}
		this.videos = [...kept, ...merged];
	}

	private update(videoId: string, patch: Partial<FeedPendingVideo>): void {
		this.videos = this.videos.map((video) => (video.id === videoId ? {...video, ...patch} : video));
	}
}

const feedPendingVideos = new FeedPendingVideos();
ResettableStates.register(feedPendingVideos, feedPendingVideos.reset);
AccountScopedWork.registerCancellation(() => feedPendingVideos.reset());

export default feedPendingVideos;

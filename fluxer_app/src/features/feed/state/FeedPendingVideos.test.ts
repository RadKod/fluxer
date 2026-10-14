// SPDX-License-Identifier: AGPL-3.0-or-later

import type {FeedPendingVideoResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {beforeEach, describe, expect, it} from 'vitest';

const {default: FeedPendingVideos} = await import('@app/features/feed/state/FeedPendingVideos');

const listed = (id: string, state: FeedPendingVideoResponse['state'], postId: string | null = null) => ({
	id,
	state,
	created_at: '2026-09-27T18:00:00.000Z',
	post_id: postId,
});
const clip = () => new File(['v'], 'clip.mp4', {type: 'video/mp4'});
const states = () => FeedPendingVideos.videos.map((video) => [video.id, video.state]);

describe('FeedPendingVideos', () => {
	beforeEach(() => FeedPendingVideos.reset());

	it('follows an upload of this tab from its progress to processing, and a failure', () => {
		const file = clip();
		FeedPendingVideos.handleUploadStarted('a', file);
		FeedPendingVideos.handleUploadProgress('a', 0.25);
		expect(FeedPendingVideos.videos).toEqual([
			expect.objectContaining({id: 'a', state: 'uploading', file, progress: 0.25, postId: null}),
		]);
		expect(FeedPendingVideos.needsPolling).toBe(false);
		FeedPendingVideos.handleUploaded('a');
		expect(FeedPendingVideos.videos[0]).toMatchObject({state: 'processing', progress: null});
		expect(FeedPendingVideos.needsPolling).toBe(true);

		FeedPendingVideos.handleUploadStarted('b', clip());
		FeedPendingVideos.handleUploadFailed('b');
		expect(states()).toEqual([
			['b', 'failed'],
			['a', 'processing'],
		]);
		FeedPendingVideos.handleRemoved('b');
		expect(states()).toEqual([['a', 'processing']]);
	});

	it('takes the server list without ever moving a video back, and keeps what only this tab knows yet', () => {
		FeedPendingVideos.handleUploadStarted('uploaded', clip());
		FeedPendingVideos.handleUploaded('uploaded');
		FeedPendingVideos.handleUploadStarted('sending', clip());
		FeedPendingVideos.handleUploadStarted('broken', clip());
		FeedPendingVideos.handleUploadFailed('broken');
		FeedPendingVideos.handleListed([listed('uploaded', 'uploading'), listed('elsewhere', 'scanning')]);
		expect(states()).toEqual([
			['broken', 'failed'],
			['sending', 'uploading'],
			['uploaded', 'processing'],
			['elsewhere', 'scanning'],
		]);
		expect(FeedPendingVideos.videos.find((video) => video.id === 'elsewhere')!.file).toBeNull();

		// Gone from the list: failed on the server, cancelled elsewhere or posted over an hour ago.
		FeedPendingVideos.handleListed([listed('elsewhere', 'scanning')]);
		expect(states()).toEqual([
			['broken', 'failed'],
			['sending', 'uploading'],
			['elsewhere', 'scanning'],
		]);
	});

	// The last PATCH can land while its answer is lost: the server then encodes a video this tab thinks failed.
	it('moves a failed upload on once the server has the whole file, and keeps it failed while it waits for bytes', () => {
		FeedPendingVideos.handleUploadStarted('a', clip());
		FeedPendingVideos.handleUploadFailed('a');
		FeedPendingVideos.handleListed([listed('a', 'uploading')]);
		expect(states()).toEqual([['a', 'failed']]);
		FeedPendingVideos.handleListed([listed('a', 'processing')]);
		expect(states()).toEqual([['a', 'processing']]);
	});

	it('can resume an upload of this tab that failed, from its TUS upload, until the server refuses', () => {
		FeedPendingVideos.handleUploadStarted('a', clip());
		FeedPendingVideos.handleUploadCreated('a', 'https://video.bunnycdn.com/tusupload/up-1');
		expect(FeedPendingVideos.get('a')).toMatchObject({resumable: false});
		FeedPendingVideos.handleUploadFailed('a');
		expect(FeedPendingVideos.get('a')).toMatchObject({
			state: 'failed',
			resumable: true,
			uploadUrl: 'https://video.bunnycdn.com/tusupload/up-1',
		});
		FeedPendingVideos.handleListed([listed('a', 'uploading')]);
		expect(FeedPendingVideos.get('a')).toMatchObject({resumable: true});
		FeedPendingVideos.handleUploadResumed('a');
		expect(FeedPendingVideos.get('a')).toMatchObject({state: 'uploading', progress: 0, resumable: false});
		FeedPendingVideos.handleUploadFailed('a');
		FeedPendingVideos.handleResumeRefused('a');
		expect(FeedPendingVideos.get('a')).toMatchObject({state: 'failed', resumable: false});
		// Known only from the server (another tab or device): nothing here to send.
		FeedPendingVideos.handleListed([listed('b', 'uploading')]);
		FeedPendingVideos.handleUploadFailed('b');
		expect(FeedPendingVideos.get('b')).toMatchObject({resumable: false});
	});

	it('marks a video it follows as published with its post, and ignores videos posted before it looked', () => {
		FeedPendingVideos.handleListed([listed('a', 'scanning')]);
		FeedPendingVideos.handleListed([listed('a', 'published', '900'), listed('old', 'published', '800')]);
		expect(FeedPendingVideos.videos).toEqual([expect.objectContaining({id: 'a', state: 'published', postId: '900'})]);
		expect(FeedPendingVideos.needsPolling).toBe(false);
	});
});

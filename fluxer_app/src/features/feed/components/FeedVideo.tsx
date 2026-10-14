// SPDX-License-Identifier: AGPL-3.0-or-later

import * as FeedCommands from '@app/features/feed/commands/FeedCommands';
import styles from '@app/features/feed/components/FeedVideo.module.css';
import {Logger} from '@app/features/platform/utils/AppLogger';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {VideoPlayer} from '@app/features/voice/components/media_player/components/VideoPlayer';
import {formatDuration} from '@fluxer/date_utils/src/DateDuration';
import type {FeedVideoResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {PlayIcon} from '@phosphor-icons/react';
import type Hls from 'hls.js';
import type React from 'react';
import {useEffect, useRef, useState} from 'react';

const logger = new Logger('FeedVideo');

const PLAY_VIDEO_DESCRIPTOR = msg({
	message: 'Play video',
	comment: 'Accessible label of the play button on the poster of a video in a feed post.',
});
const UNPLAYABLE_DESCRIPTOR = msg({
	message: "This video can't be played in this browser.",
	comment:
		'Shown in place of a feed post video when the browser can play neither its stream (HLS) nor an MP4 copy of it.',
});
const PLAYBACK_FAILED_DESCRIPTOR = msg({
	message: "Couldn't play this video.",
	comment: 'Shown in place of a feed post video when playing it stopped with an error (network or broken stream).',
});

const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl';
// The signed URLs work at least 2 h (or the video's length plus 30 min, at most 6 h) after the post was loaded; closer to
// their end than the video's length and this, the post is loaded again (the segments are fetched as it plays).
const URL_RENEW_BEFORE_MS = 10 * 60 * 1000;

const urlsRunOut = (video: FeedVideoResponse) =>
	Date.parse(video.expires_at) - Date.now() < URL_RENEW_BEFORE_MS + (video.duration ?? 0) * 1000;

// The URLs are taken when playing starts, so a refetched post (new signed URLs) does not restart a playing video.
type Playback =
	| {kind: 'poster'}
	| {kind: 'starting'}
	| {kind: 'player'; src: string}
	| {kind: 'hls'; Hls: typeof Hls; src: string}
	| {kind: 'unplayable'}
	| {kind: 'failed'};

// Native HLS (Safari, iOS), else hls.js where Media Source works (loaded here, on the first play, as its own chunk),
// else the MP4 copy when the server has one.
async function choosePlayback(video: FeedVideoResponse): Promise<Playback> {
	if (document.createElement('video').canPlayType(HLS_MIME_TYPE) !== '') return {kind: 'player', src: video.hls_url};
	try {
		// The light build (no subtitles, alternate audio or DRM): Bunny's HLS has its audio in the video segments.
		const {default: HlsPlayer} = await import('hls.js/light');
		if (HlsPlayer.isSupported()) return {kind: 'hls', Hls: HlsPlayer, src: video.hls_url};
	} catch (error) {
		logger.warn('hls.js failed to load:', error);
	}
	return video.mp4_url ? {kind: 'player', src: video.mp4_url} : {kind: 'unplayable'};
}

// Only the poster until the play button is pressed: no video, playlist or hls.js request before that.
export function FeedVideo({postId, video}: {postId: string; video: FeedVideoResponse}) {
	const {i18n} = useLingui();
	const [playback, setPlayback] = useState<Playback>({kind: 'poster'});
	const videoRef = useRef<HTMLVideoElement>(null);
	const posterReloaded = useRef(false);
	useEffect(() => {
		const media = videoRef.current;
		if (playback.kind !== 'hls' || !media) return;
		const player = new playback.Hls({enableWorker: true, lowLatencyMode: false});
		player.on(playback.Hls.Events.ERROR, (_event, data) => {
			if (!data.fatal) return;
			logger.warn('Feed video playback failed:', data.type, data.details);
			setPlayback({kind: 'failed'});
		});
		player.loadSource(playback.src);
		player.attachMedia(media);
		return () => player.destroy();
	}, [playback]);
	const start = async () => {
		if (playback.kind !== 'poster') return;
		setPlayback({kind: 'starting'});
		// A page left open for a day: new URLs first (the reloaded post also replaces this one's props).
		const current = urlsRunOut(video) ? ((await FeedCommands.reloadPost(postId))?.video ?? video) : video;
		setPlayback(await choosePlayback(current));
	};
	// An expired poster URL answers 403. Once per video shown, and only near the end of the URLs, so a CDN failure does
	// not turn into a reload from every viewer.
	const reloadPoster = () => {
		if (posterReloaded.current || !urlsRunOut(video)) return;
		posterReloaded.current = true;
		void FeedCommands.reloadPost(postId);
	};
	const ratio = video.width && video.height ? `${video.width} / ${video.height}` : '16 / 9';
	return (
		<div
			className={styles.video}
			style={{'--feed-video-ratio': ratio} as React.CSSProperties}
			data-flx="feed.feed-video.video"
		>
			{(playback.kind === 'poster' || playback.kind === 'starting') && (
				<FocusRing offset={-2} data-flx="feed.feed-video.focus-ring">
					<button
						type="button"
						className={styles.poster}
						onClick={start}
						aria-label={i18n._(PLAY_VIDEO_DESCRIPTOR)}
						aria-busy={playback.kind === 'starting'}
						data-flx="feed.feed-video.poster.start"
					>
						<img
							src={video.poster_url}
							alt=""
							className={styles.posterImage}
							onError={reloadPoster}
							data-flx="feed.feed-video.poster-image"
						/>
						<span className={styles.play} aria-hidden="true" data-flx="feed.feed-video.play">
							<PlayIcon weight="fill" className={styles.playIcon} data-flx="feed.feed-video.play-icon" />
						</span>
						{video.duration != null && (
							<span className={styles.duration} data-flx="feed.feed-video.duration">
								{formatDuration(video.duration, i18n.locale)}
							</span>
						)}
					</button>
				</FocusRing>
			)}
			{playback.kind === 'player' && (
				<VideoPlayer
					src={playback.src}
					poster={video.poster_url}
					width={video.width ?? undefined}
					height={video.height ?? undefined}
					duration={video.duration ?? undefined}
					autoPlay
					fillContainer
					className={styles.player}
					data-flx="feed.feed-video.video-player"
				/>
			)}
			{/* VideoPlayer takes no ref to its <video>, so hls.js gets its own element with the browser's controls. */}
			{playback.kind === 'hls' && (
				<video
					ref={videoRef}
					className={styles.player}
					poster={video.poster_url}
					controls
					autoPlay
					playsInline
					data-flx="feed.feed-video.hls-video"
				>
					<track kind="captions" data-flx="feed.feed-video.track" />
				</video>
			)}
			{(playback.kind === 'unplayable' || playback.kind === 'failed') && (
				<p className={styles.status} role="status" data-flx="feed.feed-video.status">
					{i18n._(playback.kind === 'failed' ? PLAYBACK_FAILED_DESCRIPTOR : UNPLAYABLE_DESCRIPTOR)}
				</p>
			)}
		</div>
	);
}

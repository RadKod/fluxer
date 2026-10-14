// SPDX-License-Identifier: AGPL-3.0-or-later

import * as FeedVideoCommands from '@app/features/feed/commands/FeedVideoCommands';
import {toastFeedFailure} from '@app/features/feed/components/FeedItemMenu';
import styles from '@app/features/feed/components/FeedPendingVideos.module.css';
import PendingVideos, {type FeedPendingVideo} from '@app/features/feed/state/FeedPendingVideos';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import {formatDuration} from '@fluxer/date_utils/src/DateDuration';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {ArrowClockwiseIcon, VideoCameraIcon, XIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {useEffect, useMemo, useState} from 'react';

const UPLOADING_SHARE_DESCRIPTOR = msg({
	message: 'Uploading · {percent}% · posted when ready',
	comment:
		'Status under a video you are posting to the feed while this device sends it. {percent} is how much is sent, 0 to 100. The post appears by itself once the video is processed and checked.',
});
const UPLOADING_DESCRIPTOR = msg({
	message: 'Uploading · posted when ready',
	comment:
		'Status under a video you are posting to the feed while it is sent from another tab or device. The post appears by itself once the video is processed and checked.',
});
const PROCESSING_DESCRIPTOR = msg({
	message: 'Processing · posted when ready',
	comment:
		'Status under a video you are posting to the feed once it is sent, while it is converted and checked. The post appears by itself once it is ready.',
});
const UPLOAD_FAILED_DESCRIPTOR = msg({
	message: 'The upload failed',
	comment:
		'Status under a video you were posting to the feed when sending it stopped. It is not posted; a button beside it may resume the upload.',
});
const RESUME_UPLOAD_DESCRIPTOR = msg({
	message: 'Resume upload',
	comment:
		'Accessible label and tooltip of the button beside a feed video whose upload stopped: it sends the rest of the file from where it stopped.',
});
const VIDEO_DESCRIPTOR = msg({
	message: 'Video',
	comment:
		'Name of a video you are posting to the feed when its file name is not known here (it was started in another tab or device).',
});
const CANCEL_VIDEO_DESCRIPTOR = msg({
	message: 'Cancel video',
	comment:
		'Accessible label and tooltip of the button beside a video you are posting to the feed: it stops the video, which is then never posted.',
});

// In the post box: your videos until the server posts them.
export const FeedPendingVideos = observer(() => {
	useEffect(() => FeedVideoCommands.watchPending(), []);
	const videos = PendingVideos.videos.filter((video) => video.state !== 'published');
	if (videos.length === 0) return null;
	return (
		<ul className={styles.list} data-flx="feed.feed-pending-videos.list">
			{videos.map((video) => (
				<PendingVideoRow key={video.id} video={video} data-flx="feed.feed-pending-videos.pending-video-row" />
			))}
		</ul>
	);
});

const PendingVideoRow = observer(({video}: {video: FeedPendingVideo}) => {
	const {i18n} = useLingui();
	const [duration, setDuration] = useState<number | null>(null);
	const [isCancelling, setIsCancelling] = useState(false);
	const [isResuming, setIsResuming] = useState(false);
	const previewUrl = useMemo(() => (video.file ? URL.createObjectURL(video.file) : null), [video.file]);
	useEffect(
		() => () => {
			if (previewUrl) URL.revokeObjectURL(previewUrl);
		},
		[previewUrl],
	);
	const percent = video.progress === null ? null : Math.floor(video.progress * 100);
	const status = (() => {
		switch (video.state) {
			case 'failed':
				return i18n._(UPLOAD_FAILED_DESCRIPTOR);
			case 'uploading':
				return percent === null ? i18n._(UPLOADING_DESCRIPTOR) : i18n._(UPLOADING_SHARE_DESCRIPTOR, {percent});
			default:
				return i18n._(PROCESSING_DESCRIPTOR);
		}
	})();
	const name = video.file?.name ?? i18n._(VIDEO_DESCRIPTOR);
	const cancelLabel = i18n._(CANCEL_VIDEO_DESCRIPTOR);
	const resumeLabel = i18n._(RESUME_UPLOAD_DESCRIPTOR);
	const cancel = async () => {
		setIsCancelling(true);
		const outcome = await FeedVideoCommands.cancelVideo(video.id);
		setIsCancelling(false);
		if (outcome !== 'ok') toastFeedFailure(i18n, outcome);
	};
	// 'gone' needs no toast: the row stays failed and the button goes, which says it.
	const resume = async () => {
		setIsResuming(true);
		const outcome = await FeedVideoCommands.resumeVideo(video.id);
		setIsResuming(false);
		if (outcome !== 'ok' && outcome !== 'gone') toastFeedFailure(i18n, outcome);
	};
	return (
		<li className={styles.row} data-flx="feed.feed-pending-videos.pending-video-row.row">
			<div className={styles.thumb} data-flx="feed.feed-pending-videos.pending-video-row.thumb">
				{previewUrl ? (
					<video
						src={previewUrl}
						muted
						playsInline
						preload="metadata"
						aria-hidden
						className={styles.preview}
						onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
						data-flx="feed.feed-pending-videos.pending-video-row.preview"
					/>
				) : (
					<VideoCameraIcon
						weight="bold"
						className={styles.thumbIcon}
						aria-hidden
						data-flx="feed.feed-pending-videos.pending-video-row.thumb-icon"
					/>
				)}
				{duration !== null && Number.isFinite(duration) && (
					<span className={styles.duration} data-flx="feed.feed-pending-videos.pending-video-row.duration">
						{formatDuration(duration, i18n.locale)}
					</span>
				)}
			</div>
			<div data-flx="feed.feed-pending-videos.pending-video-row.div">
				<p className={styles.name} data-flx="feed.feed-pending-videos.pending-video-row.name">
					{name}
				</p>
				<p className={styles.status} data-flx="feed.feed-pending-videos.pending-video-row.status">
					{status}
				</p>
				{video.state !== 'failed' && (
					<div
						className={styles.meter}
						role="progressbar"
						aria-label={name}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={percent ?? undefined}
						data-flx="feed.feed-pending-videos.pending-video-row.meter"
					>
						{percent === null ? (
							<div className={styles.meterPulse} data-flx="feed.feed-pending-videos.pending-video-row.meter-pulse" />
						) : (
							<div
								className={styles.meterValue}
								style={{width: `${percent}%`}}
								data-flx="feed.feed-pending-videos.pending-video-row.meter-value"
							/>
						)}
					</div>
				)}
			</div>
			<div className={styles.actions} data-flx="feed.feed-pending-videos.pending-video-row.actions">
				{video.state === 'failed' && video.resumable && (
					<FocusRing offset={-2} data-flx="feed.feed-pending-videos.pending-video-row.resume-focus-ring">
						<Tooltip text={resumeLabel} data-flx="feed.feed-pending-videos.pending-video-row.resume-tooltip">
							<button
								type="button"
								className={styles.cancel}
								onClick={resume}
								disabled={isResuming}
								aria-label={resumeLabel}
								data-flx="feed.feed-pending-videos.pending-video-row.resume.button"
							>
								<ArrowClockwiseIcon
									weight="bold"
									className={styles.cancelIcon}
									aria-hidden
									data-flx="feed.feed-pending-videos.pending-video-row.resume-icon"
								/>
							</button>
						</Tooltip>
					</FocusRing>
				)}
				<FocusRing offset={-2} data-flx="feed.feed-pending-videos.pending-video-row.focus-ring">
					<Tooltip text={cancelLabel} data-flx="feed.feed-pending-videos.pending-video-row.tooltip">
						<button
							type="button"
							className={styles.cancel}
							onClick={cancel}
							disabled={isCancelling}
							aria-label={cancelLabel}
							data-flx="feed.feed-pending-videos.pending-video-row.cancel.button"
						>
							<XIcon
								weight="bold"
								className={styles.cancelIcon}
								aria-hidden
								data-flx="feed.feed-pending-videos.pending-video-row.cancel-icon"
							/>
						</button>
					</Tooltip>
				</FocusRing>
			</div>
		</li>
	);
});

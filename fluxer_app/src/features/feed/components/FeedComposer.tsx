// SPDX-License-Identifier: AGPL-3.0-or-later

import Authentication from '@app/features/auth/state/Authentication';
import attachmentStyles from '@app/features/channel/components/ChannelAttachmentArea.module.css';
import type {Gif} from '@app/features/expressions/commands/GifCommands';
import {downloadGifAsImageFile} from '@app/features/expressions/utils/GifFileDownload';
import * as FeedCommands from '@app/features/feed/commands/FeedCommands';
import * as FeedVideoCommands from '@app/features/feed/commands/FeedVideoCommands';
import styles from '@app/features/feed/components/FeedComposer.module.css';
import {FeedExpressionButtons} from '@app/features/feed/components/FeedExpressionButtons';
import {toastFeedFailure} from '@app/features/feed/components/FeedItemMenu';
import {FeedPendingVideos} from '@app/features/feed/components/FeedPendingVideos';
import {EMPTY_FEED_POLL, type FeedPollDraft, FeedPollEditor} from '@app/features/feed/components/FeedPollEditor';
import FeedTabs from '@app/features/feed/state/FeedTabs';
import {
	FEED_IMAGE_ACCEPT,
	FEED_MAX_IMAGE_BYTES,
	FEED_MAX_IMAGES,
	FEED_MAX_VIDEO_BYTES,
	FEED_POLL_MIN_OPTIONS,
	FEED_VIDEO_ACCEPT,
	FEED_VIDEO_TYPES,
	type FeedImageRejection,
	type FeedVideoRejection,
	feedVideoFile,
	isFeedVideoEnabled,
	validateFeedImages,
	validateFeedVideo,
} from '@app/features/feed/utils/FeedUtils';
import {SENT_DESCRIPTOR, SOMETHING_WENT_WRONG_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {openFilePicker} from '@app/features/messaging/utils/FilePickerUtils';
import {formatFileSize} from '@app/features/messaging/utils/FileUtils';
import {Button} from '@app/features/ui/button/Button';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {Avatar} from '@app/features/ui/components/Avatar';
import {Textarea} from '@app/features/ui/components/form/FormInput';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import Users from '@app/features/user/state/Users';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {ChartBarIcon, ImageIcon, TrashIcon, VideoCameraIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useEffect, useMemo, useRef, useState} from 'react';

const POST_MAX_LENGTH = 2000;

const WHAT_S_NEW_DESCRIPTOR = msg({
	message: "What's new?",
	comment: 'Placeholder and accessible label of the text box where you write a new feed post.',
});
const ADD_IMAGES_DESCRIPTOR = msg({
	message: 'Add images',
	comment: 'Button under the new post box that picks images to attach to the post.',
});
const POST_DESCRIPTOR = msg({
	message: 'Post',
	comment: 'Button that publishes the new feed post. Verb. Keep it concise.',
});
const REMOVE_IMAGE_DESCRIPTOR = msg({
	message: 'Remove image',
	comment: 'Accessible label of the button that takes an image out of the new feed post before it is posted.',
});
const IMAGE_TYPE_REJECTED_DESCRIPTOR = msg({
	message: 'Only PNG, JPEG, WebP and GIF images can be added to a post.',
	comment: 'Toast when a picked file is not an image type a feed post accepts.',
});
const IMAGE_COUNT_REJECTED_DESCRIPTOR = msg({
	message: '{maxImages, plural, one {A post can have # image.} other {A post can have up to # images.}}',
	comment: 'Toast when more images are picked than a feed post can hold. {maxImages} is that maximum.',
});
const IMAGE_SIZE_REJECTED_DESCRIPTOR = msg({
	message: 'Each image must be {maxSize} or smaller.',
	comment: 'Toast when a picked image is too large for a feed post. {maxSize} is the limit, for example "10 MB".',
});
const ADD_POLL_DESCRIPTOR = msg({
	message: 'Add poll',
	comment: 'Button under the new post box that adds a poll to the post. The post text becomes the question.',
});
const REMOVE_POLL_DESCRIPTOR = msg({
	message: 'Remove poll',
	comment: 'The same button once a poll is added: it takes the poll out of the new feed post.',
});
const ADD_VIDEO_DESCRIPTOR = msg({
	message: 'Add video',
	comment: 'Button under the new post box that picks one video to attach to the post.',
});
const REMOVE_VIDEO_DESCRIPTOR = msg({
	message: 'Remove video',
	comment: 'Accessible label of the button that takes the video out of the new feed post before it is posted.',
});
const VIDEO_TYPE_REJECTED_DESCRIPTOR = msg({
	message: 'Only MP4, WebM, MOV and MKV videos can be added to a post.',
	comment: 'Toast when a picked file is not a video type a feed post accepts. MOV and MKV are file formats.',
});
const VIDEO_SIZE_REJECTED_DESCRIPTOR = msg({
	message: 'A video must be {maxSize} or smaller.',
	comment: 'Toast when a picked video is too large for a feed post. {maxSize} is the limit, for example "500 MB".',
});

// announcePosted: say "Sent" after posting, where the shown list does not get your new post (Discover).
export const FeedComposer = observer(({announcePosted = false}: {announcePosted?: boolean}) => {
	const {i18n} = useLingui();
	// What you were writing before a post page, if it was this account; kept again for the account that wrote it
	// (the one of the mount, also when another signs in meanwhile) when the box goes away.
	const [{userId, kept}] = useState(() => {
		const draft = FeedTabs.composerDraft;
		return {userId: Authentication.currentUserId, kept: draft?.userId === Authentication.currentUserId ? draft : null};
	});
	const [text, setText] = useState(kept?.text ?? '');
	// Up to four images, or one video alone (the server refuses a mix, and media with a poll).
	const [files, setFiles] = useState<Array<File>>(() => [...(kept?.files ?? [])]);
	const [poll, setPoll] = useState<FeedPollDraft | null>(kept?.poll ?? null);
	const draftRef = useRef({text, files, poll});
	draftRef.current = {text, files, poll};
	useEffect(() => () => FeedTabs.setComposerDraft({userId, ...draftRef.current}), [userId]);
	const [isPosting, setIsPosting] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const previewUrls = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);
	useEffect(() => () => previewUrls.forEach((url) => URL.revokeObjectURL(url)), [previewUrls]);
	const maxBytes = Math.min(FEED_MAX_IMAGE_BYTES, Users.currentUser?.maxAttachmentFileSize ?? FEED_MAX_IMAGE_BYTES);
	const isVideo = (file: File) => FEED_VIDEO_TYPES.has(file.type);
	const hasVideo = files.some(isVideo);
	const rejectionText = (rejection: FeedImageRejection): string => {
		switch (rejection) {
			case 'type':
				return i18n._(IMAGE_TYPE_REJECTED_DESCRIPTOR);
			case 'count':
				return i18n._(IMAGE_COUNT_REJECTED_DESCRIPTOR, {maxImages: FEED_MAX_IMAGES});
			case 'size':
				return i18n._(IMAGE_SIZE_REJECTED_DESCRIPTOR, {maxSize: formatFileSize(i18n.locale, maxBytes)});
		}
	};
	const videoRejectionText = (rejection: FeedVideoRejection): string => {
		switch (rejection) {
			case 'type':
				return i18n._(VIDEO_TYPE_REJECTED_DESCRIPTOR);
			case 'size':
				return i18n._(VIDEO_SIZE_REJECTED_DESCRIPTOR, {maxSize: formatFileSize(i18n.locale, FEED_MAX_VIDEO_BYTES)});
		}
	};
	// Reads the draft as it is now, not as this render saw it: picked files and a GIF land after an await, when images, a
	// poll or a video may have come meanwhile.
	const addFiles = (added: ReadonlyArray<File>) => {
		const {files: current, poll: currentPoll} = draftRef.current;
		if (added.length === 0 || currentPoll || current.some(isVideo)) return;
		const {accepted, rejection} = validateFeedImages(current, added, maxBytes);
		if (accepted.length > 0) setFiles([...current, ...accepted]);
		if (rejection) ToastCommands.error(rejectionText(rejection));
	};
	const pickImages = async () => {
		addFiles(await openFilePicker({multiple: true, accept: FEED_IMAGE_ACCEPT}));
	};
	// A GIF from the picker becomes one of the post's images: fetched through our media proxy and uploaded like a picked
	// file, so readers load it from our storage and never from the GIF provider. One at a time, and dropped when a post
	// is being sent by the time it arrives.
	const [isAddingGif, setIsAddingGif] = useState(false);
	const isPostingRef = useRef(isPosting);
	isPostingRef.current = isPosting;
	const addGif = async (gif: Gif) => {
		setIsAddingGif(true);
		let file: File;
		try {
			file = await downloadGifAsImageFile(gif);
		} catch {
			ToastCommands.error(i18n._(SOMETHING_WENT_WRONG_DESCRIPTOR));
			return;
		} finally {
			setIsAddingGif(false);
		}
		if (!isPostingRef.current) addFiles([file]);
	};
	// 500 MB for everyone and any length (Bunny Stream); a refused file is never uploaded.
	const pickVideo = async () => {
		const [picked] = await openFilePicker({accept: FEED_VIDEO_ACCEPT});
		if (!picked) return;
		const file = feedVideoFile(picked);
		const rejection = validateFeedVideo(file, FEED_MAX_VIDEO_BYTES);
		if (rejection) ToastCommands.error(videoRejectionText(rejection));
		else setFiles([file]);
	};
	// The post text is the poll question. Answers go trimmed and without empty boxes, and must differ: the server refuses
	// repeats regardless of case.
	const pollOptions = poll?.options.map((option) => option.trim()).filter((option) => option.length > 0) ?? [];
	const isPollReady =
		pollOptions.length >= FEED_POLL_MIN_OPTIONS &&
		new Set(pollOptions.map((option) => option.toLowerCase())).size === pollOptions.length;
	const hasText = text.trim().length > 0;
	const canPost = !isPosting && (poll ? hasText && isPollReady : hasText || files.length > 0);
	const submit = async () => {
		if (!canPost) return;
		setIsPosting(true);
		// A video is sent in the background after this and shows as a row until the server posts it.
		const outcome = hasVideo
			? await FeedVideoCommands.postVideo(files[0]!, {content: text})
			: await FeedCommands.createPost(text, files, {
					poll: poll && {options: pollOptions, durationHours: poll.durationHours},
				});
		setIsPosting(false);
		if (outcome === 'ok') {
			setText('');
			setFiles([]);
			setPoll(null);
			if (announcePosted && !hasVideo) ToastCommands.success(i18n._(SENT_DESCRIPTOR));
			return;
		}
		toastFeedFailure(i18n, outcome);
	};
	const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			void submit();
		}
	};
	const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
		const pasted = Array.from(event.clipboardData.files);
		if (pasted.length === 0) return;
		event.preventDefault();
		addFiles(pasted);
	};
	const placeholder = i18n._(WHAT_S_NEW_DESCRIPTOR);
	const removeLabel = i18n._(hasVideo ? REMOVE_VIDEO_DESCRIPTOR : REMOVE_IMAGE_DESCRIPTOR);
	const addImagesLabel = i18n._(ADD_IMAGES_DESCRIPTOR);
	const pollLabel = i18n._(poll ? REMOVE_POLL_DESCRIPTOR : ADD_POLL_DESCRIPTOR);
	const addVideoLabel = i18n._(ADD_VIDEO_DESCRIPTOR);
	const currentUser = Users.currentUser;
	return (
		<div className={styles.composer} data-flx="feed.feed-composer.composer">
			{currentUser && <Avatar user={currentUser} size={40} data-flx="feed.feed-composer.avatar" />}
			<div className={styles.body} data-flx="feed.feed-composer.body">
				<div className={styles.field} data-flx="feed.feed-composer.field">
					<Textarea
						ref={textareaRef}
						label={null}
						aria-label={placeholder}
						placeholder={placeholder}
						value={text}
						onChange={(event) => setText(event.target.value)}
						onKeyDown={handleKeyDown}
						onPaste={handlePaste}
						maxLength={POST_MAX_LENGTH}
						minRows={2}
						maxRows={6}
						disabled={isPosting}
						data-flx="feed.feed-composer.textarea"
					/>
				</div>
				{isFeedVideoEnabled() && <FeedPendingVideos data-flx="feed.feed-composer.feed-pending-videos" />}
				{files.length > 0 && (
					<div className={styles.images} data-flx="feed.feed-composer.images">
						<ul className={attachmentStyles.channelAttachmentArea} data-flx="feed.feed-composer.image-list">
							{files.map((file, index) => (
								<li
									key={previewUrls[index]}
									className={attachmentStyles.upload}
									data-flx="feed.feed-composer.image-list.upload"
								>
									<div className={attachmentStyles.uploadContainer} data-flx="feed.feed-composer.upload-container">
										<div className={attachmentStyles.mediaContainer} data-flx="feed.feed-composer.media-container">
											{isVideo(file) ? (
												<video
													src={previewUrls[index]}
													muted
													playsInline
													aria-label={file.name}
													className={attachmentStyles.media}
													data-flx="feed.feed-composer.video"
												/>
											) : (
												<img
													src={previewUrls[index]}
													alt={file.name}
													className={attachmentStyles.media}
													data-flx="feed.feed-composer.media"
												/>
											)}
										</div>
										<div
											className={attachmentStyles.actionBarContainer}
											data-flx="feed.feed-composer.action-bar-container"
										>
											<div className={attachmentStyles.actionBar} data-flx="feed.feed-composer.action-bar">
												<Tooltip text={removeLabel} data-flx="feed.feed-composer.tooltip">
													<button
														type="button"
														className={clsx(attachmentStyles.button, attachmentStyles.danger)}
														onClick={() => setFiles(files.filter((_, fileIndex) => fileIndex !== index))}
														disabled={isPosting}
														aria-label={removeLabel}
														data-flx="feed.feed-composer.button.remove-image"
													>
														<TrashIcon
															className={attachmentStyles.actionBarIcon}
															data-flx="feed.feed-composer.trash-icon"
														/>
													</button>
												</Tooltip>
											</div>
										</div>
									</div>
								</li>
							))}
						</ul>
					</div>
				)}
				{poll && (
					<FeedPollEditor
						options={poll.options}
						durationHours={poll.durationHours}
						onChange={setPoll}
						disabled={isPosting}
						data-flx="feed.feed-composer.feed-poll-editor"
					/>
				)}
				<div className={styles.footer} data-flx="feed.feed-composer.footer">
					<div className={styles.tools} data-flx="feed.feed-composer.tools">
						<FocusRing offset={-2} data-flx="feed.feed-composer.focus-ring">
							<Tooltip text={addImagesLabel} data-flx="feed.feed-composer.add-images-tooltip">
								<button
									type="button"
									className={styles.toolButton}
									onClick={pickImages}
									disabled={isPosting || poll !== null || hasVideo || files.length >= FEED_MAX_IMAGES}
									aria-label={addImagesLabel}
									data-flx="feed.feed-composer.add-images-button.pick-images"
								>
									<ImageIcon
										weight="bold"
										className={styles.toolIcon}
										aria-hidden
										data-flx="feed.feed-composer.image-icon"
									/>
								</button>
							</Tooltip>
						</FocusRing>
						{isFeedVideoEnabled() && (
							<FocusRing offset={-2} data-flx="feed.feed-composer.video-focus-ring">
								<Tooltip text={addVideoLabel} data-flx="feed.feed-composer.add-video-tooltip">
									<button
										type="button"
										className={styles.toolButton}
										onClick={pickVideo}
										disabled={isPosting || poll !== null || files.length > 0}
										aria-label={addVideoLabel}
										data-flx="feed.feed-composer.tool-button.pick-video"
									>
										<VideoCameraIcon
											weight="bold"
											className={styles.toolIcon}
											aria-hidden
											data-flx="feed.feed-composer.video-camera-icon"
										/>
									</button>
								</Tooltip>
							</FocusRing>
						)}
						<FocusRing offset={-2} data-flx="feed.feed-composer.poll-focus-ring">
							<Tooltip text={pollLabel} data-flx="feed.feed-composer.poll-tooltip">
								<button
									type="button"
									className={styles.toolButton}
									onClick={() => setPoll(poll ? null : EMPTY_FEED_POLL)}
									disabled={isPosting || files.length > 0}
									aria-label={pollLabel}
									data-flx="feed.feed-composer.tool-button.toggle-poll"
								>
									<ChartBarIcon
										weight="bold"
										className={styles.toolIcon}
										aria-hidden
										data-flx="feed.feed-composer.chart-bar-icon"
									/>
								</button>
							</Tooltip>
						</FocusRing>
						<FeedExpressionButtons
							textareaRef={textareaRef}
							value={text}
							onChange={setText}
							maxLength={POST_MAX_LENGTH}
							disabled={isPosting}
							onGif={addGif}
							gifDisabled={isAddingGif || poll !== null || hasVideo || files.length >= FEED_MAX_IMAGES}
							buttonClassName={styles.toolButton}
							iconClassName={styles.toolIcon}
							data-flx="feed.feed-composer.feed-expression-buttons"
						/>
					</div>
					<Button
						small
						fitContent
						className={styles.postButton}
						onClick={submit}
						disabled={!canPost}
						submitting={isPosting}
						data-flx="feed.feed-composer.button.submit"
					>
						{i18n._(POST_DESCRIPTOR)}
					</Button>
				</div>
			</div>
		</div>
	);
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import Authentication from '@app/features/auth/state/Authentication';
import type {Channel} from '@app/features/channel/models/Channel';
import ExperimentAssignments from '@app/features/experiment/state/ExperimentAssignments';
import {Button} from '@app/features/ui/button/Button';
import {Avatar} from '@app/features/ui/components/Avatar';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import {getStreamKey} from '@app/features/voice/components/StreamKeys';
import {useStreamWatchState} from '@app/features/voice/components/useStreamWatchState';
import type {VoiceParticipantAvatarEntry} from '@app/features/voice/components/VoiceParticipantAvatarList';
import {stopWatchingStreamKey} from '@app/features/voice/engine/VoiceStreamWatchState';
import PopoutWindowManager, {getVoiceTilePopoutKey} from '@app/features/voice/state/PopoutWindowManager';
import {buildVoiceParticipantIdentity} from '@app/features/voice/utils/VoiceParticipantIdentity';
import {useCameraMode} from '@app/features/voice_scene/components/useCameraMode';
import {anchorScale, VoiceSceneAnchor} from '@app/features/voice_scene/components/VoiceSceneAnchor';
import styles from '@app/features/voice_scene/components/VoiceSceneOverlay.module.css';
import tvStyles from '@app/features/voice_scene/components/VoiceSceneTv.module.css';
import {VoiceSceneTvPicker} from '@app/features/voice_scene/components/VoiceSceneTvPicker';
import {useTvScreenShareDemand} from '@app/features/voice_scene/hooks/useTvScreenShareDemand';
import type {Vec3, VoiceSceneHandle} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import VoiceSceneSettings from '@app/features/voice_scene/state/VoiceSceneSettings';
import VoiceSceneTvRequest from '@app/features/voice_scene/state/VoiceSceneTvRequest';
import RoomCameraStore from '@app/features/voice_scene/video/RoomCameraStore';
import {defaultTvSource, type TvSource, tvSources} from '@app/features/voice_scene/video/TvSource';
import {readVoiceRoomAssignment} from '@fluxer/schema/src/domains/experiment/ExperimentSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {type TrackReference, VideoTrack} from '@livekit/components-react';
import {type RemoteTrackPublication, type Room, Track} from 'livekit-client';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

const WATCH_DESCRIPTOR = msg({
	message: 'Watch',
	comment: "3D voice room TV: button that starts playing someone's screen share or camera on the room's TV.",
});
const CLOSE_DESCRIPTOR = msg({
	message: 'Close',
	comment: '3D voice room TV: button that stops playing the screen share or camera on the TV.',
});
const FULL_SCREEN_DESCRIPTOR = msg({
	message: 'Full screen',
	comment: '3D voice room TV: button that shows what plays on the TV in the full screen call view.',
});
const SHARING_DESCRIPTOR = msg({
	message: '{displayName} is sharing their screen',
	comment: "3D voice room TV: poster on the TV while someone shares their screen. {displayName} is that person's name.",
});
const CAMERA_POSTER_DESCRIPTOR = msg({
	message: "{displayName}'s camera",
	comment: "3D voice room TV: poster on the TV when this viewer picked someone's camera. {displayName} is the name.",
});

const POSTER_AVATAR_SIZE = 28;
// Past 70° off the TV's normal the poster floats beside a sliver of screen, over the people next to it.
const SIDE_ON_COS = Math.cos((70 * Math.PI) / 180);
const PROBE_STEP_M = 0.25;

type Screen = NonNullable<VoiceSceneHandle['layout']['screen']>;

const px = (value: number): string => `calc(50% + ${Math.round(value * 10) / 10}px)`;

// The poster shows only while the TV faces the camera within 70° and from inside the TV cone, and only
// inside the TV's outline on screen.
function fitPoster(handle: VoiceSceneHandle, screen: Screen, poster: HTMLElement): void {
	const {center, normal, width, height} = screen;
	// The screen's right as seen from the front; screens hang upright, so up is +Y.
	const length = Math.hypot(normal.x, normal.z) || 1;
	const side = {x: normal.z / length, z: -normal.x / length};
	const at = (right: number, up: number, out = 0) =>
		handle.project({
			x: center.x + side.x * right + normal.x * out,
			y: center.y + up,
			z: center.z + side.z * right + normal.z * out,
		});
	const origin = at(0, 0);
	const offset = (right: number, up: number, out = 0) => {
		const point = at(right, up, out);
		return {x: point.x - origin.x, y: point.y - origin.y};
	};
	const right = offset(PROBE_STEP_M, 0);
	const up = offset(0, PROBE_STEP_M);
	const out = offset(0, 0, PROBE_STEP_M);
	// Three orthonormal steps project to squared lengths that add up to twice the squared pixel scale; the signed
	// right × up area over that is the cosine of the view angle, negative from behind.
	const scale2 = (right.x ** 2 + right.y ** 2 + up.x ** 2 + up.y ** 2 + out.x ** 2 + out.y ** 2) / 2;
	const facing = scale2 > 0 ? (up.x * right.y - right.x * up.y) / scale2 : 0;
	const sideOn = facing < SIDE_ON_COS || !handle.screenInView();
	poster.style.display = sideOn ? 'none' : '';
	if (sideOn) return;
	// Corners in the poster's own box: the anchor centres it on the TV and scales it about that centre.
	const scale = anchorScale(origin.scale);
	const corner = (x: number, y: number): string => {
		const point = offset(x, y);
		return `${px(point.x / scale)} ${px(point.y / scale)}`;
	};
	const halfWidth = width / 2;
	const halfHeight = height / 2;
	poster.style.clipPath = `polygon(${corner(-halfWidth, halfHeight)}, ${corner(halfWidth, halfHeight)}, ${corner(halfWidth, -halfHeight)}, ${corner(-halfWidth, -halfHeight)})`;
}

const identityOf = (entry: VoiceParticipantAvatarEntry): string =>
	buildVoiceParticipantIdentity(entry.userId, entry.connectionId);

// Clicks on the TV itself focus the camera on it; its buttons keep their own job.
function focusOnTv(handle: VoiceSceneHandle, target: EventTarget | null): void {
	if (target instanceof Element && target.closest('button')) return;
	handle.focusScreen();
}

type TvProps = {
	handle: VoiceSceneHandle;
	channel: Channel;
	room: Room | null;
	entries: ReadonlyArray<VoiceParticipantAvatarEntry>;
};

// The TV plays what this viewer picks: by default the first screen share, as before; a camera only when
// picked. Nothing plays until Watch — a screen share through the call's own watch flow, a camera as the room plan's one
// high-quality subscription — so being in the room pulls no extra traffic from the voice server.
export const VoiceSceneTv = observer(function VoiceSceneTv({handle, channel, room, entries}: TvProps) {
	const screen = handle.layout.screen;
	const camerasOn =
		readVoiceRoomAssignment(ExperimentAssignments.response).cameras && VoiceSceneSettings.showRoomCameras;
	const sources = tvSources(entries, Authentication.currentUserId).filter(
		(source) => source.kind === 'screen' || camerasOn,
	);
	const selected = VoiceSceneTvRequest.selected(channel.id);
	const current =
		sources.find((source) => source.kind === selected?.kind && source.identity === selected.identity) ??
		defaultTvSource(sources);
	// the TV moving off a screen share that is still shared stops watching it through the call's own watch
	// path, as the camera's watch ends on a switch; it plays nowhere else in the room. The share ending is the call's
	// to handle, and the room view closing (full screen, the flat view) keeps the watch. So does a popout that plays it
	// — the channel's call popout or that share's own tile popout — as the room's cameras leave popouts alone.
	const shownScreen = current?.kind === 'screen' ? current.identity : null;
	const lastScreen = useRef(shownScreen);
	useEffect(() => {
		const left = lastScreen.current;
		lastScreen.current = shownScreen;
		if (left === null || left === shownScreen) return;
		const sharer = entries.find((item) => item.hasScreenShare && identityOf(item) === left);
		if (!sharer) return;
		if (
			PopoutWindowManager.isCallPopoutOpenForChannel(channel.id) ||
			PopoutWindowManager.isOpen(getVoiceTilePopoutKey(left, 'screen_share'))
		) {
			return;
		}
		const guildId = channel.guildId ?? null;
		stopWatchingStreamKey(getStreamKey(guildId, channel.id, sharer.connectionId), {guildId, channelId: channel.id});
	}, [shownScreen, entries, channel]);
	if (!screen || sources.length === 0) return null;
	const entry = current ? entries.find((item) => identityOf(item) === current.identity) : undefined;
	const picker =
		sources.length > 1 || !current ? (
			<VoiceSceneTvPicker
				channel={channel}
				entries={entries}
				sources={sources}
				current={current}
				data-flx="voice-scene.voice-scene-tv.voice-scene-tv-picker"
			/>
		) : null;
	if (!current || !entry) {
		return (
			<TvBar handle={handle} screen={screen} data-flx="voice-scene.voice-scene-tv.tv-bar">
				{picker}
			</TvBar>
		);
	}
	const props = {handle, channel, room, entry, screen, picker};
	return current.kind === 'screen' ? (
		<ScreenTv key={`screen:${current.identity}`} {...props} data-flx="voice-scene.voice-scene-tv.screen-tv" />
	) : (
		<CameraTv key={`camera:${current.identity}`} {...props} data-flx="voice-scene.voice-scene-tv.camera-tv" />
	);
});

type SourceTvProps = {
	handle: VoiceSceneHandle;
	channel: Channel;
	room: Room | null;
	entry: VoiceParticipantAvatarEntry;
	screen: Screen;
	picker: React.ReactNode;
};

const ScreenTv = observer(function ScreenTv(props: SourceTvProps) {
	const {i18n} = useLingui();
	const {channel, room, entry} = props;
	const guildId = channel.guildId ?? null;
	const {isWatching, canWatch, startWatching, stopWatching} = useStreamWatchState({
		streamKey: getStreamKey(guildId, channel.id, entry.connectionId),
		guildId,
		channelId: channel.id,
	});
	const identity = identityOf(entry);
	const participant = room?.getParticipantByIdentity(identity);
	const publication = participant?.getTrackPublication(Track.Source.ScreenShare);
	const displayName = NicknameUtils.getNickname(entry.user, guildId, channel.id);
	return (
		<Tv
			{...props}
			source={{kind: 'screen', identity}}
			trackRef={
				isWatching && participant && publication ? {participant, publication, source: Track.Source.ScreenShare} : null
			}
			posterLabel={i18n._(SHARING_DESCRIPTOR, {displayName})}
			canWatch={canWatch}
			onWatch={startWatching}
			onStop={stopWatching}
			data-flx="voice-scene.voice-scene-tv.screen-tv.tv"
		/>
	);
});

const CameraTv = observer(function CameraTv(props: SourceTvProps) {
	const {i18n} = useLingui();
	const {channel, room, entry} = props;
	const identity = identityOf(entry);
	// Plays once watched and planned; the plan drops it when the camera is locally disabled.
	const watching = VoiceSceneTvRequest.watchedCamera(channel.id) === identity;
	const participant = room?.getParticipantByIdentity(identity);
	const publication = participant?.getTrackPublication(Track.Source.Camera);
	const playing = watching && RoomCameraStore.qualityOf(identity) !== null;
	const displayName = NicknameUtils.getNickname(entry.user, channel.guildId ?? null, channel.id);
	return (
		<Tv
			{...props}
			source={{kind: 'camera', identity}}
			trackRef={playing && participant && publication ? {participant, publication, source: Track.Source.Camera} : null}
			posterLabel={i18n._(CAMERA_POSTER_DESCRIPTOR, {displayName})}
			canWatch={!watching}
			onWatch={() => VoiceSceneTvRequest.watchCamera(channel.id, identity)}
			onStop={VoiceSceneTvRequest.stopCamera}
			data-flx="voice-scene.voice-scene-tv.camera-tv.tv"
		/>
	);
});

// the TV's buttons, like its picture, show only from inside the TV cone (the orbit goes all round).
function useScreenInView(handle: VoiceSceneHandle): boolean {
	const [inView, setInView] = useState(() => handle.screenInView());
	useEffect(() => {
		setInView(handle.screenInView());
		return handle.onViewChange(() => setInView(handle.screenInView()));
	}, [handle]);
	return inView;
}

function TvBar({handle, screen, children}: {handle: VoiceSceneHandle; screen: Screen; children: React.ReactNode}) {
	// Under the TV's bottom edge; on it, inside, while the camera is close on the TV.
	const inside = useCameraMode(handle) === 'focus';
	const inView = useScreenInView(handle);
	const bottom = useMemo<Vec3>(
		() => ({x: screen.center.x, y: screen.center.y - screen.height / 2, z: screen.center.z}),
		[screen],
	);
	return (
		<VoiceSceneAnchor point={bottom} controls data-flx="voice-scene.voice-scene-tv.tv-bar.voice-scene-anchor">
			<div
				className={tvStyles.bar}
				style={inView ? undefined : {display: 'none'}}
				data-inside={inside ? '' : undefined}
				data-flx="voice-scene.voice-scene-tv.tv-bar.bar"
			>
				{children}
			</div>
		</VoiceSceneAnchor>
	);
}

const Tv = observer(function Tv({
	handle,
	channel,
	entry,
	screen,
	picker,
	source,
	trackRef,
	posterLabel,
	canWatch,
	onWatch,
	onStop,
}: SourceTvProps & {
	source: TvSource;
	trackRef: TrackReference | null;
	posterLabel: string;
	canWatch: boolean;
	onWatch: () => void;
	onStop: () => void;
}) {
	const {i18n} = useLingui();
	const [screenElement] = useState(() => {
		const element = document.createElement('div');
		element.className = styles.screen;
		return element;
	});
	const playing = trackRef !== null;
	const videoRef = useRef<HTMLVideoElement | null>(null);
	useTvScreenShareDemand({
		handle,
		publication: trackRef?.publication as RemoteTrackPublication | undefined,
		videoRef,
		enabled: playing && source.kind === 'screen' && !trackRef?.participant.isLocal,
	});
	useEffect(() => {
		if (!playing) return;
		const focus = (event: Event) => focusOnTv(handle, event.target);
		screenElement.addEventListener('click', focus);
		screenElement.addEventListener('dblclick', focus);
		handle.attachScreenElement(screenElement);
		return () => {
			screenElement.removeEventListener('click', focus);
			screenElement.removeEventListener('dblclick', focus);
			handle.attachScreenElement(null);
		};
	}, [handle, playing, screenElement]);
	const posterRef = useRef<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		const poster = posterRef.current;
		if (playing || !poster) return;
		fitPoster(handle, screen, poster);
		return handle.onViewChange(() => fitPoster(handle, screen, poster));
	}, [handle, playing, screen]);
	if (trackRef) {
		return (
			<>
				{createPortal(
					<VideoTrack
						ref={videoRef}
						className={styles.screenVideo}
						trackRef={trackRef}
						manageSubscription={false}
						data-flx="voice-scene.voice-scene-tv.tv.screen-video"
					/>,
					screenElement,
				)}
				<TvBar handle={handle} screen={screen} data-flx="voice-scene.voice-scene-tv.tv.tv-bar">
					{picker}
					<Button
						small
						compact
						variant="inverted"
						onClick={() => VoiceSceneTvRequest.requestFullscreen(source)}
						data-flx="voice-scene.voice-scene-tv.tv.button.request-fullscreen"
					>
						{i18n._(FULL_SCREEN_DESCRIPTOR)}
					</Button>
					<Button small compact variant="inverted" onClick={onStop} data-flx="voice-scene.voice-scene-tv.tv.button">
						{i18n._(CLOSE_DESCRIPTOR)}
					</Button>
				</TvBar>
			</>
		);
	}
	return (
		<>
			<VoiceSceneAnchor point={screen.center} data-flx="voice-scene.voice-scene-tv.tv.voice-scene-anchor--2">
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: mouse convenience for the 3D camera, like the room's drag and wheel; Watch and the bar's buttons are the keyboard path. */}
				<div
					ref={posterRef}
					className={styles.poster}
					role="group"
					aria-label={posterLabel}
					data-tv-poster=""
					onClick={(event) => focusOnTv(handle, event.target)}
					onDoubleClick={(event) => focusOnTv(handle, event.target)}
					data-flx="voice-scene.voice-scene-tv.tv.poster"
				>
					<div className={styles.posterWho} data-flx="voice-scene.voice-scene-tv.tv.poster-who">
						<Avatar
							user={entry.user}
							size={POSTER_AVATAR_SIZE}
							guildId={channel.guildId ?? null}
							data-flx="voice-scene.voice-scene-tv.tv.avatar"
						/>
						<span className={styles.posterName} data-flx="voice-scene.voice-scene-tv.tv.poster-name">
							{posterLabel}
						</span>
						<span
							className={styles.posterLive}
							aria-hidden="true"
							data-flx="voice-scene.voice-scene-tv.tv.poster-live"
						/>
					</div>
					{canWatch ? (
						<Button small compact onClick={onWatch} data-flx="voice-scene.voice-scene-tv.tv.button--2">
							{i18n._(WATCH_DESCRIPTOR)}
						</Button>
					) : null}
				</div>
			</VoiceSceneAnchor>
			{picker ? (
				<TvBar handle={handle} screen={screen} data-flx="voice-scene.voice-scene-tv.tv.tv-bar--2">
					{picker}
				</TvBar>
			) : null}
		</>
	);
});

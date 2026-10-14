// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	applyScreenShareViewerDemand,
	clearScreenShareViewerDemand,
	releaseScreenShareViewerDemand,
	resolveScreenSharePublicationVideoRequest,
} from '@app/features/voice/utils/ScreenShareSubscriptionPolicy';
import {createScreenLayer} from '@app/features/voice_scene/scene/ScreenLayer';
import {createRenderLoop} from '@app/features/voice_scene/scene/VoiceSceneRenderLoop';
import type {RoomLayout, SceneCameraMode, VoiceSceneHandle} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {RemoteTrackPublication, RemoteVideoTrack, type Room, Track, TrackEvent, VideoQuality} from 'livekit-client';
import {act, createElement, type ReactNode, type Ref} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {PerspectiveCamera} from 'three';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

function interpolate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	return descriptor.message.replace(/{(\w+)}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

const env = vi.hoisted(() => ({
	planned: new Map<string, string>(),
	cameras: true,
	callPopout: null as string | null,
	tilePopouts: new Set<string>(),
}));
const fullscreen = vi.hoisted(() => ({element: null as Element | null}));

const watch = vi.hoisted(() => ({
	isWatching: false,
	canWatch: true,
	startWatching: vi.fn(),
	stopWatching: vi.fn(),
	keys: [] as Array<string>,
}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: interpolate}})}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getNickname: (user: {username: string}) => user.username}));
vi.mock('@app/features/ui/components/Avatar', () => ({
	Avatar: ({user}: {user: {id: string}}) => createElement('div', {'data-avatar': user.id}),
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick}: {children: ReactNode; onClick: () => void}) =>
		createElement('button', {type: 'button', onClick}, children),
}));
vi.mock('@app/features/voice/components/useStreamWatchState', () => ({
	useStreamWatchState: ({streamKey}: {streamKey: string}) => {
		watch.keys.push(streamKey);
		return {...watch, isPendingJoin: false, addStream: vi.fn()};
	},
}));
const streamWatch = vi.hoisted(() => ({stopWatchingStreamKey: vi.fn(() => true)}));
vi.mock('@app/features/voice/engine/VoiceStreamWatchState', () => streamWatch);
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: '1'}}));
vi.mock('@app/features/experiment/state/ExperimentAssignments', () => ({default: {response: {}}}));
vi.mock('@fluxer/schema/src/domains/experiment/ExperimentSchemas', () => ({
	readVoiceRoomAssignment: () => ({rooms: true, games: true, cameras: env.cameras}),
}));
vi.mock('@app/features/voice_scene/state/VoiceSceneSettings', () => ({default: {showRoomCameras: true}}));
vi.mock('@app/features/voice/state/PopoutWindowManager', () => ({
	getVoiceTilePopoutKey: (identity: string, source: string) => `tile:${source}:${identity}`,
	default: {
		isOpen: (key: string) => env.tilePopouts.has(key),
		isCallPopoutOpenForChannel: (channelId: string) => env.callPopout === channelId,
	},
}));
vi.mock('@app/features/voice_scene/video/RoomCameraStore', () => ({
	default: {qualityOf: (identity: string) => env.planned.get(identity) ?? null},
}));
vi.mock('@app/features/platform/utils/FullscreenMediaUtils', async (importOriginal) => ({
	...(await importOriginal<typeof import('@app/features/platform/utils/FullscreenMediaUtils')>()),
	getFullscreenElement: () => fullscreen.element,
}));
vi.mock('@app/features/voice_scene/components/VoiceSceneTvPicker', () => ({
	VoiceSceneTvPicker: ({sources}: {sources: Array<{kind: string; identity: string}>}) =>
		createElement('div', {'data-tv-picker': sources.map((source) => `${source.kind}:${source.identity}`).join(' ')}),
}));
vi.mock('@livekit/components-react', () => ({
	VideoTrack: ({
		trackRef,
		ref,
	}: {
		trackRef: {participant: {identity: string}; source: string};
		ref?: Ref<HTMLVideoElement>;
	}) => createElement('video', {ref, 'data-video': trackRef.participant.identity, 'data-source': trackRef.source}),
}));

const {VoiceSceneAnchor, VoiceSceneAnchors} = await import('@app/features/voice_scene/components/VoiceSceneAnchor');
const {VoiceSceneTv} = await import('@app/features/voice_scene/components/VoiceSceneTv');
const {default: VoiceSceneTvRequest} = await import('@app/features/voice_scene/state/VoiceSceneTvRequest');

const LAYOUT: RoomLayout = {
	seats: [],
	stands: [],
	tables: [],
	camTarget: {x: 0, y: 0, z: 0},
	camHome: {x: 0, y: 5, z: 8},
	camPan: {x: 0, z: 0},
	screen: {center: {x: 1, y: 2, z: -4}, width: 2, height: 1.125, normal: {x: 0, y: 0, z: 1}},
};

const attachScreenElement = vi.fn();
const focusScreen = vi.fn();
const HANDLE = {
	layout: LAYOUT,
	// Seen straight on from +Z: world up is screen up.
	project: (p: {x: number; y: number}) => ({x: p.x * 100, y: 400 - p.y * 100, visible: true, scale: 1}),
	onViewChange: () => () => {},
	getCameraAzimuth: () => 0,
	requestRender: vi.fn(),
	setTableTop: vi.fn(),
	attachScreenElement,
	screenInView: () => true,
	occluder: () => () => false,
	wheel: vi.fn(),
	focusScreen,
	getCameraMode: () => 'orbit',
	onCameraModeChange: () => () => {},
} as unknown as VoiceSceneHandle;

const STREAMER = {
	user: {id: '7', username: 'ayse'},
	userId: '7',
	connectionId: 'conn-7',
	speaking: false,
	hasCamera: false,
	hasScreenShare: true,
	isLocal: false,
	selfMute: false,
	selfDeaf: false,
};
const CAMERA_PERSON = {
	...STREAMER,
	user: {id: '8', username: 'mert'},
	userId: '8',
	connectionId: 'conn-8',
	hasCamera: true,
	hasScreenShare: false,
};
const PUBLICATION = {trackSid: 'TR_screen', on: vi.fn(), off: vi.fn()};
const PARTICIPANT = {
	identity: 'user_7_conn-7',
	isLocal: false,
	getTrackPublication: vi.fn<() => RemoteTrackPublication | typeof PUBLICATION | undefined>(() => PUBLICATION),
};
const CAMERA_PARTICIPANT = {identity: 'user_8_conn-8', getTrackPublication: vi.fn(() => ({trackSid: 'TR_cam'}))};
const ROOM = {
	getParticipantByIdentity: vi.fn((identity: string) =>
		identity === 'user_8_conn-8' ? CAMERA_PARTICIPANT : PARTICIPANT,
	),
} as unknown as Room;
const CHANNEL = {id: '500', guildId: '9'} as never;

function screenPublication(sid = 'TR_screen', withTrack = true): RemoteTrackPublication {
	const publication = new RemoteTrackPublication(
		Track.Kind.Video,
		{
			sid,
			name: 'screen',
			width: 1920,
			height: 1080,
			source: 3,
			layers: [],
			muted: false,
		} as never,
		true,
	);
	if (withTrack)
		publication.setTrack(new RemoteVideoTrack({id: 'video'} as MediaStreamTrack, sid, {} as RTCRtpReceiver));
	return publication;
}

let root: Root;
let host: HTMLDivElement;
const flushPlacement = () => act(() => vi.advanceTimersToNextFrame());

// An orthographic camera turned about +Y by `degrees` from the screen's normal (+Z).
function turnedHandle(degrees: number) {
	const listeners = new Set<() => void>();
	let angle = (degrees * Math.PI) / 180;
	const handle: VoiceSceneHandle = {
		...HANDLE,
		project: (p) => ({
			x: 500 + (p.x * Math.cos(angle) - p.z * Math.sin(angle)) * 100,
			y: 400 - p.y * 100,
			visible: true,
			scale: 1,
		}),
		onViewChange: (cb) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
	};
	return {
		handle,
		turn(next: number) {
			angle = (next * Math.PI) / 180;
			for (const cb of listeners) cb();
		},
	};
}

function render(
	streamer: typeof STREAMER | null,
	handle: VoiceSceneHandle = HANDLE,
	more: Array<typeof STREAMER> = [],
): void {
	act(() =>
		root.render(
			createElement(VoiceSceneAnchors, {
				handle,
				// A fresh object each time, as the call's entries are: the observer re-renders on the new props.
				children: createElement(VoiceSceneTv, {
					handle,
					channel: CHANNEL,
					room: ROOM,
					entries: [...(streamer ? [streamer] : []), ...more].map((entry) => ({...entry})) as never,
				}),
			}),
		),
	);
	flushPlacement();
}

function button(text: string): HTMLButtonElement {
	const found = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent === text);
	if (!found) throw new Error(`no button ${text}`);
	return found;
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	Object.assign(watch, {isWatching: false, canWatch: true, keys: []});
	Object.assign(env, {planned: new Map(), cameras: true, callPopout: null, tilePopouts: new Set()});
	fullscreen.element = null;
	focusScreen.mockClear();
	VoiceSceneTvRequest.stopCamera();
	VoiceSceneTvRequest.clearFullscreen();
	VoiceSceneTvRequest.select('500', {kind: 'screen', identity: 'none'});
	watch.startWatching.mockClear();
	watch.stopWatching.mockClear();
	streamWatch.stopWatchingStreamKey.mockClear();
	attachScreenElement.mockClear();
	PARTICIPANT.getTrackPublication.mockReturnValue(PUBLICATION);
	PARTICIPANT.isLocal = false;
	clearScreenShareViewerDemand();
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	clearScreenShareViewerDemand();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('VoiceSceneTv', () => {
	it.each([false, true])('document hiding immediately lowers the TV demand (popout: %s)', (withPopout) => {
		const publication = screenPublication();
		PARTICIPANT.getTrackPublication.mockReturnValue(publication);
		let hidden = false;
		let width = 1200;
		let height = 675;
		vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
		const measure = vi
			.spyOn(HTMLVideoElement.prototype, 'getBoundingClientRect')
			.mockImplementation(() => ({width, height}) as DOMRect);
		const viewListeners = new Set<() => void>();
		const handle: VoiceSceneHandle = {
			...HANDLE,
			onViewChange: (callback) => {
				viewListeners.add(callback);
				return () => viewListeners.delete(callback);
			},
		};
		const popoutDemand = () =>
			applyScreenShareViewerDemand({
				publication,
				label: 'popout',
				viewerKey: 'popout',
				dimensions: {width: 800, height: 450},
			});
		const releasePopout = () =>
			releaseScreenShareViewerDemand({
				publication,
				label: 'popout',
				trackSid: publication.trackSid,
				viewerKey: 'popout',
			});
		const request = () => resolveScreenSharePublicationVideoRequest(publication, VideoQuality.HIGH);
		const setHidden = (next: boolean) => {
			hidden = next;
			document.dispatchEvent(new Event('visibilitychange'));
		};
		if (withPopout) popoutDemand();
		watch.isWatching = true;
		render(STREAMER, handle);
		act(() => vi.advanceTimersByTime(500));
		expect(request()).toMatchObject({dimensions: {width: 1200, height: 675}});
		measure.mockClear();
		act(() => setHidden(true));
		expect(request()).toMatchObject({dimensions: withPopout ? {width: 800, height: 450} : {width: 1, height: 1}});
		if (withPopout) {
			releasePopout();
			expect(request()).toMatchObject({dimensions: {width: 1, height: 1}});
			popoutDemand();
		}
		width = 1600;
		height = 900;
		act(() => {
			for (const callback of viewListeners) callback();
			publication.emit(TrackEvent.Subscribed, publication.track!);
			vi.advanceTimersByTime(5000);
		});
		expect(measure).not.toHaveBeenCalled();
		expect(request()).toMatchObject({dimensions: withPopout ? {width: 800, height: 450} : {width: 1, height: 1}});
		width = 1000;
		height = 562;
		act(() => setHidden(false));
		act(() => vi.advanceTimersByTime(499));
		expect(measure).not.toHaveBeenCalled();
		act(() => vi.advanceTimersByTime(1));
		expect(request()).toMatchObject({dimensions: {width: 1000, height: 562}});
		expect(measure).toHaveBeenCalledTimes(1);
		act(() => {
			setHidden(true);
			setHidden(false);
		});
		act(() => root.render(null));
		expect(viewListeners.size).toBe(0);
		act(() => {
			publication.emit(TrackEvent.Subscribed, publication.track!);
			setHidden(true);
			setHidden(false);
			vi.advanceTimersByTime(1000);
		});
		expect(measure).toHaveBeenCalledTimes(1);
		if (withPopout) {
			expect(request()).toMatchObject({dimensions: {width: 800, height: 450}});
			releasePopout();
		}
		expect(request()).toMatchObject({operation: 'setVideoQuality'});
	});
	it('a pending TV measurement cannot raise demand while the document is hidden', () => {
		const publication = screenPublication();
		PARTICIPANT.getTrackPublication.mockReturnValue(publication);
		let hidden = false;
		vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
		const measure = vi
			.spyOn(HTMLVideoElement.prototype, 'getBoundingClientRect')
			.mockReturnValue({width: 320, height: 180} as DOMRect);
		watch.isWatching = true;
		render(STREAMER);
		// The timeout may observe hidden state before visibilitychange is dispatched.
		hidden = true;
		act(() => vi.advanceTimersByTime(500));
		expect(measure).not.toHaveBeenCalled();
		expect(resolveScreenSharePublicationVideoRequest(publication, VideoQuality.HIGH)).toMatchObject({
			dimensions: {width: 1, height: 1},
		});
	});
	it.each([500, 480])('visible return restores demand without a view change after %i ms hidden', (hiddenMs) => {
		const publication = screenPublication();
		PARTICIPANT.getTrackPublication.mockReturnValue(publication);
		let hidden = false;
		vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
		const camera = new PerspectiveCamera(28, 16 / 9, 0.05, 100);
		camera.position.set(1, 2, 0);
		camera.lookAt(1, 2, -4);
		const canvas = document.createElement('canvas');
		const container = document.createElement('div');
		document.body.append(container);
		const layer = createScreenLayer({container, layout: LAYOUT, wheelTarget: canvas});
		let viewDirty = true;
		const viewListeners = new Set<() => void>();
		const viewChanged = vi.fn(() => {
			for (const callback of viewListeners) callback();
		});
		const draw = vi.fn(() => {
			layer.update(camera, {width: 1280, height: 720});
			if (viewDirty) {
				viewDirty = false;
				viewChanged();
			}
			return false;
		});
		const loop = createRenderLoop({draw, canvas, onContextLost: vi.fn()});
		const handle: VoiceSceneHandle = {
			...HANDLE,
			attachScreenElement: (element) => {
				layer.attach(element);
				loop.requestRender();
			},
			onViewChange: (callback) => {
				viewListeners.add(callback);
				return () => viewListeners.delete(callback);
			},
		};
		const measure = vi.spyOn(HTMLVideoElement.prototype, 'getBoundingClientRect').mockImplementation(function (
			this: HTMLVideoElement,
		) {
			const displayed = this.parentElement?.parentElement?.style.display !== 'none';
			return {width: displayed ? 320 : 0, height: displayed ? 180 : 0} as DOMRect;
		});
		const visibilityListener = vi.spyOn(document, 'addEventListener');
		const removeListener = vi.spyOn(document, 'removeEventListener');
		const setHidden = (next: boolean) => {
			hidden = next;
			document.dispatchEvent(new Event('visibilitychange'));
		};
		try {
			loop.requestRender();
			flushPlacement();
			expect(draw).toHaveBeenCalledTimes(1);
			viewChanged.mockClear();
			act(() => setHidden(true));
			watch.isWatching = true;
			render(STREAMER, handle);
			const video = container.querySelector('video') as HTMLVideoElement;
			const holder = video.parentElement?.parentElement as HTMLElement;
			expect(holder.style.display).toBe('none');
			act(() => vi.advanceTimersByTime(hiddenMs));
			expect(resolveScreenSharePublicationVideoRequest(publication, VideoQuality.HIGH)).toMatchObject({
				dimensions: {width: 1, height: 1},
			});
			measure.mockClear();
			act(() => setHidden(false));
			expect(holder.style.display).toBe('none');
			act(() => vi.advanceTimersByTime(499));
			expect(holder.style.display).toBe('');
			expect(measure).not.toHaveBeenCalled();
			act(() => vi.advanceTimersByTime(1));
			expect(resolveScreenSharePublicationVideoRequest(publication, VideoQuality.HIGH)).toMatchObject({
				dimensions: {width: 320, height: 180},
			});
			expect(measure).toHaveBeenCalledTimes(1);
			expect(viewChanged).not.toHaveBeenCalled();
			act(() => vi.advanceTimersByTime(2000));
			expect(draw).toHaveBeenCalledTimes(2);
			expect(measure).toHaveBeenCalledTimes(1);
			const listener = visibilityListener.mock.calls.find(([event]) => event === 'visibilitychange')?.[1];
			expect(listener).toBeDefined();
			act(() => {
				setHidden(true);
				setHidden(false);
			});
			render(null, handle);
			expect(removeListener).toHaveBeenCalledWith('visibilitychange', listener);
			act(() => vi.advanceTimersByTime(1000));
			act(() => {
				setHidden(true);
				setHidden(false);
				vi.advanceTimersByTime(1000);
			});
			expect(measure).toHaveBeenCalledTimes(1);
		} finally {
			loop.dispose();
			layer.dispose();
			container.remove();
		}
	});
	it('screen TV demand grows in focus, shrinks in the room, and leaves the popout demand intact', () => {
		const publication = screenPublication();
		PARTICIPANT.getTrackPublication.mockReturnValue(publication);
		const settings: Array<{width: number; height: number}> = [];
		publication.on(TrackEvent.UpdateSettings, (request) => settings.push(request));
		applyScreenShareViewerDemand({
			publication,
			label: 'popout',
			viewerKey: 'popout',
			dimensions: {width: 800, height: 450},
		});
		let width = 1778;
		let height = 1000;
		let visible = true;
		const listeners = new Set<() => void>();
		const changed = () => {
			for (const callback of listeners) callback();
		};
		const measure = vi
			.spyOn(HTMLVideoElement.prototype, 'getBoundingClientRect')
			.mockImplementation(() => ({width, height}) as DOMRect);
		const handle = {
			...HANDLE,
			screenInView: () => visible,
			onViewChange: (callback: () => void) => {
				listeners.add(callback);
				return () => listeners.delete(callback);
			},
		};
		watch.isWatching = true;
		render(STREAMER, handle);
		act(() => vi.advanceTimersByTime(500));
		expect(resolveScreenSharePublicationVideoRequest(publication, VideoQuality.HIGH)).toMatchObject({
			operation: 'setVideoDimensions',
			dimensions: {width: 1778, height: 1000},
		});
		expect(settings.at(-1)).toMatchObject({width: 1778, height: 1000});
		width = 320;
		height = 180;
		act(() => {
			for (let frame = 0; frame < 30; frame++) changed();
		});
		expect(measure).toHaveBeenCalledTimes(1);
		act(() => vi.advanceTimersByTime(500));
		expect(measure).toHaveBeenCalledTimes(2);
		expect(settings.at(-1)).toMatchObject({width: 800, height: 450});
		visible = false;
		act(() => changed());
		act(() => vi.advanceTimersByTime(500));
		expect(settings.at(-1)).toMatchObject({width: 800, height: 450});
		render(null, handle);
		expect(resolveScreenSharePublicationVideoRequest(publication, VideoQuality.HIGH)).toMatchObject({
			dimensions: {width: 800, height: 450},
		});
	});
	it('the sole TV requests its displayed room size; hidden and zero-size TVs request the minimum layer', () => {
		const publication = screenPublication();
		PARTICIPANT.getTrackPublication.mockReturnValue(publication);
		let width = 320;
		let height = 180;
		let visible = true;
		const listeners = new Set<() => void>();
		const changed = () => {
			for (const callback of listeners) callback();
		};
		const measure = vi
			.spyOn(HTMLVideoElement.prototype, 'getBoundingClientRect')
			.mockImplementation(() => ({width, height}) as DOMRect);
		const settings = vi.fn();
		publication.on(TrackEvent.UpdateSettings, settings);
		const handle = {
			...HANDLE,
			screenInView: () => visible,
			onViewChange: (callback: () => void) => {
				listeners.add(callback);
				return () => listeners.delete(callback);
			},
		};
		watch.isWatching = true;
		render(STREAMER, handle);
		act(() => vi.advanceTimersByTime(500));
		expect(settings.mock.lastCall?.[0]).toMatchObject({width: 320, height: 180});
		width = 322;
		act(() => changed());
		act(() => vi.advanceTimersByTime(500));
		expect(settings).toHaveBeenCalledTimes(1);
		visible = false;
		act(() => changed());
		act(() => vi.advanceTimersByTime(500));
		expect(measure).toHaveBeenCalledTimes(2);
		expect(settings.mock.lastCall?.[0]).toMatchObject({width: 1, height: 1});
		visible = true;
		width = 0;
		height = 0;
		act(() => changed());
		act(() => vi.advanceTimersByTime(500));
		expect(settings).toHaveBeenCalledTimes(2);
		render(null, handle);
		expect(settings.mock.lastCall?.[0]).toMatchObject({quality: VideoQuality.HIGH, width: 0, height: 0});
	});
	it('late screen tracks register demand, track changes release the old SID, and camera TV adds no demand', () => {
		const first = screenPublication('TR_first', false);
		PARTICIPANT.getTrackPublication.mockReturnValue(first);
		const measure = vi
			.spyOn(HTMLVideoElement.prototype, 'getBoundingClientRect')
			.mockReturnValue({width: 1200, height: 675} as DOMRect);
		watch.isWatching = true;
		render(STREAMER);
		act(() => vi.advanceTimersByTime(500));
		expect(measure).not.toHaveBeenCalled();
		act(() =>
			first.setTrack(new RemoteVideoTrack({id: 'video'} as MediaStreamTrack, 'TR_first', {} as RTCRtpReceiver)),
		);
		act(() => vi.advanceTimersByTime(500));
		expect(resolveScreenSharePublicationVideoRequest(first, VideoQuality.HIGH)).toMatchObject({
			dimensions: {width: 1200, height: 675},
		});
		const next = screenPublication('TR_next');
		PARTICIPANT.getTrackPublication.mockReturnValue(next);
		render(STREAMER);
		expect(resolveScreenSharePublicationVideoRequest(first, VideoQuality.HIGH)).toMatchObject({
			operation: 'setVideoQuality',
		});
		act(() => vi.advanceTimersByTime(500));
		expect(resolveScreenSharePublicationVideoRequest(next, VideoQuality.HIGH)).toMatchObject({
			dimensions: {width: 1200, height: 675},
		});
		act(() => next.setTrack(undefined));
		expect(resolveScreenSharePublicationVideoRequest(next, VideoQuality.HIGH)).toMatchObject({
			operation: 'setVideoQuality',
		});
		act(() => VoiceSceneTvRequest.select('500', {kind: 'camera', identity: 'user_8_conn-8'}));
		VoiceSceneTvRequest.watchCamera('500', 'user_8_conn-8');
		env.planned.set('user_8_conn-8', 'high');
		measure.mockClear();
		render(STREAMER, HANDLE, [CAMERA_PERSON]);
		act(() => vi.advanceTimersByTime(1000));
		expect(measure).not.toHaveBeenCalled();
	});
	it('missing publications and local screen previews add no remote viewer demand', () => {
		const measure = vi
			.spyOn(HTMLVideoElement.prototype, 'getBoundingClientRect')
			.mockReturnValue({width: 1200, height: 675} as DOMRect);
		watch.isWatching = true;
		PARTICIPANT.getTrackPublication.mockReturnValue(undefined);
		render(STREAMER);
		act(() => vi.advanceTimersByTime(500));
		expect(measure).not.toHaveBeenCalled();
		const publication = screenPublication();
		PARTICIPANT.getTrackPublication.mockReturnValue(publication);
		PARTICIPANT.isLocal = true;
		render(STREAMER);
		act(() => vi.advanceTimersByTime(500));
		expect(measure).not.toHaveBeenCalled();
		PARTICIPANT.isLocal = false;
		Object.defineProperty(publication, 'isLocal', {value: true});
		render(STREAMER);
		act(() => vi.advanceTimersByTime(500));
		expect(measure).not.toHaveBeenCalled();
		expect(resolveScreenSharePublicationVideoRequest(publication, VideoQuality.HIGH)).toMatchObject({
			operation: 'setVideoQuality',
		});
	});
	it('no stream → no poster', () => {
		render(null);
		expect(host.querySelector('[data-tv-poster]')).toBeNull();
		expect(attachScreenElement).not.toHaveBeenCalled();
	});

	it('stream → poster with streamer avatar and İzle; video not attached', () => {
		render(STREAMER);
		const poster = host.querySelector('[data-tv-poster]');
		expect(poster?.querySelector('[data-avatar="7"]')).not.toBeNull();
		expect(poster?.textContent).toContain('ayse');
		expect(button('Watch')).toBeTruthy();
		expect(watch.keys.at(-1)).toBe('9:500:conn-7');
		// The poster sits on the screen's projection; no subscription and no video until İzle.
		const anchor = poster?.closest('[data-scene-anchor]') as HTMLElement | null | undefined;
		expect(anchor?.style.transform).toContain('translate3d(100px, 200px, 0)');
		expect(attachScreenElement).not.toHaveBeenCalled();
		expect(document.querySelector('video')).toBeNull();
	});

	it('a TV seen side-on (over 70° off its normal) or from behind hides the poster', () => {
		const {handle, turn} = turnedHandle(60);
		render(STREAMER, handle);
		const poster = () => host.querySelector('[data-tv-poster]') as HTMLElement;
		expect(poster().style.display).toBe('');
		act(() => turn(75));
		expect(poster().style.display).toBe('none');
		act(() => turn(-65));
		expect(poster().style.display).toBe('');
		act(() => turn(180));
		expect(poster().style.display).toBe('none');
	});

	it('outside the TV cone the poster and the bar hide, as the picture does', () => {
		const listeners = new Set<() => void>();
		let inView = true;
		const handle: VoiceSceneHandle = {
			...HANDLE,
			screenInView: () => inView,
			onViewChange: (cb) => {
				listeners.add(cb);
				return () => listeners.delete(cb);
			},
		};
		const leave = (next: boolean) => {
			inView = next;
			for (const cb of listeners) cb();
		};
		render(STREAMER, handle);
		const poster = () => host.querySelector('[data-tv-poster]') as HTMLElement;
		expect(poster().style.display).toBe('');
		act(() => leave(false));
		expect(poster().style.display).toBe('none');
		act(() => leave(true));
		expect(poster().style.display).toBe('');
		// Watching: the bar under the picture.
		watch.isWatching = true;
		render(STREAMER, handle);
		const bar = () => button('Full screen').parentElement as HTMLElement;
		expect(bar().style.display).toBe('');
		act(() => leave(false));
		expect(bar().style.display).toBe('none');
		act(() => leave(true));
		expect(bar().style.display).toBe('');
	});

	it("the poster is clipped to the TV's outline on screen", () => {
		const {handle} = turnedHandle(60);
		render(STREAMER, handle);
		const clip = (host.querySelector('[data-tv-poster]') as HTMLElement).style.clipPath;
		const offsets = [...clip.matchAll(/calc\(50% \+ (-?[\d.]+)px\)/g)].map((match) => Number(match[1]));
		// Width 2 m seen at 60° → 100 px across, ±50 px around the centre; height 1.125 m → ±56.25 px.
		expect(offsets).toHaveLength(8);
		for (const [i, offset] of offsets.entries()) expect(Math.abs(offset)).toBeCloseTo(i % 2 === 0 ? 50 : 56.25, 0);
	});

	it('İzle → existing watch flow, video element attached via handle.attachScreenElement', () => {
		render(STREAMER);
		act(() => button('Watch').click());
		expect(watch.startWatching).toHaveBeenCalledTimes(1);
		watch.isWatching = true;
		render(STREAMER);
		const element = attachScreenElement.mock.lastCall?.[0] as HTMLElement;
		expect(element).toBeInstanceOf(HTMLElement);
		const video = element.querySelector('video');
		expect(video?.getAttribute('data-video')).toBe('user_7_conn-7');
		expect(video?.getAttribute('data-source')).toBe('screen_share');
		expect(host.querySelector('[data-tv-poster]')).toBeNull();
	});

	it('Kapat → unwatch and detach', () => {
		watch.isWatching = true;
		render(STREAMER);
		expect(attachScreenElement.mock.lastCall?.[0]).toBeInstanceOf(HTMLElement);
		act(() => button('Close').click());
		expect(watch.stopWatching).toHaveBeenCalledTimes(1);
		watch.isWatching = false;
		render(STREAMER);
		expect(attachScreenElement).toHaveBeenLastCalledWith(null);
	});

	it("default is the first screen share (today's poster); a camera only when picked", () => {
		render(null, HANDLE, [CAMERA_PERSON]);
		// Cameras alone leave the TV dark; the picker offers them.
		expect(host.querySelector('[data-tv-poster]')).toBeNull();
		expect(host.querySelector('[data-tv-picker]')?.getAttribute('data-tv-picker')).toBe('camera:user_8_conn-8');
		render(STREAMER, HANDLE, [CAMERA_PERSON]);
		expect(host.querySelector('[data-tv-poster]')?.textContent).toContain('ayse is sharing their screen');
	});

	it('selected source gone → default', () => {
		VoiceSceneTvRequest.select('500', {kind: 'camera', identity: 'user_8_conn-8'});
		render(STREAMER, HANDLE, [CAMERA_PERSON]);
		expect(host.querySelector('[data-tv-poster]')?.textContent).toContain("mert's camera");
		render(STREAMER, HANDLE, [{...CAMERA_PERSON, hasCamera: false}]);
		expect(host.querySelector('[data-tv-poster]')?.textContent).toContain('ayse is sharing their screen');
	});

	it('camera on TV plays only after İzle and is planned high', () => {
		VoiceSceneTvRequest.select('500', {kind: 'camera', identity: 'user_8_conn-8'});
		render(STREAMER, HANDLE, [CAMERA_PERSON]);
		expect(attachScreenElement).not.toHaveBeenCalled();
		expect(VoiceSceneTvRequest.watchedCamera('500')).toBeNull();
		act(() => button('Watch').click());
		// The room plan reads this and gives the TV its one high-quality subscription.
		expect(VoiceSceneTvRequest.watchedCamera('500')).toBe('user_8_conn-8');
		expect(watch.startWatching).not.toHaveBeenCalled();
		// Until the room plan holds the subscription (a local disable keeps it out), the TV stays on the poster.
		render(STREAMER, HANDLE, [CAMERA_PERSON]);
		expect(attachScreenElement).not.toHaveBeenCalled();
		env.planned.set('user_8_conn-8', 'high');
		render(STREAMER, HANDLE, [CAMERA_PERSON]);
		const video = (attachScreenElement.mock.lastCall as [HTMLElement])[0].querySelector('video');
		expect(video?.getAttribute('data-video')).toBe('user_8_conn-8');
		expect(video?.getAttribute('data-source')).toBe('camera');
		act(() => button('Close').click());
		expect(VoiceSceneTvRequest.watchedCamera('500')).toBeNull();
	});

	it('room cameras off → no camera on the TV list', () => {
		env.cameras = false;
		render(STREAMER, HANDLE, [CAMERA_PERSON]);
		expect(host.querySelector('[data-tv-picker]')).toBeNull();
	});

	it('click or double-click on the TV calls handle.focusScreen; buttons do not', () => {
		render(STREAMER);
		const poster = host.querySelector('[data-tv-poster]') as HTMLElement;
		act(() => poster.click());
		act(() => poster.dispatchEvent(new MouseEvent('dblclick', {bubbles: true})));
		expect(focusScreen).toHaveBeenCalledTimes(2);
		act(() => button('Watch').click());
		expect(focusScreen).toHaveBeenCalledTimes(2);
		watch.isWatching = true;
		render(STREAMER);
		const screenElement = attachScreenElement.mock.lastCall?.[0] as HTMLElement;
		act(() => screenElement.click());
		expect(focusScreen).toHaveBeenCalledTimes(3);
		act(() => button('Full screen').click());
		act(() => button('Close').click());
		expect(focusScreen).toHaveBeenCalledTimes(3);
	});

	it("TV focus: the bar moves inside the TV's bottom edge, so its buttons stay in view; back in the room it hangs under", () => {
		let mode: SceneCameraMode = 'orbit';
		const listeners = new Set<(next: SceneCameraMode) => void>();
		const handle: VoiceSceneHandle = {
			...HANDLE,
			getCameraMode: () => mode,
			onCameraModeChange: (cb) => {
				listeners.add(cb);
				return () => listeners.delete(cb);
			},
		};
		const setMode = (next: SceneCameraMode) => {
			mode = next;
			for (const cb of listeners) cb(next);
		};
		watch.isWatching = true;
		render(STREAMER, handle);
		const bar = () => button('Full screen').parentElement as HTMLElement;
		expect(bar().hasAttribute('data-inside')).toBe(false);
		act(() => setMode('focus'));
		expect(bar().hasAttribute('data-inside')).toBe(true);
		act(() => setMode('orbit'));
		expect(bar().hasAttribute('data-inside')).toBe(false);
	});

	it('Tam ekran requests fullscreen for the selected source', () => {
		watch.isWatching = true;
		render(STREAMER);
		act(() => button('Full screen').click());
		expect(VoiceSceneTvRequest.fullscreen).toEqual({kind: 'screen', identity: 'user_7_conn-7'});
	});

	it("the bar's buttons draw above the people's bubbles and the table chips, even nearer ones", () => {
		watch.isWatching = true;
		// The sofa under the TV and a table are nearer the camera: a bigger scale, so a higher z by distance alone.
		const handle: VoiceSceneHandle = {
			...HANDLE,
			project: (p) => ({x: p.x * 100, y: 400 - p.y * 100, visible: true, scale: p.z > -1 ? 1.8 : 0.6}),
		};
		act(() =>
			root.render(
				createElement(VoiceSceneAnchors, {
					handle,
					children: [
						createElement(VoiceSceneAnchor, {key: 'person', point: {x: 1, y: 1.5, z: 0}, children: 'person'}),
						createElement(VoiceSceneAnchor, {
							key: 'table',
							point: {x: 1, y: 1.5, z: 0},
							onTop: true,
							children: 'table',
						}),
						createElement(VoiceSceneTv, {
							key: 'tv',
							handle,
							channel: CHANNEL,
							room: ROOM,
							entries: [{...STREAMER}] as never,
						}),
					],
				}),
			),
		);
		flushPlacement();
		const z = (element: Element) => Number((element.closest('[data-scene-anchor]') as HTMLElement).style.zIndex);
		const anchorWith = (text: string) =>
			[...host.querySelectorAll('[data-scene-anchor]')].find((element) => element.textContent === text) as Element;
		const bar = z(button('Full screen'));
		expect(z(button('Close'))).toBe(bar);
		expect(bar).toBeGreaterThan(z(anchorWith('person')));
		expect(bar).toBeGreaterThan(z(anchorWith('table')));
	});

	it('switching the TV away from a watched screen share stops watching it', () => {
		watch.isWatching = true;
		render(STREAMER, HANDLE, [CAMERA_PERSON]);
		render(STREAMER, HANDLE, [CAMERA_PERSON]);
		expect(streamWatch.stopWatchingStreamKey).not.toHaveBeenCalled();
		act(() => VoiceSceneTvRequest.select('500', {kind: 'camera', identity: 'user_8_conn-8'}));
		// The call's own watch path: the stream stops downloading and the streamer's viewer list drops me.
		expect(streamWatch.stopWatchingStreamKey).toHaveBeenCalledTimes(1);
		expect(streamWatch.stopWatchingStreamKey).toHaveBeenCalledWith('9:500:conn-7', {guildId: '9', channelId: '500'});
		render(STREAMER, HANDLE, [CAMERA_PERSON]);
		expect(streamWatch.stopWatchingStreamKey).toHaveBeenCalledTimes(1);
	});

	it('switching the TV away from a stream watched in the open call popout keeps it watching', () => {
		env.callPopout = '500';
		watch.isWatching = true;
		render(STREAMER, HANDLE, [CAMERA_PERSON]);
		act(() => VoiceSceneTvRequest.select('500', {kind: 'camera', identity: 'user_8_conn-8'}));
		// The popout's call view plays the same watch; the TV moving on is not a reason to end it there.
		expect(streamWatch.stopWatchingStreamKey).not.toHaveBeenCalled();
	});

	it('switching the TV away from a screen share popped out on its own keeps it watching', () => {
		env.tilePopouts.add('tile:screen_share:user_7_conn-7');
		watch.isWatching = true;
		render(STREAMER, HANDLE, [CAMERA_PERSON]);
		act(() => VoiceSceneTvRequest.select('500', {kind: 'camera', identity: 'user_8_conn-8'}));
		expect(streamWatch.stopWatchingStreamKey).not.toHaveBeenCalled();
	});

	it('the share ending or the room view closing never stops a watch from the TV', () => {
		watch.isWatching = true;
		render(STREAMER, HANDLE, [CAMERA_PERSON]);
		// The share ends: the call's own flow lets that stream go.
		render(null, HANDLE, [CAMERA_PERSON]);
		render(STREAMER, HANDLE, [CAMERA_PERSON]);
		// Full screen and the flat view keep what the TV was watching.
		act(() => root.render(null));
		expect(streamWatch.stopWatchingStreamKey).not.toHaveBeenCalled();
	});

	it('the stream ending while watched detaches the screen', () => {
		watch.isWatching = true;
		render(STREAMER);
		render(null);
		expect(attachScreenElement).toHaveBeenLastCalledWith(null);
	});
});

// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {EventEmitter} from 'node:events';
import {VoiceLiveKitRoot} from '@app/features/voice/components/VoiceLiveKitRoot';
import {useMaybeVoiceRoom} from '@app/features/voice/components/VoiceRoomContext';
import {useMaybeRoomContext} from '@livekit/components-react';
import {
	RemoteAudioTrack,
	RemoteParticipant,
	RemoteTrackPublication,
	RemoteVideoTrack,
	type Room,
	RoomEvent,
	Track,
	TrackEvent,
} from 'livekit-client';
import {act, createElement, type ReactNode, useEffect} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const PROTO_SOURCE = {unknown: 0, microphone: 2, screenShareAudio: 4} as const;

const renderedAudioElements = new Set<HTMLMediaElement>();

let host: HTMLDivElement;
let root: Root;

function addTrack(
	participant: RemoteParticipant,
	kind: Track.Kind.Audio | Track.Kind.Video,
	sid: string,
	source: number,
): RemoteAudioTrack | RemoteVideoTrack {
	const publication = new RemoteTrackPublication(kind, {sid, name: sid, source, muted: false} as never, true);
	const mediaTrack = {id: sid, kind, stop: () => {}} as unknown as MediaStreamTrack;
	const receiver = {} as RTCRtpReceiver;
	const track =
		kind === Track.Kind.Audio
			? new RemoteAudioTrack(mediaTrack, sid, receiver)
			: new RemoteVideoTrack(mediaTrack, sid, receiver);
	track.on(TrackEvent.ElementAttached, (element) => {
		if (element instanceof HTMLAudioElement) renderedAudioElements.add(element);
	});
	publication.setTrack(track);
	participant.trackPublications.set(sid, publication);
	return track;
}

function createCallRoom(call: number, remoteCount: number): Room {
	const remoteParticipants = new Map<string, RemoteParticipant>();
	for (let index = 0; index < remoteCount; index++) {
		const identity = `user_${index}_call_${call}`;
		const participant = new RemoteParticipant({} as never, `PA_${call}_${index}`, identity);
		addTrack(participant, Track.Kind.Audio, `TR_mic_${call}_${index}`, PROTO_SOURCE.microphone);
		remoteParticipants.set(identity, participant);
	}
	return Object.assign(new EventEmitter(), {
		localParticipant: {identity: 'local', isLocal: true, trackPublications: new Map()},
		remoteParticipants,
	}) as unknown as Room;
}

function endCall(room: Room): void {
	room.remoteParticipants.forEach((participant) => {
		participant.trackPublications.forEach((publication) => {
			participant.unpublishTrack(publication.trackSid);
		});
	});
}

async function renderRoot(room: Room | null, children: ReactNode = null): Promise<void> {
	await act(async () => {
		root.render(createElement(VoiceLiveKitRoot, {room, children}));
	});
	await act(async () => {
		await vi.dynamicImportSettled();
	});
}

function attachedAudioElements(): Array<HTMLAudioElement> {
	return Array.from(host.querySelectorAll('audio'));
}

beforeAll(() => {
	vi.stubGlobal(
		'MediaStream',
		class extends MediaStream {
			override getTracks(): Array<MediaStreamTrack> {
				return [...this.getAudioTracks(), ...this.getVideoTracks()];
			}
		},
	);
});

afterAll(() => {
	vi.unstubAllGlobals();
});

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe('VoiceLiveKitRoot', () => {
	it('keeps the app tree mounted while joining and leaving calls', async () => {
		const mounted = vi.fn();
		const unmounted = vi.fn();
		function AppTree() {
			useEffect(() => {
				mounted();
				return unmounted;
			}, []);
			return createElement('main', {'data-app-tree': ''});
		}
		const app = createElement(AppTree);

		await renderRoot(null, app);
		const appNode = host.querySelector('[data-app-tree]');
		for (let call = 0; call < 3; call++) {
			await renderRoot(createCallRoom(call, 1), app);
			await renderRoot(null, app);
		}

		expect(mounted).toHaveBeenCalledTimes(1);
		expect(unmounted).not.toHaveBeenCalled();
		expect(host.querySelector('[data-app-tree]')).toBe(appNode);
	});

	it('provides the room to the voice and LiveKit contexts only during a call', async () => {
		const seen: Array<{voiceRoom: Room | undefined; liveKitRoom: Room | undefined}> = [];
		function Consumer() {
			seen.push({voiceRoom: useMaybeVoiceRoom(), liveKitRoom: useMaybeRoomContext()});
			return null;
		}
		const consumer = createElement(Consumer);
		const room = createCallRoom(0, 0);

		await renderRoot(null, consumer);
		expect(seen.at(-1)).toEqual({voiceRoom: undefined, liveKitRoom: undefined});
		await renderRoot(room, consumer);
		expect(seen.at(-1)?.voiceRoom).toBe(room);
		expect(seen.at(-1)?.liveKitRoom).toBe(room);
		await renderRoot(null, consumer);
		expect(seen.at(-1)).toEqual({voiceRoom: undefined, liveKitRoom: undefined});
	});

	it('plays remote microphone and screen share audio and skips local and video tracks', async () => {
		const room = createCallRoom(10, 1);
		const [remote] = Array.from(room.remoteParticipants.values());
		const microphone = remote.trackPublications.values().next().value?.track as RemoteAudioTrack;
		const screenShareAudio = addTrack(remote, Track.Kind.Audio, 'TR_screen_audio', PROTO_SOURCE.screenShareAudio);
		const unknownAudio = addTrack(remote, Track.Kind.Audio, 'TR_unknown_audio', PROTO_SOURCE.unknown);
		const unknownVideo = addTrack(remote, Track.Kind.Video, 'TR_unknown_video', PROTO_SOURCE.unknown);
		const localPublication = new RemoteTrackPublication(
			Track.Kind.Audio,
			{sid: 'TR_local_mic', name: 'local', source: PROTO_SOURCE.microphone, muted: false} as never,
			true,
		);
		const localMicrophone = new RemoteAudioTrack(
			{id: 'TR_local_mic', kind: 'audio', stop: () => {}} as unknown as MediaStreamTrack,
			'TR_local_mic',
			{} as RTCRtpReceiver,
		);
		localPublication.setTrack(localMicrophone);
		room.localParticipant.trackPublications.set('TR_local_mic', localPublication as never);

		await renderRoot(room);

		expect(attachedAudioElements()).toHaveLength(3);
		for (const track of [microphone, screenShareAudio, unknownAudio]) {
			expect(track.attachedElements).toHaveLength(1);
			const [element] = track.attachedElements;
			expect(element.isConnected).toBe(true);
			expect(element.paused).toBe(false);
			expect((element.srcObject as MediaStream).getAudioTracks()).toEqual([track.mediaStreamTrack]);
			expect(element.parentElement?.style.display).toBe('none');
		}
		expect(unknownVideo.attachedElements).toHaveLength(0);
		expect(localMicrophone.attachedElements).toHaveLength(0);

		microphone.setVolume(0.4);
		expect(microphone.attachedElements[0].volume).toBe(0.4);

		endCall(room);
		await renderRoot(null);
	});

	it('follows remote audio tracks that are subscribed or unpublished during a call', async () => {
		const room = createCallRoom(20, 1);
		await renderRoot(room);
		expect(attachedAudioElements()).toHaveLength(1);

		const late = new RemoteParticipant({} as never, 'PA_late', 'late');
		const lateTrack = addTrack(late, Track.Kind.Audio, 'TR_late_mic', PROTO_SOURCE.microphone);
		room.remoteParticipants.set(late.identity, late);
		await act(async () => {
			room.emit(RoomEvent.ParticipantConnected, late);
			room.emit(
				RoomEvent.TrackSubscriptionStatusChanged,
				late.trackPublications.get('TR_late_mic') as RemoteTrackPublication,
				RemoteTrackPublication.SubscriptionStatus.Subscribed,
				late,
			);
		});
		expect(attachedAudioElements()).toHaveLength(2);
		expect(lateTrack.attachedElements).toHaveLength(1);
		const [lateElement] = lateTrack.attachedElements;

		const latePublication = late.trackPublications.get('TR_late_mic') as RemoteTrackPublication;
		await act(async () => {
			late.unpublishTrack('TR_late_mic');
			room.emit(RoomEvent.TrackUnpublished, latePublication, late);
		});
		expect(attachedAudioElements()).toHaveLength(1);
		expect(lateTrack.attachedElements).toHaveLength(0);
		expect(lateElement.parentElement).toBeNull();

		endCall(room);
		await renderRoot(null);
	});

	it('moves remote audio straight from one room to the next', async () => {
		const mounted = vi.fn();
		function AppTree() {
			useEffect(() => {
				mounted();
			}, []);
			return null;
		}
		const app = createElement(AppTree);
		const first = createCallRoom(30, 2);
		const second = createCallRoom(31, 1);
		const tracksOf = (room: Room) =>
			Array.from(room.remoteParticipants.values()).flatMap((participant) =>
				Array.from(participant.trackPublications.values(), (publication) => publication.track as RemoteAudioTrack),
			);

		await renderRoot(first, app);
		expect(attachedAudioElements()).toHaveLength(2);
		const firstElements = tracksOf(first).flatMap((track) => track.attachedElements);

		await renderRoot(second, app);
		expect(attachedAudioElements()).toHaveLength(1);
		expect(tracksOf(second)[0].attachedElements).toHaveLength(1);
		expect(tracksOf(first).every((track) => track.attachedElements.length === 0)).toBe(true);
		expect(firstElements.every((element) => element.parentElement === null)).toBe(true);
		expect(mounted).toHaveBeenCalledTimes(1);

		endCall(second);
		await renderRoot(null, app);
	});

	it('releases every remote audio element when a call ends so none accumulate across calls', async () => {
		await renderRoot(null);
		const audioContainer = host.lastElementChild;

		for (let call = 0; call < 3; call++) {
			const room = createCallRoom(call, 3);
			await renderRoot(room);
			expect(attachedAudioElements()).toHaveLength(3);

			endCall(room);
			await renderRoot(null);

			expect(attachedAudioElements()).toHaveLength(0);
			expect(Array.from(renderedAudioElements).filter((element) => element.parentElement !== null)).toEqual([]);
			expect(host.lastElementChild).toBe(audioContainer);
		}

		const probe = new RemoteAudioTrack(
			{id: 'TR_probe', kind: 'audio', stop: () => {}} as unknown as MediaStreamTrack,
			'TR_probe',
			{} as RTCRtpReceiver,
		);
		expect(renderedAudioElements.has(probe.attach())).toBe(true);
		probe.detach();
	});
});

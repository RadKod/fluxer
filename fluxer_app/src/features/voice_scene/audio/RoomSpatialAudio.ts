// SPDX-License-Identifier: AGPL-3.0-or-later

import {getSharedVoiceAudioContext} from '@app/features/voice/engine/VoiceSharedAudioContext';
import {
	computeSpeakerAudioParams,
	FLAT_SPEAKER_PARAMS,
	type SpatialAudioInput,
	type SpatialAudioMode,
	type SpatialSpeaker,
	type SpeakerAudioParams,
	spatialSpeakerKey,
} from '@app/features/voice_scene/audio/SpatialAudioMath';
import {
	type RemoteAudioTrack,
	type RemoteParticipant,
	type RemoteTrack,
	type RemoteTrackPublication,
	type Room,
	RoomEvent,
	Track,
} from 'livekit-client';

export type {SpatialSpeaker};

export interface RoomSpatialAudioController {
	attach(room: Room): void;
	detach(): void;
	setMode(mode: SpatialAudioMode): void;
	update(input: SpatialAudioInput): void;
}

interface SpatialChain {
	context: AudioContext;
	panner: PannerNode;
	gain: GainNode;
	target: SpeakerAudioParams;
	modelSwitchTimer: ReturnType<typeof setTimeout> | null;
}

const RAMP_TIME_CONSTANT_S = 0.05;
// panningModel is not an AudioParam; swapping it on a live signal clicks. Fade out (~6τ ≈ −52 dB), swap, fade in.
const MODEL_SWITCH_FADE_MS = 30;
const MODEL_SWITCH_FADE_TIME_CONSTANT_S = 0.005;

// Per track, not per controller: two scenes on one call never stack a second chain on a track.
const chains = new WeakMap<RemoteAudioTrack, SpatialChain>();

const NOOP_CONTROLLER: RoomSpatialAudioController = Object.freeze({
	attach: () => {},
	detach: () => {},
	setMode: () => {},
	update: () => {},
});

function speakerKind(source: Track.Source): SpatialSpeaker['kind'] | null {
	if (source === Track.Source.Microphone) return 'mic';
	if (source === Track.Source.ScreenShareAudio) return 'screen';
	return null;
}

// Values are written directly only here, before setWebAudioPlugins connects the nodes; afterwards only AudioParam ramps.
function installChain(context: AudioContext, track: RemoteAudioTrack, params: SpeakerAudioParams): void {
	if (chains.has(track)) return;
	const panner = context.createPanner();
	panner.panningModel = params.panningModel;
	panner.distanceModel = 'linear';
	panner.refDistance = 1;
	panner.maxDistance = 10000;
	panner.rolloffFactor = 0;
	// Mono in: screen-share audio and the stereo mic option are stereo, and equal-power on stereo input
	// reaches +3/+6 dB per channel. The ≤ 1 bound in SpatialAudioMath holds only for one input channel.
	panner.channelCount = 1;
	panner.channelCountMode = 'explicit';
	panner.positionX.value = params.position.x;
	panner.positionY.value = params.position.y;
	panner.positionZ.value = params.position.z;
	const gain = context.createGain();
	gain.gain.value = params.gain;
	chains.set(track, {context, panner, gain, target: params, modelSwitchTimer: null});
	track.setWebAudioPlugins([panner, gain]);
}

function applyParams(chain: SpatialChain, params: SpeakerAudioParams): void {
	chain.target = params;
	const now = chain.context.currentTime;
	chain.panner.positionX.setTargetAtTime(params.position.x, now, RAMP_TIME_CONSTANT_S);
	chain.panner.positionY.setTargetAtTime(params.position.y, now, RAMP_TIME_CONSTANT_S);
	chain.panner.positionZ.setTargetAtTime(params.position.z, now, RAMP_TIME_CONSTANT_S);
	if (chain.modelSwitchTimer !== null) return; // the pending swap ramps to the latest target
	if (chain.panner.panningModel === params.panningModel) {
		chain.gain.gain.setTargetAtTime(params.gain, now, RAMP_TIME_CONSTANT_S);
		return;
	}
	chain.gain.gain.setTargetAtTime(0, now, MODEL_SWITCH_FADE_TIME_CONSTANT_S);
	chain.modelSwitchTimer = setTimeout(() => {
		chain.modelSwitchTimer = null;
		chain.panner.panningModel = chain.target.panningModel;
		chain.gain.gain.setTargetAtTime(chain.target.gain, chain.context.currentTime, RAMP_TIME_CONSTANT_S);
	}, MODEL_SWITCH_FADE_MS);
}

export function createRoomSpatialAudio(
	getContext: () => AudioContext | null = getSharedVoiceAudioContext,
): RoomSpatialAudioController {
	const context = getContext();
	if (!context) return NOOP_CONTROLLER;

	let room: Room | null = null;
	let mode: SpatialAudioMode = 'spatial';
	let input: SpatialAudioInput | null = null;
	let params = new Map<string, SpeakerAudioParams>();
	const routes = new Map<string, RemoteAudioTrack>();

	const apply = (key: string, track: RemoteAudioTrack): void => {
		const target = params.get(key) ?? FLAT_SPEAKER_PARAMS;
		if (mode === 'spatial') installChain(context, track, target);
		const chain = chains.get(track);
		if (chain) applyParams(chain, target);
	};

	// Every chain we stop steering goes flat, so no track keeps a stale spatial position outside the room view.
	const release = (key: string, track: RemoteAudioTrack): void => {
		const chain = chains.get(track);
		if (chain) applyParams(chain, FLAT_SPEAKER_PARAMS);
		routes.delete(key);
	};

	const applyAll = (): void => {
		params = input ? computeSpeakerAudioParams(input, mode, params) : new Map();
		for (const [key, track] of routes) apply(key, track);
	};

	const onSubscribed = (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
		const kind = speakerKind(publication.source);
		if (!kind || track.kind !== Track.Kind.Audio) return;
		const key = spatialSpeakerKey(participant.identity, kind);
		routes.set(key, track as RemoteAudioTrack);
		apply(key, track as RemoteAudioTrack);
	};

	const onUnsubscribed = (track: RemoteTrack) => {
		for (const [key, routed] of routes) if (routed === track) release(key, routed);
	};

	// Closing the room view gives every track LiveKit's own empty plugin list back, so stereo screen share and the
	// stereo mic are stereo again: one graph rebuild (one click) per track. Spatial off inside the room keeps the
	// chain (flat, still mono) so the toggle never rebuilds.
	const detach = (): void => {
		if (!room) return;
		room.off(RoomEvent.TrackSubscribed, onSubscribed);
		room.off(RoomEvent.TrackUnsubscribed, onUnsubscribed);
		for (const track of routes.values()) if (chains.delete(track)) track.setWebAudioPlugins([]);
		routes.clear();
		room = null;
	};

	return {
		attach(next) {
			if (room === next) return;
			detach();
			room = next;
			next.on(RoomEvent.TrackSubscribed, onSubscribed);
			next.on(RoomEvent.TrackUnsubscribed, onUnsubscribed);
			for (const participant of next.remoteParticipants.values()) {
				for (const publication of participant.audioTrackPublications.values()) {
					if (publication.track) onSubscribed(publication.track, publication, participant);
				}
			}
		},
		detach,
		setMode(next) {
			mode = next;
			applyAll();
		},
		update(next) {
			input = next;
			applyAll();
		},
	};
}

// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Vec3} from '@app/features/voice_scene/scene/VoiceSceneTypes';

export interface SpatialSpeaker {
	identity: string;
	kind: 'mic' | 'screen';
	position: Vec3;
}

export interface SpatialListener {
	position: Vec3;
	/** Radians, three.js OrbitControls sign (counter-clockwise seen from +Y), 0 = camera at cam_home. */
	azimuth: number;
	/** World frame of azimuth 0; pass the room layout. Without it azimuth 0 faces -Z. */
	home?: {camHome: Vec3; camTarget: Vec3};
}

export interface SpatialAudioInput {
	listener: SpatialListener;
	speakers: ReadonlyArray<SpatialSpeaker>;
}

export type SpatialAudioMode = 'spatial' | 'flat';

export interface SpeakerAudioParams {
	/** Listener-relative: listener at the origin facing -Z, +X to the right, +Y up (the AudioListener default). */
	position: Vec3;
	gain: number;
	panningModel: 'HRTF' | 'equalpower';
}

const dbToGain = (db: number): number => 10 ** (db / 20);

/** −3 dB for every speaker: keeps an HRTF speaker under unity at the modeled HRTF peak. */
export const SPEAKER_GAIN = dbToGain(-3);
/** Modeled worst-case HRTF per-ear peak (+3 dB). */
export const HRTF_PEAK_GAIN = dbToGain(3);
/** Undoes the −3 dB of a centered equal-power panner, so flat mode is unity per channel. */
export const FLAT_GAIN = Math.SQRT2;
export const MAX_HRTF_SPEAKERS = 4;
/** An HRTF holder counts this much nearer when the four are picked: near-ties never swap models (30 ms dip each). */
export const HRTF_STICKY_MARGIN_M = 0.5;

export const FLAT_SPEAKER_PARAMS: SpeakerAudioParams = Object.freeze({
	position: Object.freeze({x: 0, y: 0, z: -1}),
	gain: FLAT_GAIN,
	panningModel: 'equalpower',
});

export function spatialSpeakerKey(identity: string, kind: SpatialSpeaker['kind']): string {
	return `${kind}:${identity}`;
}

export function listenerForward(listener: SpatialListener): Vec3 {
	let baseX = 0;
	let baseZ = -1;
	if (listener.home) {
		const dx = listener.home.camTarget.x - listener.home.camHome.x;
		const dz = listener.home.camTarget.z - listener.home.camHome.z;
		const length = Math.hypot(dx, dz);
		if (length > 0) {
			baseX = dx / length;
			baseZ = dz / length;
		}
	}
	const cos = Math.cos(listener.azimuth);
	const sin = Math.sin(listener.azimuth);
	return {x: baseX * cos + baseZ * sin, y: 0, z: -baseX * sin + baseZ * cos};
}

function toListenerFrame(point: Vec3, listener: SpatialListener, forward: Vec3): Vec3 {
	const dx = point.x - listener.position.x;
	const dz = point.z - listener.position.z;
	return {
		x: dx * -forward.z + dz * forward.x,
		y: point.y - listener.position.y,
		z: -(dx * forward.x + dz * forward.z),
	};
}

/** Web Audio equal-power pan law for a mono input (the panner runs with channelCount 1). */
export function equalPowerChannelGains(position: Vec3): [left: number, right: number] {
	const horizontal = Math.hypot(position.x, position.z);
	const pan = horizontal > 0 ? position.x / horizontal : 0;
	const x = Math.asin(pan) / Math.PI + 0.5;
	return [Math.cos((x * Math.PI) / 2), Math.sin((x * Math.PI) / 2)];
}

export function peakChannelGain(params: SpeakerAudioParams): number {
	const panPeak =
		params.panningModel === 'HRTF' ? HRTF_PEAK_GAIN : Math.max(...equalPowerChannelGains(params.position));
	return panPeak * params.gain;
}

// `previous` is the last result for the same scene: its HRTF holders are sticky (HRTF_STICKY_MARGIN_M).
export function computeSpeakerAudioParams(
	input: SpatialAudioInput,
	mode: SpatialAudioMode,
	previous?: ReadonlyMap<string, SpeakerAudioParams>,
): Map<string, SpeakerAudioParams> {
	const result = new Map<string, SpeakerAudioParams>();
	if (mode === 'flat') {
		for (const speaker of input.speakers)
			result.set(spatialSpeakerKey(speaker.identity, speaker.kind), FLAT_SPEAKER_PARAMS);
		return result;
	}
	const {position} = input.listener;
	const ranked = input.speakers.map((speaker) => {
		const d = Math.hypot(
			speaker.position.x - position.x,
			speaker.position.y - position.y,
			speaker.position.z - position.z,
		);
		const held = previous?.get(spatialSpeakerKey(speaker.identity, speaker.kind))?.panningModel === 'HRTF';
		return {speaker, d, rank: held ? d - HRTF_STICKY_MARGIN_M : d};
	});
	// Stable sort: a tie keeps the input (seat) order.
	const hrtf = new Set(
		[...ranked]
			.sort((a, b) => a.rank - b.rank)
			.slice(0, MAX_HRTF_SPEAKERS)
			.map((entry) => entry.speaker),
	);
	const forward = listenerForward(input.listener);
	// The panner keeps rolloffFactor 0: distance and table never change the level, only the direction.
	for (const {speaker} of ranked) {
		result.set(spatialSpeakerKey(speaker.identity, speaker.kind), {
			position: toListenerFrame(speaker.position, input.listener, forward),
			gain: SPEAKER_GAIN,
			panningModel: hrtf.has(speaker) ? 'HRTF' : 'equalpower',
		});
	}
	return result;
}

// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from 'node:assert/strict';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {VOICE_TRACK_MAX_TOTAL_GAIN} from '@app/features/voice/utils/VoiceVolumeUtils';

const logger = new Logger('VoiceSharedAudioContext');

type AudioContextConstructor = typeof AudioContext;

const MASTER_SOFT_CLIP_KNEE = 0.8;
const MASTER_SOFT_CLIP_CURVE_POINTS = 8192;

interface VoiceOutputRoute {
	output: AudioNode;
	hardwareDestination: AudioNode;
	destination: MediaStreamAudioDestinationNode | null;
	element: HTMLAudioElement | null;
	operation: Promise<void>;
}

const voiceOutputRoutes = new WeakMap<AudioContext, VoiceOutputRoute>();

function supportsVoiceOutputElementRouting(): boolean {
	if (typeof HTMLMediaElement === 'undefined' || !('setSinkId' in HTMLMediaElement.prototype)) return false;
	if (typeof navigator === 'undefined') return false;
	const firefoxVersion = Number(/Firefox\/(\d+)/.exec(navigator.userAgent)?.[1]);
	return firefoxVersion >= (/Macintosh|Mac OS X/.test(navigator.userAgent) ? 145 : 123);
}

export function supportsVoiceOutputDeviceSelection(): boolean {
	return (
		(typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype) ||
		supportsVoiceOutputElementRouting()
	);
}

export function canRouteVoiceAudioContextOutput(context: AudioContext): boolean {
	return voiceOutputRoutes.has(context) && supportsVoiceOutputElementRouting();
}

export function setVoiceAudioContextOutput(context: AudioContext, sinkId: string): Promise<void> {
	const route = voiceOutputRoutes.get(context);
	if (!route || !supportsVoiceOutputElementRouting()) return Promise.resolve();
	route.operation = route.operation
		.catch(() => {})
		.then(async () => {
			if (context.state === 'closed') return;
			if (!sinkId) {
				if (!route.destination) return;
				route.output.disconnect(route.destination);
				route.output.connect(route.hardwareDestination);
				route.element?.pause();
				if (route.element) route.element.srcObject = null;
				route.destination.stream.getTracks().forEach((track) => track.stop());
				route.destination = null;
				route.element = null;
				return;
			}
			if (route.element) {
				await route.element.setSinkId(sinkId);
				return;
			}
			const destination = context.createMediaStreamDestination();
			const element = new Audio();
			element.autoplay = true;
			element.srcObject = destination.stream;
			try {
				await element.setSinkId(sinkId);
				await element.play();
				if (voiceOutputRoutes.get(context) !== route) throw new Error('Voice playback context closed');
				route.output.disconnect(route.hardwareDestination);
				route.output.connect(destination);
				route.destination = destination;
				route.element = element;
			} catch (error) {
				element.pause();
				element.srcObject = null;
				destination.stream.getTracks().forEach((track) => track.stop());
				throw error;
			}
		});
	return route.operation;
}

function softClipSample(x: number): number {
	const magnitude = Math.abs(x);
	if (magnitude <= MASTER_SOFT_CLIP_KNEE) return x;
	const over = (magnitude - MASTER_SOFT_CLIP_KNEE) / (1 - MASTER_SOFT_CLIP_KNEE);
	const shaped = MASTER_SOFT_CLIP_KNEE + (1 - MASTER_SOFT_CLIP_KNEE) * Math.tanh(over);
	return x < 0 ? -shaped : shaped;
}

function createVoiceSoftClipCurve(): Float32Array<ArrayBuffer> {
	const curve = new Float32Array(new ArrayBuffer(MASTER_SOFT_CLIP_CURVE_POINTS * Float32Array.BYTES_PER_ELEMENT));
	for (let i = 0; i < MASTER_SOFT_CLIP_CURVE_POINTS; i++) {
		const normalized = (i / (MASTER_SOFT_CLIP_CURVE_POINTS - 1)) * 2 - 1;
		curve[i] = softClipSample(normalized * VOICE_TRACK_MAX_TOTAL_GAIN);
	}
	return curve;
}

export function createVoiceSoftClipNode(context: BaseAudioContext): {input: GainNode; output: WaveShaperNode} | null {
	if (typeof context.createGain !== 'function' || typeof context.createWaveShaper !== 'function') return null;
	const input = context.createGain();
	input.gain.value = 1 / VOICE_TRACK_MAX_TOTAL_GAIN;
	const output = context.createWaveShaper();
	output.curve = createVoiceSoftClipCurve();
	output.oversample = '4x';
	input.connect(output);
	return {input, output};
}

function installMasterSoftClip(context: AudioContext): void {
	const hardwareDestination = context.destination;
	if (!hardwareDestination) return;
	const softClip = createVoiceSoftClipNode(context);
	if (!softClip) return;
	try {
		softClip.output.connect(hardwareDestination);
		Object.defineProperty(context, 'destination', {
			configurable: true,
			get: () => softClip.input,
		});
		const route: VoiceOutputRoute = {
			output: softClip.output,
			hardwareDestination,
			destination: null,
			element: null,
			operation: Promise.resolve(),
		};
		voiceOutputRoutes.set(context, route);
		context.addEventListener('statechange', () => {
			if (context.state !== 'closed') return;
			route.element?.pause();
			if (route.element) route.element.srcObject = null;
			route.destination?.stream.getTracks().forEach((track) => track.stop());
			route.element = null;
			route.destination = null;
			voiceOutputRoutes.delete(context);
		});
	} catch (error) {
		logger.warn('Failed to install master soft clip on shared voice AudioContext', {error});
	}
}

let sharedAudioContext: AudioContext | null = null;
let sharedAudioContextSuspendedAfterCall = false;
let sharedAudioContextLeaseCount = 0;

export interface SharedVoiceAudioContextLease {
	context: AudioContext;
	release(): void;
}

export function acquireSharedVoiceAudioContext(): SharedVoiceAudioContextLease | null {
	const context = getSharedVoiceAudioContext();
	if (!context) return null;
	sharedAudioContextLeaseCount += 1;
	let released = false;
	return {
		context,
		release() {
			if (released) return;
			released = true;
			sharedAudioContextLeaseCount -= 1;
		},
	};
}

export function getSharedVoiceAudioContextLeaseCount(): number {
	return sharedAudioContextLeaseCount;
}

export function resolveAudioContextConstructor(): AudioContextConstructor | null {
	if (typeof window === 'undefined') return null;
	const ctor =
		window.AudioContext ||
		(window as typeof window & {webkitAudioContext?: AudioContextConstructor}).webkitAudioContext;
	return ctor ?? null;
}

export function createVoiceAudioContext(options: AudioContextOptions): AudioContext | null {
	const ctor = resolveAudioContextConstructor();
	if (!ctor) return null;
	try {
		return new ctor(options);
	} catch (error) {
		logger.warn('Failed to construct voice AudioContext', {options, error});
		return null;
	}
}

function installResumeOnUserGesture(context: AudioContext): void {
	if (typeof window === 'undefined') return;
	if (!window.document?.body) return;
	const body = window.document.body;
	const handleResume = (): void => {
		if (context.state === 'suspended') {
			void context.resume().catch((error) => {
				logger.debug('Failed to auto-resume shared voice AudioContext on user gesture', {error});
			});
		}
		body.removeEventListener('click', handleResume);
	};
	context.addEventListener('statechange', () => {
		if (context.state === 'closed') {
			body.removeEventListener('click', handleResume);
		}
	});
	body.addEventListener('click', handleResume);
}

export function getSharedVoiceAudioContext(): AudioContext | null {
	if (sharedAudioContext && sharedAudioContext.state !== 'closed') {
		if (sharedAudioContextSuspendedAfterCall) {
			sharedAudioContextSuspendedAfterCall = false;
			void sharedAudioContext.resume().catch((error) => {
				logger.debug('Failed to resume shared voice AudioContext for a new call', {error});
			});
		}
		return sharedAudioContext;
	}
	sharedAudioContextSuspendedAfterCall = false;
	sharedAudioContext = createVoiceAudioContext({latencyHint: 'interactive'});
	if (!sharedAudioContext) return null;
	assert.notEqual(sharedAudioContext.state, 'closed', 'shared voice AudioContext must not start closed');
	installMasterSoftClip(sharedAudioContext);
	// Teardown after the call can still resume the context: LiveKit rebuilds a track's graph and resumes when the room
	// view drops its spatial nodes, and the first-click resume may fire late. Until the next call, suspend it again.
	sharedAudioContext.addEventListener('statechange', () => {
		if (sharedAudioContextSuspendedAfterCall) suspendSharedVoiceAudioContext();
	});
	if (sharedAudioContext.state === 'suspended') {
		void sharedAudioContext.resume().catch((error) => {
			logger.debug('Initial resume of shared voice AudioContext rejected', {error});
		});
		installResumeOnUserGesture(sharedAudioContext);
	}
	return sharedAudioContext;
}

// Media stream and media element sources stay alive while their context runs, even after disconnect(); suspending
// the context once the call is over lets the call's sources be collected.
export function suspendSharedVoiceAudioContext(): void {
	const context = sharedAudioContext;
	if (context?.state !== 'running') return;
	sharedAudioContextSuspendedAfterCall = true;
	void context.suspend().catch((error) => {
		logger.debug('Failed to suspend shared voice AudioContext after the call', {error});
	});
}

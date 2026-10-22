// SPDX-License-Identifier: AGPL-3.0-or-later

// Previews on the song picker: about fifteen seconds of a song from its preview point, quiet, faded in and out, heard
// only on this device. Only a song whose package is already here plays: a package is tens of megabytes, too much to
// pull for a hover. Voting downloads a song, so whatever the room votes for becomes previewable within seconds.
//
// The stems play through media elements rather than decoded buffers: decoding every stem of a four-minute song for a
// few seconds of it would take hundreds of megabytes. The elements seek straight to the preview point and stream.

import type {BandSongSummary} from '@app/features/activities/band/BandProtocol';
import type {AudioStem, SongPackage} from '@app/features/activities/band/engine/SongPackage';
import type {BandSongLibrary} from '@app/features/activities/band/flow/BandSongLibrary';
import {SONG_HEADROOM_GAIN, stemRoleForPlayback} from '@app/features/activities/band/game/BandAudio';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {acquireSharedVoiceAudioContext} from '@app/features/voice/engine/VoiceSharedAudioContext';
import {action, makeObservable, observableRef} from 'mobx';

const logger = new Logger('BandSongPreview');

export const PREVIEW_LENGTH_MS = 15_000;
// Where a preview starts when the index names no preview point: past the intro, usually into a verse or chorus.
const DEFAULT_START_SHARE = 0.3;
const FADE_IN_S = 0.8;
const FADE_OUT_S = 1.2;
// Under the song volume: a preview is background while people talk and vote.
const PREVIEW_LEVEL = 0.4;
const SEEK_TIMEOUT_MS = 4_000;

export function previewStartMs(song: Pick<BandSongSummary, 'lengthMs' | 'previewStartMs'>): number {
	const latest = Math.max(0, song.lengthMs - PREVIEW_LENGTH_MS);
	const wanted = song.previewStartMs ?? song.lengthMs * DEFAULT_START_SHARE;
	return Math.min(latest, Math.max(0, wanted));
}

// The packaged preview clip when there is one (it starts at its own zero), else every stem the song plays with.
export function previewStems(
	songPackage: Pick<SongPackage, 'stems'>,
	separateStems: boolean,
): {readonly stems: ReadonlyArray<AudioStem>; readonly clip: boolean} {
	const clip = songPackage.stems.filter((stem) => stem.role === 'preview');
	if (clip.length > 0) return {stems: clip.slice(0, 1), clip: true};
	const stems = songPackage.stems.filter((stem) => {
		const role = stemRoleForPlayback(stem.role, separateStems);
		return role !== null && role !== 'crowd';
	});
	return {stems, clip: false};
}

export type BandPreviewState =
	| {readonly status: 'idle'}
	| {readonly status: 'loading'; readonly songId: string}
	| {readonly status: 'playing'; readonly songId: string};

export interface BandPreviewPlayback {
	// Fades out and lets go of everything; safe to call more than once.
	stop(): void;
}

export type BandPreviewPlayer = (request: {
	readonly stems: ReadonlyArray<AudioStem>;
	readonly offsetMs: number;
	readonly level: number;
	readonly onEnded: () => void;
}) => Promise<BandPreviewPlayback | null>;

interface BandSongPreviewOptions {
	readonly library: Pick<BandSongLibrary, 'isOnDevice' | 'openStored'>;
	// The song volume setting, 0..1.
	readonly volume: () => number;
	readonly player?: BandPreviewPlayer;
}

export class BandSongPreview {
	state: BandPreviewState = {status: 'idle'};
	private playback: BandPreviewPlayback | null = null;
	private request = 0;
	private readonly library: BandSongPreviewOptions['library'];
	private readonly volume: () => number;
	private readonly player: BandPreviewPlayer;

	constructor({library, volume, player = playStems}: BandSongPreviewOptions) {
		this.library = library;
		this.volume = volume;
		this.player = player;
		makeObservable<BandSongPreview, 'setState'>(this, {state: observableRef, setState: action});
	}

	get songId(): string | null {
		return this.state.status === 'idle' ? null : this.state.songId;
	}

	// Plays this song's preview instead of the current one; a song that is not on this device only stops it.
	play(song: BandSongSummary): void {
		if (this.songId === song.id) return;
		this.stop();
		if (!this.library.isOnDevice(song.id)) return;
		const request = this.request;
		this.setState({status: 'loading', songId: song.id});
		void this.library
			.openStored(song.id)
			.then((songPackage) => {
				if (request !== this.request || !songPackage) return null;
				const {stems, clip} = previewStems(songPackage, song.stems);
				return this.player({
					stems,
					offsetMs: clip ? 0 : previewStartMs(song),
					level: PREVIEW_LEVEL * this.volume(),
					onEnded: () => {
						if (request === this.request) this.stop();
					},
				});
			})
			.then(
				(playback) => {
					if (request !== this.request) {
						playback?.stop();
						return;
					}
					this.playback = playback;
					this.setState(playback ? {status: 'playing', songId: song.id} : {status: 'idle'});
				},
				(error: unknown) => {
					logger.warn('Preview could not start', {songId: song.id, error});
					if (request === this.request) this.setState({status: 'idle'});
				},
			);
	}

	stop(): void {
		this.request++;
		this.playback?.stop();
		this.playback = null;
		if (this.state.status !== 'idle') this.setState({status: 'idle'});
	}

	private setState(state: BandPreviewState): void {
		this.state = state;
	}
}

function waitFor(element: HTMLMediaElement, event: 'seeked' | 'loadedmetadata'): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Preview stem timed out waiting for ${event}`)), SEEK_TIMEOUT_MS);
		element.addEventListener(
			event,
			() => {
				clearTimeout(timer);
				resolve();
			},
			{once: true},
		);
		element.addEventListener(
			'error',
			() => {
				clearTimeout(timer);
				reject(element.error ?? new Error('Preview stem could not be read'));
			},
			{once: true},
		);
	});
}

// Every stem in its own media element, seeked to the preview point, then started together under one fading gain on
// the shared voice context, so the preview follows the chosen output device like the song does.
const playStems: BandPreviewPlayer = async ({stems, offsetMs, level, onEnded}) => {
	const lease = acquireSharedVoiceAudioContext();
	if (!lease || stems.length === 0) {
		lease?.release();
		return null;
	}
	const {context} = lease;
	const gain = context.createGain();
	gain.gain.value = 0;
	gain.connect(context.destination);
	const urls: Array<string> = [];
	const elements: Array<HTMLAudioElement> = [];
	const sources: Array<MediaElementAudioSourceNode> = [];
	let endTimer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;
	const release = () => {
		for (const element of elements) {
			element.pause();
			element.removeAttribute('src');
			element.load();
		}
		for (const source of sources) source.disconnect();
		for (const url of urls) URL.revokeObjectURL(url);
		gain.disconnect();
		lease.release();
	};
	const playback: BandPreviewPlayback = {
		stop() {
			if (stopped) return;
			stopped = true;
			if (endTimer) clearTimeout(endTimer);
			const now = context.currentTime;
			gain.gain.cancelScheduledValues(now);
			gain.gain.setValueAtTime(gain.gain.value, now);
			gain.gain.linearRampToValueAtTime(0, now + FADE_OUT_S / 3);
			setTimeout(release, (FADE_OUT_S / 3) * 1000 + 50);
		},
	};
	try {
		for (const stem of stems) {
			const url = URL.createObjectURL(new Blob([stem.data.slice()], {type: 'audio/ogg'}));
			urls.push(url);
			const element = new Audio();
			element.preload = 'auto';
			element.src = url;
			elements.push(element);
			const source = context.createMediaElementSource(element);
			source.connect(gain);
			sources.push(source);
		}
		await Promise.all(
			elements.map(async (element) => {
				if (element.readyState < HTMLMediaElement.HAVE_METADATA) await waitFor(element, 'loadedmetadata');
				const seeked = waitFor(element, 'seeked');
				element.currentTime = offsetMs / 1000;
				await seeked;
			}),
		);
		if (stopped) return null;
		await context.resume().catch(() => {});
		await Promise.all(elements.map((element) => element.play()));
	} catch (error) {
		stopped = true;
		release();
		throw error;
	}
	const target = level * SONG_HEADROOM_GAIN;
	const now = context.currentTime;
	gain.gain.setValueAtTime(0, now);
	gain.gain.linearRampToValueAtTime(target, now + FADE_IN_S);
	gain.gain.setValueAtTime(target, now + PREVIEW_LENGTH_MS / 1000 - FADE_OUT_S);
	gain.gain.linearRampToValueAtTime(0, now + PREVIEW_LENGTH_MS / 1000);
	endTimer = setTimeout(() => {
		endTimer = null;
		onEnded();
	}, PREVIEW_LENGTH_MS);
	return playback;
};

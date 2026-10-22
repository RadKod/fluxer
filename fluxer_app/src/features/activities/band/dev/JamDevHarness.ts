// SPDX-License-Identifier: AGPL-3.0-or-later

// Local harness for jam mode's audio engine: load the sample set, play an instrument from the keyboard, run a
// backing loop, and optionally hear every note again as a "remote" player through the real wire format, network
// delay and jitter buffer. Measures key press to sound for my own notes from the AudioContext's output timestamps.
// Keys (dev only, the real controls are the play screen's job): A S D F G lanes, Shift + lane pinch (lead) or the
// alternate drum, Space whole-step bend, Shift+Space step and a half, Z / X octave down / up.

import {encodeWav, type JamTechniqueReport, renderJamTechniques} from '@app/features/activities/band/dev/JamDevRender';
import {readAudioAnchor} from '@app/features/activities/band/game/BandAudio';
import {
	JAM_ASSET_BASE_URL,
	type JamSampleBank,
	loadJamSamples,
	sampleKeys,
} from '@app/features/activities/band/jam/JamAssets';
import {JAM_BACKING_PATTERNS, JamBacking, type JamBackingStyle} from '@app/features/activities/band/jam/JamBacking';
import {JamMixer} from '@app/features/activities/band/jam/JamInstruments';
import type {JamMessage} from '@app/features/activities/band/jam/JamMessages';
import {type JamAction, JamPlayer} from '@app/features/activities/band/jam/JamPlayer';
import {
	availableOctaves,
	drumNote,
	type JamInstrument,
	type JamKey,
	type JamMelodicInstrument,
	type JamScale,
	laneNotes,
	pinchHarmonicFor,
	playableRange,
	powerChordRoot,
} from '@app/features/activities/band/jam/JamScales';
import {action, makeObservable, observable, observableRef, runInAction} from 'mobx';

// rspack.jam-dev.config.mjs serves JAM_SAMPLES_DIR here.
const JAM_DEV_SAMPLES_PATH = '/dogaclama/';
const LANE_CODES = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG'] as const;
const LATENCY_SAMPLES = 40;
const ECHO_ID = 'echo';

export function jamAssetUrlFromLocation(location: Location): string {
	const configured = new URLSearchParams(location.search).get('jam');
	if (configured === 'live') return JAM_ASSET_BASE_URL;
	const url = configured && configured.length > 0 ? configured : `${location.origin}${JAM_DEV_SAMPLES_PATH}`;
	return url.endsWith('/') ? url : `${url}/`;
}

export type GuitarTone = 'lead' | 'clean';

export interface JamDevSettings {
	instrument: JamInstrument;
	tone: GuitarTone;
	powerChords: boolean;
	key: JamKey;
	scale: JamScale;
	octave: number;
	position: number;
	backingStyle: JamBackingStyle;
	bpm: number;
	backingDrums: boolean;
	backingBass: boolean;
	click: boolean;
	echo: boolean;
	echoDelayMs: number;
	echoJitterMs: number;
}

function median(values: ReadonlyArray<number>): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

export class JamDevHarness {
	status = 'Başlatılmadı';
	bank: JamSampleBank | null = null;
	loadMs: number | null = null;
	backingRunning = false;
	latencies: ReadonlyArray<number> = [];
	lateEvents = 0;
	lastLateMs = 0;
	renderReport: JamTechniqueReport | null = null;
	renderWavUrl: string | null = null;
	rendering = false;
	settings: JamDevSettings = {
		instrument: 'guitar',
		tone: 'lead',
		powerChords: false,
		key: 9,
		scale: 'minorPentatonic',
		octave: 0,
		position: 0,
		backingStyle: 'rock',
		bpm: JAM_BACKING_PATTERNS.rock.bpm,
		backingDrums: true,
		backingBass: true,
		click: false,
		echo: false,
		echoDelayMs: 40,
		echoJitterMs: 30,
	};

	private context: AudioContext | null = null;
	private mixer: JamMixer | null = null;
	private player: JamPlayer | null = null;
	private backing: JamBacking | null = null;
	private readonly sounding = new Map<string, number>();
	private bending = false;

	constructor(readonly assetUrl: string) {
		makeObservable<JamDevHarness, 'recordLatency' | 'recordLate'>(this, {
			status: observable,
			bank: observableRef,
			loadMs: observable,
			backingRunning: observable,
			latencies: observableRef,
			lateEvents: observable,
			lastLateMs: observable,
			renderReport: observableRef,
			renderWavUrl: observable,
			rendering: observable,
			renderTechniques: action,
			settings: observable,
			start: action,
			update: action,
			toggleBacking: action,
			recordLatency: action,
			recordLate: action,
		});
	}

	get audioInfo(): string {
		const context = this.context;
		if (!context) return '';
		const base = (context.baseLatency ?? 0) * 1000;
		const output = (context.outputLatency ?? 0) * 1000;
		return `${context.sampleRate} Hz, baseLatency ${base.toFixed(1)} ms, outputLatency ${output.toFixed(1)} ms`;
	}

	get medianLatency(): number | null {
		return median(this.latencies);
	}

	laneLabels(): ReadonlyArray<string> {
		const {instrument} = this.settings;
		if (instrument === 'drums') return ['kick', 'snare', 'hi-hat (⇧ açık)', 'tom (⇧ yer tomu)', 'crash (⇧ ride)'];
		return this.lanes().map((note) => `${noteName(note)} (${note})`);
	}

	octaveChoices(): ReadonlyArray<number> {
		const {instrument} = this.settings;
		if (instrument === 'drums' || !this.bank) return [];
		return availableOctaves(instrument, this.settings, this.range(instrument));
	}

	async start(): Promise<void> {
		if (this.context) return;
		const context = new AudioContext({latencyHint: 'interactive'});
		this.context = context;
		this.status = 'Yükleniyor…';
		const started = performance.now();
		try {
			const bank = await loadJamSamples(context, {
				baseUrl: this.assetUrl,
				onProgress: (done, total) => runInAction(() => (this.status = `Yükleniyor ${done}/${total}`)),
			});
			const mixer = new JamMixer(context, bank, context.destination);
			const player = new JamPlayer(
				mixer,
				{offsetMs: 0, now: () => performance.timeOrigin + performance.now()},
				{send: (message) => this.echo(message), onLate: (_, lateMs) => this.recordLate(lateMs)},
			);
			runInAction(() => {
				this.bank = bank;
				this.mixer = mixer;
				this.player = player;
				this.loadMs = performance.now() - started;
				this.status = `Hazır (${bank.format})`;
			});
			this.applyInstrument();
		} catch (error) {
			runInAction(() => (this.status = `Yüklenemedi: ${String(error)}`));
		}
	}

	update(patch: Partial<JamDevSettings>): void {
		const instrumentChanged = patch.instrument !== undefined && patch.instrument !== this.settings.instrument;
		this.settings = {...this.settings, ...patch};
		if (patch.backingStyle) this.settings.bpm = JAM_BACKING_PATTERNS[patch.backingStyle].bpm;
		if (instrumentChanged || patch.echo !== undefined) this.applyInstrument();
		this.backing?.update({
			style: this.settings.backingStyle,
			key: this.settings.key,
			scale: this.settings.scale,
			bpm: this.settings.bpm,
			drums: this.settings.backingDrums,
			bass: this.settings.backingBass,
			click: this.settings.click,
		});
	}

	toggleBacking(): void {
		if (!this.mixer) return;
		this.backing ??= new JamBacking(this.mixer, {
			style: this.settings.backingStyle,
			key: this.settings.key,
			scale: this.settings.scale,
			bpm: this.settings.bpm,
			drums: this.settings.backingDrums,
			bass: this.settings.backingBass,
			click: this.settings.click,
		});
		if (this.backing.running) this.backing.stop();
		else this.backing.start();
		this.backingRunning = this.backing.running;
	}

	// teknik.py's bend, pinch and feedback demos through the engine, offline, with the prototype's measurements.
	async renderTechniques(): Promise<JamTechniqueReport | null> {
		this.rendering = true;
		try {
			const {buffer, report} = await renderJamTechniques(this.assetUrl);
			const url = URL.createObjectURL(encodeWav(buffer));
			runInAction(() => {
				if (this.renderWavUrl) URL.revokeObjectURL(this.renderWavUrl);
				this.renderReport = report;
				this.renderWavUrl = url;
			});
			return report;
		} catch (error) {
			runInAction(() => (this.status = `Render olmadı: ${String(error)}`));
			return null;
		} finally {
			runInAction(() => (this.rendering = false));
		}
	}

	handleKeyDown(event: KeyboardEvent): void {
		if (!this.player || event.repeat || event.metaKey || event.ctrlKey) return;
		const lane = LANE_CODES.indexOf(event.code as (typeof LANE_CODES)[number]);
		if (lane >= 0) {
			event.preventDefault();
			this.noteOn(event.code, lane, event.shiftKey, event.timeStamp);
		} else if (event.code === 'Space') {
			event.preventDefault();
			if (this.bending) return;
			this.bending = true;
			this.play({kind: 'bendOn', semitones: event.shiftKey ? 3 : 2}, event.timeStamp);
		} else if (event.code === 'KeyZ' || event.code === 'KeyX') {
			this.shiftOctave(event.code === 'KeyZ' ? -1 : 1);
		}
	}

	handleKeyUp(event: KeyboardEvent): void {
		if (!this.player) return;
		const note = this.sounding.get(event.code);
		if (note !== undefined) {
			this.sounding.delete(event.code);
			this.play({kind: 'noteOff', note}, event.timeStamp);
		} else if (event.code === 'Space' && this.bending) {
			this.bending = false;
			this.play({kind: 'bendOff'}, event.timeStamp);
		}
	}

	// Window blur: nothing may keep sounding without its key.
	releaseAll(): void {
		for (const [code, note] of this.sounding) {
			this.sounding.delete(code);
			this.play({kind: 'noteOff', note});
		}
		if (this.bending) {
			this.bending = false;
			this.play({kind: 'bendOff'});
		}
	}

	dispose(): void {
		this.backing?.dispose();
		this.player?.dispose();
		this.mixer?.dispose();
		void this.context?.close();
	}

	private shiftOctave(delta: number): void {
		const choices = this.octaveChoices();
		const next = this.settings.octave + delta;
		if (choices.includes(next)) this.update({octave: next});
	}

	private range(instrument: JamMelodicInstrument) {
		const bank = this.bank;
		if (!bank) return {low: 0, high: 127};
		if (instrument === 'bass') return playableRange(sampleKeys(bank, 'bas'));
		if (instrument === 'keys') return playableRange(sampleKeys(bank, 'klavye'));
		return playableRange(sampleKeys(bank, this.settings.tone === 'clean' ? 'gitar_temiz' : 'gitar_di'));
	}

	private lanes(): ReadonlyArray<number> {
		const {instrument} = this.settings;
		if (instrument === 'drums') return [];
		return laneNotes(instrument, this.settings, this.range(instrument));
	}

	private noteOn(code: string, lane: number, shift: boolean, timeStamp: number): void {
		const {instrument, tone, powerChords} = this.settings;
		const previous = this.sounding.get(code);
		if (previous !== undefined) this.play({kind: 'noteOff', note: previous}, timeStamp);
		if (instrument === 'drums') {
			this.play({kind: 'noteOn', note: drumNote(lane, shift)}, timeStamp);
			return;
		}
		let note = this.lanes()[lane];
		if (note === undefined) return;
		const guitar = instrument === 'guitar';
		const powerChord = guitar && powerChords;
		if (powerChord && this.bank) note = powerChordRoot(note, playableRange(sampleKeys(this.bank, 'gitar_guc')));
		this.sounding.set(code, note);
		this.play(
			{
				kind: 'noteOn',
				note,
				pinchHarmonic:
					guitar && !powerChord && tone === 'lead' && shift
						? pinchHarmonicFor(note, this.settings.key, this.settings.scale)
						: 0,
				powerChord,
				clean: guitar && tone === 'clean',
			},
			timeStamp,
		);
	}

	private play(jamAction: JamAction, timeStamp?: number): void {
		const player = this.player;
		const context = this.context;
		if (!player || !context) return;
		const start = player.play(jamAction, timeStamp);
		if (timeStamp !== undefined && jamAction.kind === 'noteOn') {
			// The output timestamp ties a context time to when it leaves the speaker, so this is key down to sound.
			const anchor = readAudioAnchor(context);
			const heardAt = anchor.performanceTime + (start - anchor.contextTime) * 1000;
			this.recordLatency(heardAt - timeStamp);
		}
	}

	private applyInstrument(): void {
		const player = this.player;
		if (!player) return;
		this.releaseAll();
		player.setLocalInstrument(this.settings.instrument);
		if (this.settings.echo) player.setRemoteInstrument(ECHO_ID, this.settings.instrument);
		else player.removeRemote(ECHO_ID);
	}

	// The loopback "remote" player: my own message back after a simulated network delay.
	private echo(message: JamMessage): void {
		if (!this.settings.echo) return;
		const {echoDelayMs, echoJitterMs} = this.settings;
		const delay = Math.max(0, echoDelayMs + (Math.random() * 2 - 1) * echoJitterMs);
		const payload: unknown = JSON.parse(JSON.stringify(message));
		setTimeout(() => this.player?.receive(ECHO_ID, payload), delay);
	}

	private recordLatency(ms: number): void {
		this.latencies = [...this.latencies.slice(-(LATENCY_SAMPLES - 1)), ms];
	}

	private recordLate(lateMs: number): void {
		this.lateEvents += 1;
		this.lastLateMs = lateMs;
	}
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteName(midi: number): string {
	return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

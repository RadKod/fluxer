// SPDX-License-Identifier: AGPL-3.0-or-later

// Everything the jam screen runs while it is open on a joined client: the samples, my instrument, the other players'
// instruments behind the jitter buffer, and the backing loop on the session clock. It plays on the song's audio path
// (the shared voice context, the band volume and the song headroom), so only people who joined the activity hear it,
// and it is all let go when the room leaves jam mode.

import type {BandJamInstrument} from '@app/features/activities/band/BandProtocol';
import {sessionToContextTime} from '@app/features/activities/band/engine/SessionClock';
import type {BandJamState} from '@app/features/activities/band/flow/BandJamMachine';
import type {BandRoom} from '@app/features/activities/band/flow/BandRoom';
import {BandAudio, readAudioAnchor} from '@app/features/activities/band/game/BandAudio';
import BandSettings from '@app/features/activities/band/game/BandSettings';
import {type JamSampleBank, loadJamSamples, sampleKeys} from '@app/features/activities/band/jam/JamAssets';
import {JamBacking, type JamBackingSettings} from '@app/features/activities/band/jam/JamBacking';
import {JamMixer} from '@app/features/activities/band/jam/JamInstruments';
import type {JamKeyboardTarget, JamLaneSound} from '@app/features/activities/band/jam/JamKeyboard';
import type {JamEvent, JamMessage} from '@app/features/activities/band/jam/JamMessages';
import {type JamAction, JamPlayer} from '@app/features/activities/band/jam/JamPlayer';
import {JamRemotes, jamEngineInstrument} from '@app/features/activities/band/jam/JamRemotes';
import {
	availableOctaves,
	drumNote,
	drumPiece,
	JAM_DRUM_LANES,
	JAM_LANE_COUNT,
	JAM_SCALES,
	type JamKey,
	type JamMelodicInstrument,
	type JamNoteRange,
	type JamScale,
	laneNotes,
	pinchHarmonicFor,
	playableRange,
	powerChordRoot,
} from '@app/features/activities/band/jam/JamScales';
import JamSettings from '@app/features/activities/band/jam/JamSettings';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {
	action,
	autorun,
	compareStructural,
	computed,
	makeObservable,
	observable,
	observableRef,
	reaction,
	runInAction,
} from 'mobx';

const logger = new Logger('JamRuntime');

export type JamRuntimeStatus = 'loading' | 'ready' | 'noAudio' | 'failed';

export interface JamLaneLight {
	readonly down: boolean;
	readonly pinch: boolean;
}

const LANE_OFF: JamLaneLight = {down: false, pinch: false};
const LANES_OFF: ReadonlyArray<JamLaneLight> = Array.from({length: JAM_LANE_COUNT}, () => LANE_OFF);
const REMOTE_OFF: ReadonlyArray<boolean> = Array.from({length: JAM_LANE_COUNT}, () => false);
// A drum hit has no note off; its lane on a bandmate's card lights this long.
const DRUM_FLASH_MS = 140;
// The loop is checked against the session clock this often, so clock corrections and drift do not pile up.
const BACKING_RESYNC_MS = 5_000;

// The lane a bandmate's note sits on: its place in the scale. The five lanes are the scale's first five degrees in
// every octave, so this holds for octave shifts, power chord roots and pinches alike. Null for a note off the scale.
export function laneOfNote(note: number, key: JamKey, scale: JamScale): number | null {
	const pitchClass = (((note - key) % 12) + 12) % 12;
	const degree = JAM_SCALES[scale].indexOf(pitchClass);
	return degree >= 0 && degree < JAM_LANE_COUNT ? degree : null;
}

export function laneOfDrum(note: number): number | null {
	const piece = drumPiece(note);
	if (!piece) return null;
	const lane = JAM_DRUM_LANES.findIndex((entry) => entry.piece === piece || entry.alternate === piece);
	return lane >= 0 ? lane : null;
}

// The backing leaves out what a person plays: a drummer in the room silences the loop's drums, a bassist its bass.
export function backingSettings(state: BandJamState): JamBackingSettings {
	const played = new Set(state.seats.map((seat) => seat.instrument));
	return {
		style: state.backing.style,
		key: state.key,
		scale: state.scale,
		bpm: state.backing.bpm,
		drums: !played.has('drums'),
		bass: !played.has('bass'),
		click: false,
	};
}

interface RemoteNotes {
	readonly instrument: BandJamInstrument;
	readonly lanes: Map<number, number>;
}

export class JamRuntime implements JamKeyboardTarget {
	status: JamRuntimeStatus = 'loading';
	loadedFiles = 0;
	totalFiles = 0;
	bank: JamSampleBank | null = null;
	octave = 0;
	lanes: ReadonlyArray<JamLaneLight> = LANES_OFF;
	bend = 0;
	// Lit lanes on each bandmate's card, by user id.
	readonly remoteLanes = observable.map<string, ReadonlyArray<boolean>>();

	private audio: BandAudio | null = null;
	private mixer: JamMixer | null = null;
	private player: JamPlayer | null = null;
	private backing: JamBacking | null = null;
	private remotes: JamRemotes | null = null;
	private readonly remoteNotes = new Map<string, RemoteNotes>();
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();
	private readonly abort = new AbortController();
	private readonly disposers: Array<() => void> = [];
	private drumHits = 0;
	private disposed = false;

	constructor(private readonly room: BandRoom) {
		makeObservable<JamRuntime, 'setRemoteLane'>(this, {
			status: observable,
			loadedFiles: observable,
			totalFiles: observable,
			bank: observableRef,
			octave: observable,
			lanes: observableRef,
			bend: observable,
			state: computed,
			myInstrument: computed,
			laneNotes: computed,
			octaveChoices: computed,
			shiftOctave: action,
			showLane: action,
			showBend: action,
			setRemoteLane: action,
		});
	}

	get state(): BandJamState | null {
		const state = this.room.state;
		return state?.phase === 'jam' ? state : null;
	}

	get myInstrument(): BandJamInstrument | null {
		return this.room.myJamSeat?.instrument ?? null;
	}

	// The five notes my lanes play right now, low to high; null on drums and until the samples are in.
	get laneNotes(): ReadonlyArray<number> | null {
		const layout = this.melodicLayout();
		return layout ? laneNotes(layout.instrument, {...layout.scale, octave: this.octave}, layout.range) : null;
	}

	get octaveChoices(): ReadonlyArray<number> {
		const layout = this.melodicLayout();
		return layout ? availableOctaves(layout.instrument, layout.scale, layout.range) : [];
	}

	// The octave the lanes actually sit on: the wanted one when the samples reach it, else the nearest that fits.
	get effectiveOctave(): number {
		const choices = this.octaveChoices;
		if (choices.length === 0) return 0;
		return choices.reduce((best, octave) =>
			Math.abs(octave - this.octave) < Math.abs(best - this.octave) ? octave : best,
		);
	}

	start(): void {
		const audio = BandAudio.create();
		if (!audio) {
			runInAction(() => (this.status = 'noAudio'));
			return;
		}
		this.audio = audio;
		this.disposers.push(autorun(() => audio.setVolume(BandSettings.volume)));
		loadJamSamples(audio.context, {
			signal: this.abort.signal,
			onProgress: (done, total) =>
				runInAction(() => {
					this.loadedFiles = done;
					this.totalFiles = total;
				}),
		}).then(
			(bank) => {
				if (!this.disposed) this.ready(audio, bank);
			},
			(error: unknown) => {
				if (this.disposed) return;
				logger.warn('Jam samples did not load', error);
				runInAction(() => (this.status = 'failed'));
			},
		);
	}

	instrument(): BandJamInstrument | null {
		return this.status === 'ready' ? this.myInstrument : null;
	}

	laneSound(lane: number, alternate: boolean, pinch: boolean): JamLaneSound | null {
		const instrument = this.myInstrument;
		const state = this.state;
		if (!instrument || !state) return null;
		if (instrument === 'drums') return {note: drumNote(lane, alternate), options: {}};
		const note = this.laneNotes?.[lane];
		if (note === undefined) return null;
		if (instrument === 'guitar') {
			return {note, options: {pinchHarmonic: pinch ? pinchHarmonicFor(note, state.key, state.scale) : 0}};
		}
		if (instrument === 'rhythm') {
			if (JamSettings.rhythmTone === 'clean') return {note, options: {clean: true}};
			const chords = this.range('gitar_guc');
			return chords ? {note: powerChordRoot(note, chords), options: {powerChord: true}} : null;
		}
		return {note, options: {}};
	}

	play(jamAction: JamAction, timeStamp: number): void {
		this.player?.play(jamAction, timeStamp);
	}

	shiftOctave(delta: -1 | 1): void {
		const next = this.effectiveOctave + delta;
		if (this.octaveChoices.includes(next)) this.octave = next;
	}

	showLane(lane: number, down: boolean, pinch: boolean): void {
		const current = this.lanes[lane];
		if (!current || (current.down === down && current.pinch === pinch)) return;
		this.lanes = this.lanes.map((light, index) => (index === lane ? {down, pinch: down && pinch} : light));
	}

	showBend(semitones: number): void {
		this.bend = semitones;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.abort.abort();
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
		for (const dispose of this.disposers.splice(0)) dispose();
		this.backing?.dispose();
		this.player?.dispose();
		this.mixer?.dispose();
		this.audio?.dispose();
	}

	private ready(audio: BandAudio, bank: JamSampleBank): void {
		const mixer = new JamMixer(audio.context, bank, audio.output);
		const player = new JamPlayer(mixer, this.room.session.clock, {
			send: (message) => this.send(message),
			onScheduled: (identity, event, time) => this.scheduleRemoteLight(identity, event, time),
		});
		const remotes = new JamRemotes(player);
		this.mixer = mixer;
		this.player = player;
		this.remotes = remotes;
		runInAction(() => {
			this.bank = bank;
			this.status = 'ready';
		});
		this.disposers.push(
			reaction(
				() => this.myInstrument,
				(instrument) => player.setLocalInstrument(instrument ? jamEngineInstrument(instrument) : null),
				{fireImmediately: true},
			),
			reaction(
				() => this.state?.seats ?? [],
				(seats) => {
					remotes.updateSeats(seats);
					const seated = new Set(seats.map((seat) => seat.userId));
					for (const userId of [...this.remoteNotes.keys()]) {
						if (seated.has(userId)) continue;
						this.remoteNotes.delete(userId);
						this.setRemoteLane(userId, null);
					}
				},
				{fireImmediately: true},
			),
			reaction(
				() => {
					const state = this.state;
					return state ? {settings: backingSettings(state), on: state.backing.on, since: state.backing.since} : null;
				},
				() => this.applyBacking(),
				{fireImmediately: true, equals: compareStructural},
			),
			this.room.session.onMessage(({from, payload}) => remotes.receive(from, payload)),
		);
		const resync = setInterval(() => this.applyBacking(), BACKING_RESYNC_MS);
		this.disposers.push(() => clearInterval(resync));
	}

	private applyBacking(): void {
		const state = this.state;
		const mixer = this.mixer;
		const audio = this.audio;
		if (!state || !mixer || !audio) return;
		if (!state.backing.on) {
			this.backing?.stop();
			return;
		}
		const settings = backingSettings(state);
		this.backing ??= new JamBacking(mixer, settings);
		this.backing.update(settings);
		const {clock} = this.room.session;
		this.backing.sync(sessionToContextTime(state.backing.since, clock.offsetMs, readAudioAnchor(audio.context)));
	}

	// To the other members only: someone in the call who has not joined does not hear the jam.
	private send(message: JamMessage): void {
		const {session} = this.room;
		const to = session.members.filter((member) => !member.isLocal).map((member) => member.identity);
		if (to.length === 0) return;
		session.send(message, {to}).catch((error: unknown) => logger.debug('Jam event not sent', error));
	}

	private melodicLayout(): {
		readonly instrument: JamMelodicInstrument;
		readonly scale: {readonly key: JamKey; readonly scale: JamScale};
		readonly range: JamNoteRange;
	} | null {
		const instrument = this.myInstrument;
		const state = this.state;
		if (!instrument || instrument === 'drums' || !state) return null;
		const range = this.range(
			instrument === 'bass'
				? 'bas'
				: instrument === 'keys'
					? 'klavye'
					: instrument === 'rhythm' && JamSettings.rhythmTone === 'clean'
						? 'gitar_temiz'
						: 'gitar_di',
		);
		if (!range) return null;
		const engine = jamEngineInstrument(instrument);
		if (engine === 'drums') return null;
		return {instrument: engine, scale: {key: state.key, scale: state.scale}, range};
	}

	private range(group: 'gitar_temiz' | 'gitar_di' | 'gitar_guc' | 'bas' | 'klavye'): JamNoteRange | null {
		const bank = this.bank;
		if (!bank) return null;
		const keys = sampleKeys(bank, group);
		return keys.length > 0 ? playableRange(keys) : null;
	}

	// Bandmates' lanes light when their note is heard, not when it arrives a jitter buffer earlier.
	private scheduleRemoteLight(identity: string, event: JamEvent, time: number): void {
		const userId = this.remotes?.userOf(identity);
		const context = this.audio?.context;
		if (!userId || !context || (event.kind !== 'noteOn' && event.kind !== 'noteOff')) return;
		const delayMs = Math.max(0, (time - context.currentTime) * 1000);
		this.later(() => this.lightRemote(userId, event), delayMs);
	}

	private lightRemote(userId: string, event: Extract<JamEvent, {kind: 'noteOn' | 'noteOff'}>): void {
		const state = this.state;
		const instrument = state?.seats.find((seat) => seat.userId === userId)?.instrument;
		if (!state || !instrument) return;
		let notes = this.remoteNotes.get(userId);
		if (!notes || notes.instrument !== instrument) {
			notes = {instrument, lanes: new Map()};
			this.remoteNotes.set(userId, notes);
		}
		if (instrument === 'drums') {
			const lane = event.kind === 'noteOn' ? laneOfDrum(event.note) : null;
			if (lane === null) return;
			// Hits are keyed apart from notes, so two hits on one drum each keep their own flash.
			const hit = -++this.drumHits;
			notes.lanes.set(hit, lane);
			this.setRemoteLane(userId, notes);
			this.later(() => {
				notes.lanes.delete(hit);
				this.setRemoteLane(userId, notes);
			}, DRUM_FLASH_MS);
			return;
		}
		if (event.kind === 'noteOff') {
			notes.lanes.delete(event.note);
		} else {
			const lane = laneOfNote(event.note, state.key, state.scale);
			// The lead and the power chords sound one note at a time; a new one ends the last.
			if (instrument === 'guitar' || (instrument === 'rhythm' && event.powerChord)) notes.lanes.clear();
			if (lane !== null) notes.lanes.set(event.note, lane);
		}
		this.setRemoteLane(userId, notes);
	}

	private setRemoteLane(userId: string, notes: RemoteNotes | null): void {
		if (!notes || notes.lanes.size === 0) {
			this.remoteLanes.delete(userId);
			return;
		}
		const lit = new Set(notes.lanes.values());
		this.remoteLanes.set(
			userId,
			REMOTE_OFF.map((_, lane) => lit.has(lane)),
		);
	}

	private later(run: () => void, delayMs: number): void {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			if (!this.disposed) run();
		}, delayMs);
		this.timers.add(timer);
	}
}

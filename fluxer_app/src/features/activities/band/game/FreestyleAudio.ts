// SPDX-License-Identifier: AGPL-3.0-or-later

// The sound of freestyle solos: my keys play the song's key on the jam lead guitar (or the keys) with the jam
// techniques, and every other freestyle player's notes arrive as jam messages and play on their own instrument here,
// behind the jitter buffer on the session clock. The scoring and the cues are the PlayController's.

import type {BandSongKey} from '@app/features/activities/band/BandProtocol';
import type {InstrumentPart} from '@app/features/activities/band/engine/ChartModel';
import {type SoloSection, soloSectionAt} from '@app/features/activities/band/engine/FreestyleSolo';
import type {BandAudio} from '@app/features/activities/band/game/BandAudio';
import {type JamSampleBank, loadJamSamples, sampleKeys} from '@app/features/activities/band/jam/JamAssets';
import {JamMixer} from '@app/features/activities/band/jam/JamInstruments';
import {decodeJamMessage, type JamMessage} from '@app/features/activities/band/jam/JamMessages';
import {type JamAction, type JamClock, JamPlayer} from '@app/features/activities/band/jam/JamPlayer';
import {
	type JamKey,
	type JamMelodicInstrument,
	type JamNoteRange,
	type JamScale,
	laneNotes,
	pinchHarmonicFor,
	playableRange,
} from '@app/features/activities/band/jam/JamScales';
import type {BendSemitones} from '@app/features/activities/band/jam/JamTechniques';
import {soloKeyFor} from '@app/features/activities/band/jam/SoloKey';
import {Logger} from '@app/features/platform/utils/AppLogger';

const logger = new Logger('FreestyleAudio');

// Two neighbouring keys pressed this close together are one gesture: a pinch harmonic on the higher note.
export const PINCH_CHORD_MS = 60;

export function freestyleInstrument(part: InstrumentPart): JamMelodicInstrument {
	return part === 'keys' ? 'keys' : 'guitar';
}

export interface SoloLayout {
	readonly key: JamKey;
	readonly scale: JamScale;
	// MIDI note of each lane, low to high.
	readonly notes: ReadonlyArray<number>;
	// The lead guitar squeals; the keys have no pinch.
	readonly pinch: boolean;
}

export interface FreestyleSeat {
	readonly userId: string;
	readonly part: InstrumentPart;
	readonly sections: ReadonlyArray<SoloSection>;
}

interface HeldLane {
	readonly note: number;
	readonly pressedAt: number;
}

// My keys during a solo, as jam actions: a lane plays its scale note and holds it (sustain, then feedback), two
// neighbouring lanes together pinch, and the bend key bends whatever rings. `timeStamp` is the input event's.
export class FreestyleKeys {
	private readonly held = new Map<number, HeldLane>();
	private bending = false;

	constructor(private readonly play: (action: JamAction, timeStamp: number) => void) {}

	press(lane: number, layout: SoloLayout, timeStamp: number): void {
		const note = layout.notes[lane];
		if (note === undefined || this.held.has(lane)) return;
		const neighbour = [lane - 1, lane + 1].find((other) => {
			const held = this.held.get(other);
			return held !== undefined && timeStamp - held.pressedAt <= PINCH_CHORD_MS;
		});
		const neighbourHeld = neighbour === undefined ? undefined : this.held.get(neighbour);
		if (layout.pinch && neighbour !== undefined && neighbourHeld) {
			const pinched = layout.notes[Math.max(lane, neighbour)];
			const harmonic = pinchHarmonicFor(pinched, layout.key, layout.scale);
			if (neighbourHeld.note !== pinched) this.play({kind: 'noteOff', note: neighbourHeld.note}, timeStamp);
			this.held.set(lane, {note: pinched, pressedAt: timeStamp});
			this.held.set(neighbour, {note: pinched, pressedAt: timeStamp});
			this.play({kind: 'noteOn', note: pinched, pinchHarmonic: harmonic}, timeStamp);
			return;
		}
		this.held.set(lane, {note, pressedAt: timeStamp});
		this.play({kind: 'noteOn', note}, timeStamp);
	}

	release(lane: number, timeStamp: number): void {
		const held = this.held.get(lane);
		if (!held) return;
		this.held.delete(lane);
		for (const other of this.held.values()) if (other.note === held.note) return;
		this.play({kind: 'noteOff', note: held.note}, timeStamp);
	}

	bend(down: boolean, semitones: BendSemitones, timeStamp: number): void {
		if (down === this.bending) return;
		this.bending = down;
		this.play(down ? {kind: 'bendOn', semitones} : {kind: 'bendOff'}, timeStamp);
	}

	releaseAll(timeStamp: number): void {
		for (const lane of [...this.held.keys()]) this.release(lane, timeStamp);
		this.bend(false, 2, timeStamp);
	}
}

export interface FreestyleAudioOptions {
	readonly player: JamPlayer;
	// Sample ranges of the lead guitar and the keys.
	readonly ranges: Readonly<Record<'guitar' | 'keys', JamNoteRange>>;
	readonly songKey: BandSongKey | null;
	readonly seats: ReadonlyArray<FreestyleSeat>;
	readonly myUserId: string;
	// Owned here when given: disposed with the freestyle.
	readonly mixer?: JamMixer;
}

export class FreestyleAudio {
	private readonly keys: FreestyleKeys;
	private readonly mine: FreestyleSeat | null;
	private readonly layouts = new Map<JamMelodicInstrument, Map<SoloSection, SoloLayout>>();

	constructor(private readonly options: FreestyleAudioOptions) {
		const {player, seats, myUserId} = options;
		this.mine = seats.find((seat) => seat.userId === myUserId) ?? null;
		if (this.mine) player.setLocalInstrument(freestyleInstrument(this.mine.part));
		for (const seat of seats) {
			if (seat !== this.mine) player.setRemoteInstrument(seat.userId, freestyleInstrument(seat.part));
		}
		this.keys = new FreestyleKeys((action, timeStamp) => player.play(action, timeStamp));
	}

	// The jam samples once per AudioContext (they stay decoded across songs), a mixer tuned to the recording on the
	// song's output, and one instrument per freestyle seat.
	static async load(
		audio: BandAudio,
		clock: JamClock,
		send: (message: JamMessage) => void,
		params: Omit<FreestyleAudioOptions, 'player' | 'ranges' | 'mixer'>,
	): Promise<FreestyleAudio> {
		const bank = await sharedJamSamples(audio.context);
		const mixer = new JamMixer(audio.context, bank, audio.output, {tuningCents: params.songKey?.tuningCents ?? 0});
		const player = new JamPlayer(mixer, clock, {send});
		const ranges = {
			guitar: playableRange(sampleKeys(bank, 'gitar_di')),
			keys: playableRange(sampleKeys(bank, 'klavye')),
		};
		return new FreestyleAudio({...params, player, ranges, mixer});
	}

	layout(seat: FreestyleSeat, section: SoloSection): SoloLayout {
		const instrument = freestyleInstrument(seat.part);
		let bySection = this.layouts.get(instrument);
		if (!bySection) {
			bySection = new Map();
			this.layouts.set(instrument, bySection);
		}
		let layout = bySection.get(section);
		if (!layout) {
			const {key, scale} = soloKeyFor(this.options.songKey, section.startMs, section.endMs);
			const range = this.options.ranges[instrument === 'keys' ? 'keys' : 'guitar'];
			layout = {
				key,
				scale,
				notes: laneNotes(instrument, {key, scale, octave: 0}, range),
				pinch: instrument === 'guitar',
			};
			bySection.set(section, layout);
		}
		return layout;
	}

	// Presses outside my solo sections are the judge's.
	press(lane: number, songMs: number, timeStamp: number): void {
		const section = this.mine ? soloSectionAt(this.mine.sections, songMs) : null;
		if (this.mine && section) this.keys.press(lane, this.layout(this.mine, section), timeStamp);
	}

	release(lane: number, timeStamp: number): void {
		this.keys.release(lane, timeStamp);
	}

	bend(down: boolean, semitones: BendSemitones, timeStamp: number): void {
		this.keys.bend(down, semitones, timeStamp);
	}

	// A solo section is over: nothing I hold keeps ringing into the record.
	releaseAll(timeStamp: number): void {
		this.keys.releaseAll(timeStamp);
	}

	// Plays another freestyle player's jam message and returns the lanes their note-ons were on, so their highway
	// can light them; empty for anyone not playing freestyle.
	receive(userId: string, payload: unknown, songMs: number, sessionNowMs: number): ReadonlyArray<number> {
		const seat = this.options.seats.find((candidate) => candidate.userId === userId);
		if (!seat || seat === this.mine) return [];
		this.options.player.receive(userId, payload);
		const section = soloSectionAt(seat.sections, songMs);
		const events = section ? decodeJamMessage(payload, sessionNowMs) : null;
		if (!section || !events) return [];
		const {notes} = this.layout(seat, section);
		return events.flatMap((event) => {
			const lane = event.kind === 'noteOn' ? notes.indexOf(event.note) : -1;
			return lane >= 0 ? [lane] : [];
		});
	}

	dispose(): void {
		this.options.player.dispose();
		this.options.mixer?.dispose();
	}
}

const samplesByContext = new WeakMap<BaseAudioContext, Promise<JamSampleBank>>();

function sharedJamSamples(context: BaseAudioContext): Promise<JamSampleBank> {
	let samples = samplesByContext.get(context);
	if (!samples) {
		samples = loadJamSamples(context);
		samplesByContext.set(context, samples);
		samples.catch((error: unknown) => {
			logger.warn('Freestyle samples could not be loaded', {error});
			samplesByContext.delete(context);
		});
	}
	return samples;
}

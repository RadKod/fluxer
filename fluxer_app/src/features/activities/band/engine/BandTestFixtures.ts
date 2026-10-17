// SPDX-License-Identifier: AGPL-3.0-or-later

// Synthetic chart builders for the band engine tests; nothing here ships in the app bundle.

import type {
	BandDifficulty,
	InstrumentPart,
	NoteGroup,
	PartChart,
} from '@app/features/activities/band/engine/ChartModel';
import type {SongFile} from '@app/features/activities/band/engine/SngFile';
import {type MidiEvent, writeMidi} from 'midi-file';

export const TEST_RESOLUTION = 480;

export interface MidiNoteSpec {
	readonly tick: number;
	readonly note: number;
	readonly length?: number;
	readonly velocity?: number;
}

export interface MidiTextSpec {
	readonly tick: number;
	readonly text: string;
	readonly kind?: 'lyrics' | 'text';
}

export interface MidiTrackSpec {
	readonly name: string;
	readonly notes?: ReadonlyArray<MidiNoteSpec>;
	readonly texts?: ReadonlyArray<MidiTextSpec>;
}

export interface MidiSongSpec {
	readonly resolution?: number;
	readonly tempos?: ReadonlyArray<{tick: number; bpm: number}>;
	readonly timeSignatures?: ReadonlyArray<{tick: number; numerator: number; denominator: number}>;
	readonly tracks: ReadonlyArray<MidiTrackSpec>;
}

type UntimedMidiEvent = MidiEvent extends infer Event
	? Event extends MidiEvent
		? Omit<Event, 'deltaTime'>
		: never
	: never;
type TimedEvent = {tick: number; order: number; event: UntimedMidiEvent};

function toTrack(events: Array<TimedEvent>): Array<MidiEvent> {
	events.sort((a, b) => a.tick - b.tick || a.order - b.order);
	let previous = 0;
	const track = events.map(({tick, event}) => {
		const deltaTime = tick - previous;
		previous = tick;
		return {...event, deltaTime} as MidiEvent;
	});
	track.push({deltaTime: 0, meta: true, type: 'endOfTrack'});
	return track;
}

export function buildMidi(spec: MidiSongSpec): Uint8Array {
	const tempoEvents: Array<TimedEvent> = [{tick: 0, order: 0, event: {meta: true, type: 'trackName', text: 'tempo'}}];
	for (const {tick, bpm} of spec.tempos ?? [{tick: 0, bpm: 120}]) {
		tempoEvents.push({
			tick,
			order: 1,
			event: {meta: true, type: 'setTempo', microsecondsPerBeat: Math.round(60e6 / bpm)},
		});
	}
	for (const {tick, numerator, denominator} of spec.timeSignatures ?? [{tick: 0, numerator: 4, denominator: 4}]) {
		tempoEvents.push({
			tick,
			order: 1,
			event: {meta: true, type: 'timeSignature', numerator, denominator, metronome: 24, thirtyseconds: 8},
		});
	}

	const tracks = [toTrack(tempoEvents)];
	for (const trackSpec of spec.tracks) {
		const events: Array<TimedEvent> = [
			{tick: 0, order: 0, event: {meta: true, type: 'trackName', text: trackSpec.name}},
		];
		for (const {tick, text, kind} of trackSpec.texts ?? []) {
			events.push({tick, order: 1, event: {meta: true, type: kind ?? 'text', text}});
		}
		for (const {tick, note, length = 60, velocity = 100} of trackSpec.notes ?? []) {
			// Note-offs sort before note-ons on the same tick so back-to-back notes do not swallow each other.
			events.push({tick, order: 3, event: {type: 'noteOn', channel: 0, noteNumber: note, velocity}});
			events.push({tick: tick + length, order: 2, event: {type: 'noteOff', channel: 0, noteNumber: note, velocity: 0}});
		}
		tracks.push(toTrack(events));
	}

	return Uint8Array.from(
		writeMidi({
			header: {format: 1, numTracks: tracks.length, ticksPerBeat: spec.resolution ?? TEST_RESOLUTION},
			tracks,
		}),
	);
}

// Expert gem for lane N in notes.mid is 96 + N (frets: green..orange; drums: kick, red, yellow, blue, green).
// Hard, Medium and Easy start at 84, 72 and 60. Star power is 116, solo 103, tom markers 110..112.
export const EXPERT_NOTE_BASE = 96;

export function buildSng(
	metadata: Record<string, string>,
	files: ReadonlyArray<SongFile>,
	xorMask?: Uint8Array,
): Uint8Array {
	const encoder = new TextEncoder();
	const mask = xorMask ?? Uint8Array.from({length: 16}, (_, i) => (i * 37 + 11) & 0xff);
	const u32 = (value: number) => {
		const bytes = new Uint8Array(4);
		new DataView(bytes.buffer).setUint32(0, value, true);
		return bytes;
	};
	const u64 = (value: number) => {
		const bytes = new Uint8Array(8);
		new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
		return bytes;
	};
	const concat = (parts: ReadonlyArray<Uint8Array>) => {
		const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
		let offset = 0;
		for (const part of parts) {
			out.set(part, offset);
			offset += part.length;
		}
		return out;
	};

	const metadataParts: Array<Uint8Array> = [];
	for (const [key, value] of Object.entries(metadata)) {
		const keyBytes = encoder.encode(key);
		const valueBytes = encoder.encode(value);
		metadataParts.push(u32(keyBytes.length), keyBytes, u32(valueBytes.length), valueBytes);
	}
	const metadataSection = concat([u64(Object.keys(metadata).length), ...metadataParts]);

	const nameBytes = files.map((file) => encoder.encode(file.fileName));
	const fileMetaLength = 8 + nameBytes.reduce((sum, name) => sum + 1 + name.length + 16, 0);
	const headerLength = 6 + 4 + 16 + 8 + metadataSection.length + 8 + fileMetaLength + 8;
	let dataOffset = headerLength;
	const fileMetaParts: Array<Uint8Array> = [u64(files.length)];
	files.forEach((file, i) => {
		fileMetaParts.push(Uint8Array.of(nameBytes[i].length), nameBytes[i], u64(file.data.length), u64(dataOffset));
		dataOffset += file.data.length;
	});
	const fileMetaSection = concat(fileMetaParts);

	const masked = files.map((file) => file.data.map((byte, i) => byte ^ mask[i & 0x0f] ^ (i & 0xff)));
	return concat([
		encoder.encode('SNGPKG'),
		u32(1),
		mask,
		u64(metadataSection.length),
		metadataSection,
		u64(fileMetaSection.length),
		fileMetaSection,
		u64(masked.reduce((sum, data) => sum + data.length, 0)),
		...masked,
	]);
}

export function noteGroup(msTime: number, lanes: ReadonlyArray<number>, overrides: Partial<NoteGroup> = {}): NoteGroup {
	return {
		tick: msTime,
		msTime,
		msLength: 0,
		lanes,
		cymbals: [],
		isHopo: false,
		isTap: false,
		inStarPower: false,
		inSolo: false,
		...overrides,
	};
}

export function partChart(
	groups: ReadonlyArray<NoteGroup>,
	part: InstrumentPart = 'guitar',
	difficulty: BandDifficulty = 'expert',
	overrides: Partial<PartChart> = {},
): PartChart {
	return {
		part,
		difficulty,
		derived: false,
		groups,
		starPower: [],
		solos: [],
		durationMs: groups.reduce((end, group) => Math.max(end, group.msTime + group.msLength), 0),
		...overrides,
	};
}

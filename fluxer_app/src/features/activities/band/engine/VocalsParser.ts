// SPDX-License-Identifier: AGPL-3.0-or-later

import type {TimeSpan} from '@app/features/activities/band/engine/ChartModel';
import type {TempoMap} from '@app/features/activities/band/engine/TempoMap';
import {type MidiEvent, parseMidi} from 'midi-file';

export const VOCAL_PITCH_MIN = 36;
export const VOCAL_PITCH_MAX = 84;
const PHRASE_NOTES = new Set([105, 106]);
const STAR_POWER_NOTE = 116;
const VOCALS_TRACK_NAME = 'PART VOCALS';

export interface VocalNote {
	readonly tick: number;
	readonly msTime: number;
	readonly msLength: number;
	// MIDI pitch 36..84; null for spoken (unpitched) notes.
	readonly pitch: number | null;
	// Display text with Rock Band markers removed; empty for pitch slides.
	readonly lyric: string;
	// The next syllable continues this word (no space between them).
	readonly joinsNext: boolean;
	// A "+" note: the previous syllable slides to this pitch.
	readonly isSlide: boolean;
	readonly isSpoken: boolean;
	// Index into VocalsChart.phrases, or -1 for notes outside any phrase.
	readonly phraseIndex: number;
}

export interface VocalsChart {
	readonly notes: ReadonlyArray<VocalNote>;
	readonly phrases: ReadonlyArray<TimeSpan>;
	readonly starPower: ReadonlyArray<TimeSpan>;
	readonly durationMs: number;
}

interface ParsedLyric {
	readonly text: string;
	readonly joinsNext: boolean;
	readonly isSlide: boolean;
	readonly isSpoken: boolean;
}

// Rock Band / Clone Hero lyric markers: "#" and "^" unpitched, "-" joins the next syllable, "=" joins with a
// visible hyphen, "+" alone is a slide, "$" hidden, "%" range shift, "/" line break, "_" and "§" spaces.
export function parseLyric(raw: string): ParsedLyric {
	let text = raw.trim();
	if (text === '+') return {text: '', joinsNext: false, isSlide: true, isSpoken: false};

	let isSpoken = false;
	let joinsNext = false;
	for (;;) {
		const last = text.at(-1);
		if (last === '#' || last === '^') {
			isSpoken = true;
		} else if (last === '-') {
			joinsNext = true;
		} else if (last === '=') {
			joinsNext = true;
			text = `${text.slice(0, -1)}-`;
			break;
		} else if (last === '$' || last === '%' || last === '/') {
			// Display-only markers; drop them.
		} else {
			break;
		}
		text = text.slice(0, -1);
	}
	text = text.replace(/^\$/, '').replace(/[_§]/g, ' ').trim();
	return {text, joinsNext, isSlide: false, isSpoken};
}

// midi-file reads text bytes as Latin-1; most charts store UTF-8.
function decodeMidiText(text: string): string {
	const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
	try {
		return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
	} catch {
		return text;
	}
}

function absoluteEvents(track: ReadonlyArray<MidiEvent>): Array<{tick: number; event: MidiEvent}> {
	let tick = 0;
	return track.map((event) => {
		tick += event.deltaTime;
		return {tick, event};
	});
}

function collectSpans(
	events: ReadonlyArray<{tick: number; event: MidiEvent}>,
	noteNumbers: ReadonlySet<number>,
	tempoMap: TempoMap,
): Array<TimeSpan> {
	const openStarts = new Map<number, number>();
	const spans: Array<TimeSpan> = [];
	for (const {tick, event} of events) {
		if (event.type !== 'noteOn' && event.type !== 'noteOff') continue;
		if (!noteNumbers.has(event.noteNumber)) continue;
		if (event.type === 'noteOn') {
			if (!openStarts.has(event.noteNumber)) openStarts.set(event.noteNumber, tick);
			continue;
		}
		const start = openStarts.get(event.noteNumber);
		if (start === undefined) continue;
		openStarts.delete(event.noteNumber);
		spans.push(timedSpan(start, tick, tempoMap));
	}
	return mergeSpans(spans, tempoMap);
}

function timedSpan(startTick: number, endTick: number, tempoMap: TempoMap): TimeSpan {
	const msTime = tempoMap.tickToMs(startTick);
	return {tick: startTick, length: endTick - startTick, msTime, msLength: tempoMap.tickToMs(endTick) - msTime};
}

// Player-one (105) and player-two (106) phrase markers usually duplicate each other; overlapping spans become one.
function mergeSpans(spans: Array<TimeSpan>, tempoMap: TempoMap): Array<TimeSpan> {
	spans.sort((a, b) => a.tick - b.tick || b.length - a.length);
	const merged: Array<TimeSpan> = [];
	for (const span of spans) {
		const previous = merged[merged.length - 1];
		if (previous && span.tick < previous.tick + previous.length) {
			const end = Math.max(previous.tick + previous.length, span.tick + span.length);
			merged[merged.length - 1] = timedSpan(previous.tick, end, tempoMap);
		} else {
			merged.push(span);
		}
	}
	return merged;
}

function phraseIndexAt(phrases: ReadonlyArray<TimeSpan>, tick: number): number {
	return phrases.findIndex((phrase) => tick >= phrase.tick && tick < phrase.tick + phrase.length);
}

// Reads PART VOCALS from notes.mid; returns null when the chart has no pitched or spoken vocal notes.
export function parseVocalsFromMidi(data: Uint8Array, tempoMap: TempoMap): VocalsChart | null {
	const midi = parseMidi(data);
	const track = midi.tracks.find((events) =>
		events.some((event) => event.type === 'trackName' && event.text.trim() === VOCALS_TRACK_NAME),
	);
	if (!track) return null;
	const events = absoluteEvents(track);

	const lyricsByTick = new Map<number, string>();
	for (const {tick, event} of events) {
		const isLyric = event.type === 'lyrics' || (event.type === 'text' && !event.text.trim().startsWith('['));
		if (isLyric && 'text' in event && !lyricsByTick.has(tick)) lyricsByTick.set(tick, decodeMidiText(event.text));
	}

	const phrases = collectSpans(events, PHRASE_NOTES, tempoMap);
	const starPower = collectSpans(events, new Set([STAR_POWER_NOTE]), tempoMap);

	const openNotes = new Map<number, number>();
	const rawNotes: Array<{tick: number; endTick: number; pitch: number}> = [];
	for (const {tick, event} of events) {
		if (event.type !== 'noteOn' && event.type !== 'noteOff') continue;
		if (event.noteNumber < VOCAL_PITCH_MIN || event.noteNumber > VOCAL_PITCH_MAX) continue;
		if (event.type === 'noteOn') {
			// A new note-on on a sounding pitch closes the previous one, like most MIDI readers do.
			const sounding = openNotes.get(event.noteNumber);
			if (sounding !== undefined) rawNotes.push({tick: sounding, endTick: tick, pitch: event.noteNumber});
			openNotes.set(event.noteNumber, tick);
			continue;
		}
		const start = openNotes.get(event.noteNumber);
		if (start === undefined) continue;
		openNotes.delete(event.noteNumber);
		rawNotes.push({tick: start, endTick: tick, pitch: event.noteNumber});
	}
	if (rawNotes.length === 0) return null;
	rawNotes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);

	const notes: Array<VocalNote> = rawNotes.map(({tick, endTick, pitch}) => {
		const lyric = parseLyric(lyricsByTick.get(tick) ?? '');
		const msTime = tempoMap.tickToMs(tick);
		return {
			tick,
			msTime,
			msLength: tempoMap.tickToMs(endTick) - msTime,
			pitch: lyric.isSpoken ? null : pitch,
			lyric: lyric.text,
			joinsNext: lyric.joinsNext,
			isSlide: lyric.isSlide,
			isSpoken: lyric.isSpoken,
			phraseIndex: phraseIndexAt(phrases, tick),
		};
	});

	const durationMs = notes.reduce((end, note) => Math.max(end, note.msTime + note.msLength), 0);
	return {notes, phrases, starPower, durationMs};
}

// Display text of one phrase, joining syllables per their markers.
export function phraseLyrics(notes: ReadonlyArray<VocalNote>): string {
	let text = '';
	let glue = '';
	for (const note of notes) {
		if (note.isSlide || note.lyric === '') continue;
		text += glue + note.lyric;
		glue = note.joinsNext ? '' : ' ';
	}
	return text;
}

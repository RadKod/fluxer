// SPDX-License-Identifier: MIT
// NOTICE: vendored from scan-chart 8.0.1 (src/chart/midi-parser.ts), Copyright (c) Geo. See ./LICENSE.
// Local changes: lodash replaced with native code, explicit default returns, imports and formatting adapted.

import {
	type Difficulty,
	difficulties,
	getInstrumentType,
	type Instrument,
	type InstrumentType,
	instrumentTypes,
} from '@app/features/activities/band/engine/vendor/scan-chart/interfaces';
import {
	type EventType,
	eventTypes,
	type IniChartModifiers,
	type RawChartData,
} from '@app/features/activities/band/engine/vendor/scan-chart/note-parsing-interfaces';
import {
	type MidiData,
	type MidiEvent,
	type MidiSetTempoEvent,
	type MidiTextEvent,
	type MidiTimeSignatureEvent,
	parseMidi,
} from 'midi-file';

type TrackName = (typeof trackNames)[number];
type InstrumentTrackName = Exclude<TrackName, 'PART VOCALS' | 'EVENTS'>;
const trackNames = [
	'T1 GEMS',
	'PART GUITAR',
	'PART GUITAR COOP',
	'PART RHYTHM',
	'PART BASS',
	'PART DRUMS',
	'PART KEYS',
	'PART GUITAR GHL',
	'PART GUITAR COOP GHL',
	'PART RHYTHM GHL',
	'PART BASS GHL',
	'PART VOCALS',
	'EVENTS',
] as const;
/* eslint-disable @typescript-eslint/naming-convention */
const instrumentNameMap: {[key in InstrumentTrackName]: Instrument} = {
	'T1 GEMS': 'guitar',
	'PART GUITAR': 'guitar',
	'PART GUITAR COOP': 'guitarcoop',
	'PART RHYTHM': 'rhythm',
	'PART BASS': 'bass',
	'PART DRUMS': 'drums',
	'PART KEYS': 'keys',
	'PART GUITAR GHL': 'guitarghl',
	'PART GUITAR COOP GHL': 'guitarcoopghl',
	'PART RHYTHM GHL': 'rhythmghl',
	'PART BASS GHL': 'bassghl',
} as const;
/* eslint-enable @typescript-eslint/naming-convention */

const sysExDifficultyMap = ['easy', 'medium', 'hard', 'expert'] as const;
const discoFlipDifficultyMap = ['easy', 'medium', 'hard', 'expert'] as const;
const fiveFretDiffStarts = {easy: 59, medium: 71, hard: 83, expert: 95};
const sixFretDiffStarts = {easy: 58, medium: 70, hard: 82, expert: 94};
const drumsDiffStarts = {easy: 60, medium: 72, hard: 84, expert: 96};

interface TrackEventEnd {
	tick: number;
	type: EventType;
	// Necessary because .mid stores some additional modifiers and information using velocity
	velocity: number;
	channel: number;
	// Necessary because .mid stores track events as separate start and end events
	isStart: boolean;
}

// Necessary because .mid stores some additional modifiers and information using velocity
type MidiTrackEvent = RawChartData['trackData'][number]['trackEvents'][number] & {velocity: number; channel: number};

/**
 * Parses `buffer` as a chart in the .mid format. Returns all the note data in `RawChartData`, but any
 * chart format rules that apply to both .chart and .mid have not been applied. This is a partial result
 * that can be produced by both the .chart and .mid formats so that the remaining chart rules can be parsed
 * without code duplication.
 *
 * Throws an exception if `buffer` could not be parsed as a chart in the .mid format.
 *
 * Note: these features of .mid are ignored (for now)
 * Versus phrase markers
 * Trill lanes
 * Tremolo lanes
 * [PART DRUMS_2X] (RBN)
 * Real Drums (Phase Shift)
 */
export function parseNotesFromMidi(data: Uint8Array, iniChartModifiers: IniChartModifiers): RawChartData {
	const midiFile = parseMidi(data);
	if (midiFile.header.format !== 1) {
		throw `Invavlid .mid file: unsupported header format "${midiFile.header.format}"`;
	}

	if (!midiFile.header.ticksPerBeat) {
		throw 'Invalid .mid file: resolution in ticks per SMPTE frame is not supported';
	}

	if (midiFile.tracks.length === 0) {
		throw 'Invalid .mid file: no tracks detected';
	}

	// Sets event.deltaTime to the number of ticks since the start of the track
	convertToAbsoluteTime(midiFile);

	const tracks = getTracks(midiFile);

	const vocalsTrack = tracks.find((t) => t.trackName === 'PART VOCALS');
	const eventsTrackEvents = tracks.find((t) => t.trackName === 'EVENTS')?.trackEvents ?? [];
	const codaEvents = eventsTrackEvents.filter(
		(e) => e.type === 'text' && (e.text.trim() === 'coda' || e.text.trim() === '[coda]'),
	);
	const firstCodaTick = codaEvents[0] ? codaEvents[0].deltaTime : null;

	return {
		chartTicksPerBeat: midiFile.header.ticksPerBeat,
		metadata: {}, // .mid does not have a mechanism for storing song metadata
		hasLyrics: !!vocalsTrack?.trackEvents.find((e) => e.type === 'lyrics' || e.type === 'text'),
		hasVocals: !!vocalsTrack?.trackEvents.find((e) => e.type === 'noteOn' && e.noteNumber <= 84 && e.noteNumber >= 36),
		tempos: tap(
			midiFile.tracks[0]
				.filter((e): e is MidiSetTempoEvent => e.type === 'setTempo')
				.map((e) => ({
					tick: e.deltaTime,
					// Note that this operation is float64 division, and is impacted by floating point precision errors
					beatsPerMinute: 60000000 / e.microsecondsPerBeat,
				})),
			(tempos) => {
				const zeroTempo = tempos.find((tempo) => tempo.beatsPerMinute === 0);
				if (zeroTempo) {
					throw `Invalid .mid file: Tempo at tick ${zeroTempo.tick} was zero.`;
				}
				if (tempos[0]?.tick !== 0) {
					tempos.unshift({tick: 0, beatsPerMinute: 120});
				}
			},
		),
		timeSignatures: tap(
			midiFile.tracks[0]
				.filter((e): e is MidiTimeSignatureEvent => e.type === 'timeSignature')
				.map((e) => ({
					tick: e.deltaTime,
					numerator: e.numerator,
					denominator: e.denominator,
				})),
			(timeSignatures) => {
				const zeroTimeSignatureN = timeSignatures.find((timeSignature) => timeSignature.numerator === 0);
				const zeroTimeSignatureD = timeSignatures.find((timeSignature) => timeSignature.denominator === 0);
				if (zeroTimeSignatureN) {
					throw `Invalid .mid file: Time signature numerator at tick ${zeroTimeSignatureN.tick} was zero.`;
				}
				if (zeroTimeSignatureD) {
					throw `Invalid .mid file: Time signature denominator at tick ${zeroTimeSignatureD.tick} was zero.`;
				}
				if (timeSignatures[0]?.tick !== 0) {
					timeSignatures.unshift({tick: 0, numerator: 4, denominator: 4});
				}
			},
		),
		sections: eventsTrackEvents
			.filter((e): e is MidiTextEvent => e.type === 'text' && /^\[?(?:section|prc)[ _]([^\]]*)\]?$/.test(e.text))
			.map((e) => ({
				tick: e.deltaTime,
				name: e.text.match(/^\[?(?:section|prc)[ _]([^\]]*)\]?$/)![1],
			})),
		endEvents: eventsTrackEvents
			.filter((e): e is MidiTextEvent => e.type === 'text' && /^\[?end\]?$/.test(e.text))
			.map((e) => ({
				tick: e.deltaTime,
			})),
		trackData: tracks
			.filter((t) => Object.keys(instrumentNameMap).includes(t.trackName))
			.flatMap((t) => {
				const instrument = instrumentNameMap[t.trackName as InstrumentTrackName];
				const instrumentType = getInstrumentType(instrument);
				const eventEnds = distributeInstrumentEvents(getTrackEventEnds(t.trackEvents, instrumentType)); // Removes 'all' difficulty
				const connectedEvents = getTrackEvents(eventEnds); // Connects note ends together
				const trackDifficulties = fixFlexLaneLds(
					fixLegacyGhStarPower(
						splitMidiModifierSustains(connectedEvents, instrumentType),
						instrumentType,
						iniChartModifiers,
					),
				);

				return difficulties.map((difficulty) => {
					const result: RawChartData['trackData'][number] = {
						instrument,
						difficulty,
						starPowerSections: [],
						rejectedStarPowerSections: [],
						soloSections: [],
						flexLanes: [],
						drumFreestyleSections: [],
						trackEvents: [],
					};

					for (const event of trackDifficulties[difficulty]) {
						if (event.type === eventTypes.starPower) {
							result.starPowerSections.push(event);
						} else if (event.type === eventTypes.rejectedStarPower) {
							result.rejectedStarPowerSections.push(event);
						} else if (event.type === eventTypes.soloSection) {
							result.soloSections.push(event);
						} else if (event.type === eventTypes.flexLaneSingle || event.type === eventTypes.flexLaneDouble) {
							result.flexLanes.push({
								tick: event.tick,
								length: event.length,
								isDouble: event.type === eventTypes.flexLaneDouble,
							});
						} else if (event.type === eventTypes.freestyleSection) {
							result.drumFreestyleSections.push({
								tick: event.tick,
								length: event.length,
								isCoda: firstCodaTick === null ? false : event.tick >= firstCodaTick,
							});
						} else {
							result.trackEvents.push(event);
						}
					}

					return result;
				});
			})
			.filter((track) => track.trackEvents.length > 0),
	};
}

function tap<T>(value: T, interceptor: (value: T) => void): T {
	interceptor(value);
	return value;
}

/** Removes every element matching `predicate` from `array` in place. */
function removeWhere<T>(array: Array<T>, predicate: (element: T) => boolean) {
	let writeIndex = 0;
	for (const element of array) {
		if (!predicate(element)) {
			array[writeIndex++] = element;
		}
	}
	array.length = writeIndex;
}

function convertToAbsoluteTime(midiData: MidiData) {
	for (const track of midiData.tracks) {
		let currentTick = 0;
		for (const event of track) {
			currentTick += event.deltaTime;
			event.deltaTime = currentTick;
		}
	}
}

function getTracks(midiData: MidiData) {
	const tracks: Array<{trackName: TrackName; trackEvents: Array<MidiEvent>}> = [];

	for (const track of midiData.tracks) {
		let trackName: string | null = null;
		for (const event of track) {
			if (event.deltaTime !== 0) {
				break;
			}
			if (event.type === 'trackName' && trackNames.includes(event.text as TrackName)) {
				trackName = event.text;
			}
		}

		if (trackName !== null) {
			tracks.push({
				trackName: trackName as TrackName,
				trackEvents: track,
			});
		}
	}

	return tracks;
}

/** Gets the starting and ending notes for all midi events defined for the .mid chart spec. */
function getTrackEventEnds(events: Array<MidiEvent>, instrumentType: InstrumentType) {
	let enhancedOpens = false;
	const trackEventEnds: {[difficulty in Difficulty | 'all']: Array<TrackEventEnd>} = {
		all: [],
		expert: [],
		hard: [],
		medium: [],
		easy: [],
	};

	for (const event of events) {
		// SysEx event (tap modifier or open)
		if ((event.type === 'sysEx' || event.type === 'endSysEx') && event.data.length > 6) {
			if (event.data[0] === 0x50 && event.data[1] === 0x53 && event.data[2] === 0x00 && event.data[3] === 0x00) {
				// Phase Shift SysEx event
				const type =
					event.data[5] === 0x01 ? eventTypes.forceOpen : event.data[5] === 0x04 ? eventTypes.forceTap : null;

				if (type !== null) {
					trackEventEnds[event.data[4] === 0xff ? 'all' : discoFlipDifficultyMap[event.data[4]]].push({
						tick: event.deltaTime,
						type,
						channel: 1,
						velocity: 127,
						isStart: event.data[6] === 0x01,
					});
				}
			}
		} else if (event.type === 'noteOn' || event.type === 'noteOff') {
			const difficulty =
				event.noteNumber <= 66
					? 'easy'
					: event.noteNumber <= 78
						? 'medium'
						: event.noteNumber <= 90
							? 'hard'
							: event.noteNumber <= 102
								? 'expert'
								: 'all';
			if (difficulty === 'all') {
				// Instrument-wide event (solo marker, star power, etc...) (applies to all difficulties)
				const type = getInstrumentEventType(event.noteNumber);
				if (type !== null) {
					trackEventEnds[difficulty].push({
						tick: event.deltaTime,
						type,
						velocity: event.velocity,
						channel: event.channel,
						isStart: event.type === 'noteOn',
					});
				}
			} else {
				const type =
					(instrumentType === instrumentTypes.sixFret
						? get6FretNoteType(event.noteNumber, difficulty)
						: instrumentType === instrumentTypes.drums
							? getDrumsNoteType(event.noteNumber, difficulty)
							: get5FretNoteType(event.noteNumber, difficulty, enhancedOpens)) ?? null;
				if (type !== null) {
					trackEventEnds[difficulty].push({
						tick: event.deltaTime,
						type,
						velocity: event.velocity,
						channel: event.channel,
						isStart: event.type === 'noteOn',
					});
				}
			}
		} else if (event.type === 'text') {
			if (instrumentType === instrumentTypes.drums) {
				const discoFlipMatch = event.text.match(
					/^\s*\[?mix[ _]([0-3])[ _]drums([0-5])(d|dnoflip|easy|easynokick|)\]?\s*$/,
				);
				if (discoFlipMatch) {
					const difficulty = sysExDifficultyMap[Number(discoFlipMatch[1])];
					const flag = discoFlipMatch[3] as 'd' | 'dnoflip' | 'easy' | 'easynokick' | '';
					const eventType =
						flag === ''
							? eventTypes.discoFlipOff
							: flag === 'd'
								? eventTypes.discoFlipOn
								: flag === 'dnoflip'
									? eventTypes.discoNoFlipOn
									: null;
					if (eventType) {
						// Treat this like the other events that have a start and end, so it can be processed the same way later
						trackEventEnds[difficulty].push({
							tick: event.deltaTime,
							type: eventType,
							velocity: 127,
							channel: 1,
							isStart: true,
						});
						trackEventEnds[difficulty].push({
							tick: event.deltaTime,
							type: eventType,
							velocity: 127,
							channel: 1,
							isStart: false,
						});
					}
				}
			}

			if (event.text === 'ENHANCED_OPENS' || event.text === '[ENHANCED_OPENS]') {
				enhancedOpens = true;
			} else if (event.text === 'ENABLE_CHART_DYNAMICS' || event.text === '[ENABLE_CHART_DYNAMICS]') {
				// Treat this like the other events that have a start and end, so it can be processed the same way later
				trackEventEnds['all'].push({
					tick: event.deltaTime,
					type: eventTypes.enableChartDynamics,
					channel: 1,
					isStart: true,
					velocity: 127,
				});
				trackEventEnds['all'].push({
					tick: event.deltaTime,
					type: eventTypes.enableChartDynamics,
					channel: 1,
					isStart: false,
					velocity: 127,
				});
			}
		}
	}

	return trackEventEnds;
}

/** These apply to the entire instrument, not specific difficulties. */
function getInstrumentEventType(note: number) {
	switch (note) {
		case 103:
			return eventTypes.soloSection;
		case 104:
			return eventTypes.forceTap;
		case 109:
			return eventTypes.forceFlam;
		case 110:
			return eventTypes.yellowTomMarker;
		case 111:
			return eventTypes.blueTomMarker;
		case 112:
			return eventTypes.greenTomMarker;
		case 116:
			return eventTypes.starPower;
		case 120:
			return eventTypes.freestyleSection;
		// Note: The official spec says all five need to be active to count as a drum fill, but some charts don't do this.
		// Most other popular parsers only check midi note 120 for better compatibility.
		// case 121:
		// 	return eventTypes.freestyleSection2
		// case 122:
		// 	return eventTypes.freestyleSection3
		// case 123:
		// 	return eventTypes.freestyleSection4
		// case 124:
		// 	return eventTypes.freestyleSection5
		case 126:
			return eventTypes.flexLaneSingle;
		case 127:
			return eventTypes.flexLaneDouble;
		default:
			return null;
	}
}

function get6FretNoteType(note: number, difficulty: Difficulty) {
	switch (note - sixFretDiffStarts[difficulty]) {
		case 0:
			return eventTypes.open; // Not forceOpen
		case 1:
			return eventTypes.white1;
		case 2:
			return eventTypes.white2;
		case 3:
			return eventTypes.white3;
		case 4:
			return eventTypes.black1;
		case 5:
			return eventTypes.black2;
		case 6:
			return eventTypes.black3;
		case 7:
			return eventTypes.forceHopo;
		case 8:
			return eventTypes.forceStrum;
		default:
			return null;
	}
}

function get5FretNoteType(note: number, difficulty: Difficulty, enhancedOpens: boolean) {
	switch (note - fiveFretDiffStarts[difficulty]) {
		case 0:
			return enhancedOpens ? eventTypes.open : null; // Not forceOpen
		case 1:
			return eventTypes.green;
		case 2:
			return eventTypes.red;
		case 3:
			return eventTypes.yellow;
		case 4:
			return eventTypes.blue;
		case 5:
			return eventTypes.orange;
		case 6:
			return eventTypes.forceHopo;
		case 7:
			return eventTypes.forceStrum;
		default:
			return null;
	}
}

function getDrumsNoteType(note: number, difficulty: Difficulty) {
	switch (note - drumsDiffStarts[difficulty]) {
		case -1:
			return eventTypes.kick2x;
		case 0:
			return eventTypes.kick;
		case 1:
			return eventTypes.redDrum;
		case 2:
			return eventTypes.yellowDrum;
		case 3:
			return eventTypes.blueDrum;
		case 4:
			return eventTypes.fiveOrangeFourGreenDrum;
		case 5:
			return eventTypes.fiveGreenDrum;
		default:
			return null;
	}
}

/**
 * Any Sysex modifiers with difficulty 0xFF are meant to apply to all charted difficulties.
 * Any instrument events above midi note 102 are meant to apply to all charted difficulties.
 * enableChartDynamics is meant to apply to all charted difficulties.
 * Distributes all of these to each difficulty in the instrument.
 */
function distributeInstrumentEvents(eventEnds: {[difficulty in Difficulty | 'all']: Array<TrackEventEnd>}) {
	for (const instrumentEvent of eventEnds.all) {
		for (const difficulty of difficulties) {
			if (eventEnds[difficulty].length === 0) {
				continue; // Skip adding modifiers to uncharted difficulties
			}
			eventEnds[difficulty].push({...instrumentEvent});
		}
	}

	const byTickThenTypeDescending = (a: TrackEventEnd, b: TrackEventEnd) => a.tick - b.tick || b.type - a.type;
	return {
		expert: [...eventEnds.expert].sort(byTickThenTypeDescending),
		hard: [...eventEnds.hard].sort(byTickThenTypeDescending),
		medium: [...eventEnds.medium].sort(byTickThenTypeDescending),
		easy: [...eventEnds.easy].sort(byTickThenTypeDescending),
	};
}

/**
 * Connects together start and end events to determine event lengths.
 */
function getTrackEvents(trackEventEnds: {[key in Difficulty]: Array<TrackEventEnd>}) {
	const trackEvents: {[key in Difficulty]: Array<MidiTrackEvent>} = {expert: [], hard: [], medium: [], easy: []};

	for (const difficulty of difficulties) {
		const partialTrackEventsMap = Object.fromEntries(Object.values(eventTypes).map((k) => [k, []])) as unknown as {
			[key in EventType]: Array<MidiTrackEvent>;
		};

		for (const trackEventEnd of trackEventEnds[difficulty]) {
			const partialTrackEvents = partialTrackEventsMap[trackEventEnd.type];
			if (trackEventEnd.isStart) {
				const partialTrackEvent: MidiTrackEvent = {
					tick: trackEventEnd.tick,
					length: -1, // Represents that this is a partial track event (an end event has not been found for this yet)
					type: trackEventEnd.type,
					velocity: trackEventEnd.velocity,
					channel: trackEventEnd.channel,
				};
				partialTrackEvents.push(partialTrackEvent);
				trackEvents[difficulty].push(partialTrackEvent);
			} else if (partialTrackEvents.length) {
				let partialTrackEventIndex = partialTrackEvents.length - 1;
				while (
					partialTrackEventIndex >= 0 &&
					partialTrackEvents[partialTrackEventIndex].channel !== trackEventEnd.channel
				) {
					partialTrackEventIndex--; // Find the most recent partial event on the same channel
				}
				if (partialTrackEventIndex >= 0) {
					const partialTrackEvent = partialTrackEvents.splice(partialTrackEventIndex, 1)[0];
					partialTrackEvent.length = trackEventEnd.tick - partialTrackEvent.tick;
				}
			}
		}

		removeWhere(trackEvents[difficulty], (e) => e.length === -1); // Remove all remaining partial events
	}

	return trackEvents;
}

/**
 * These event types are modifier sustains that apply to all notes active during them:
 * - forceOpen
 * - forceTap
 * - forceStrum
 * - forceHopo
 * - forceFlam
 * - yellowTomMarker
 * - blueTomMarker
 * - greenTomMarker
 *
 * Splits these modifiers into zero-length modifier events on each unique note tick under them,
 * to mimic how .chart stores modifier events.
 * (Note: The ending tick of the modifier phrase is excluded)
 *
 * There are more "modifiers" like this, but these are the ones that are midi-specific.
 * Code to handle the remaining modifiers is shared between the .mid and .chart parsers later.
 */
function splitMidiModifierSustains(
	events: {[key in Difficulty]: Array<MidiTrackEvent>},
	instrumentType: InstrumentType,
) {
	let enableChartDynamics = false;
	const t = eventTypes;
	const modifierSustains: Array<EventType> =
		instrumentType === instrumentTypes.drums
			? [t.forceFlam, t.yellowTomMarker, t.blueTomMarker, t.greenTomMarker]
			: [t.forceOpen, t.forceTap, t.forceStrum, t.forceHopo];
	const modifiableNotes: Array<EventType> =
		instrumentType === instrumentTypes.fiveFret
			? [t.open, t.green, t.red, t.yellow, t.blue, t.orange]
			: instrumentType === instrumentTypes.sixFret
				? [t.open, t.black3, t.black2, t.black1, t.white3, t.white2, t.white1]
				: [t.kick, t.kick2x, t.redDrum, t.yellowDrum, t.blueDrum, t.fiveOrangeFourGreenDrum, t.fiveGreenDrum];

	const newEvents: {[key in Difficulty]: Array<MidiTrackEvent>} = {expert: [], hard: [], medium: [], easy: []};

	for (const difficulty of difficulties) {
		let hasNotes = false;
		const activeModifiers: Array<MidiTrackEvent> = [];
		/**
		 * A map of the last zero-length modifiers to be added to `newEvents`.
		 * used to check that duplicates are not added at the same tick.
		 */
		const latestInsertedModifiers: Partial<{[key in EventType]: MidiTrackEvent}> = {};

		for (const event of events[difficulty]) {
			if (event.type === eventTypes.enableChartDynamics) {
				enableChartDynamics = true;
				continue;
			}

			removeWhere(activeModifiers, (m) =>
				m.length === 0 ? m.tick + m.length < event.tick : m.tick + m.length <= event.tick,
			);

			if (modifierSustains.includes(event.type)) {
				activeModifiers.push(event);
				continue; // Don't add modifier sustain to final result
			}

			if (modifiableNotes.includes(event.type)) {
				hasNotes = true;
				// Add all currently active modifiers to event, if those modifiers haven't been added here already
				for (const activeModifier of activeModifiers) {
					const latestInsertedModifier = latestInsertedModifiers[activeModifier.type];
					if (!latestInsertedModifier || latestInsertedModifier.tick < event.tick) {
						const newInsertedModifier: MidiTrackEvent = {
							tick: event.tick,
							length: 0,
							type: activeModifier.type,
							velocity: activeModifier.velocity,
							channel: activeModifier.channel,
						};
						latestInsertedModifiers[activeModifier.type] = newInsertedModifier;
						newEvents[difficulty].push(newInsertedModifier);
					}
				}

				if (
					enableChartDynamics &&
					instrumentType === instrumentTypes.drums &&
					(event.velocity === 1 || event.velocity === 127)
				) {
					newEvents[difficulty].push({
						tick: event.tick,
						length: 0,
						velocity: 127,
						channel: event.channel,
						type: event.velocity === 1 ? getDrumGhostNoteType(event.type)! : getDrumAccentNoteType(event.type)!,
					});
				}
			}

			newEvents[difficulty].push(event);
		}

		// Ensure that modifiers and other events are not copied into uncharted difficulties
		if (!hasNotes) {
			newEvents[difficulty] = [];
		}
	}

	return newEvents;
}

function getDrumGhostNoteType(note: EventType) {
	switch (note) {
		case eventTypes.redDrum:
			return eventTypes.redGhost;
		case eventTypes.yellowDrum:
			return eventTypes.yellowGhost;
		case eventTypes.blueDrum:
			return eventTypes.blueGhost;
		case eventTypes.fiveOrangeFourGreenDrum:
			return eventTypes.fiveOrangeFourGreenGhost;
		case eventTypes.fiveGreenDrum:
			return eventTypes.fiveGreenGhost;
		case eventTypes.kick:
			return eventTypes.kickGhost;
		case eventTypes.kick2x:
			return eventTypes.kickGhost;
		default:
			return undefined;
	}
}

function getDrumAccentNoteType(note: EventType) {
	switch (note) {
		case eventTypes.redDrum:
			return eventTypes.redAccent;
		case eventTypes.yellowDrum:
			return eventTypes.yellowAccent;
		case eventTypes.blueDrum:
			return eventTypes.blueAccent;
		case eventTypes.fiveOrangeFourGreenDrum:
			return eventTypes.fiveOrangeFourGreenAccent;
		case eventTypes.fiveGreenDrum:
			return eventTypes.fiveGreenAccent;
		case eventTypes.kick:
			return eventTypes.kickAccent;
		case eventTypes.kick2x:
			return eventTypes.kickAccent;
		default:
			return undefined;
	}
}

function fixLegacyGhStarPower(
	events: {[key in Difficulty]: Array<MidiTrackEvent>},
	instrumentType: InstrumentType,
	iniChartModifiers: IniChartModifiers,
) {
	if (
		(instrumentType === instrumentTypes.fiveFret || instrumentType === instrumentTypes.sixFret) &&
		iniChartModifiers.multiplier_note !== 116
	) {
		for (const difficulty of difficulties) {
			const starPowerSections: Array<MidiTrackEvent> = [];
			const soloSections: Array<MidiTrackEvent> = [];

			for (const event of events[difficulty]) {
				if (event.type === eventTypes.starPower) {
					starPowerSections.push(event);
				} else if (event.type === eventTypes.soloSection) {
					soloSections.push(event);
				}
			}

			if (iniChartModifiers.multiplier_note === 103 || (!starPowerSections.length && soloSections.length > 1)) {
				for (const soloSection of soloSections) {
					soloSection.type = eventTypes.starPower; // GH1 and GH2 star power
				}
				for (const starPowerSection of starPowerSections) {
					starPowerSection.type = eventTypes.rejectedStarPower; // These should not exist; later this is used to generate issues
				}
			}
		}
	}
	return events;
}

function fixFlexLaneLds(events: {[key in Difficulty]: Array<MidiTrackEvent>}) {
	removeWhere(
		events['easy'],
		(e) =>
			(e.type === eventTypes.flexLaneSingle || e.type === eventTypes.flexLaneDouble) &&
			(e.velocity < 21 || e.velocity > 30),
	);
	removeWhere(
		events['medium'],
		(e) =>
			(e.type === eventTypes.flexLaneSingle || e.type === eventTypes.flexLaneDouble) &&
			(e.velocity < 21 || e.velocity > 40),
	);
	removeWhere(
		events['hard'],
		(e) =>
			(e.type === eventTypes.flexLaneSingle || e.type === eventTypes.flexLaneDouble) &&
			(e.velocity < 21 || e.velocity > 50),
	);

	return events;
}

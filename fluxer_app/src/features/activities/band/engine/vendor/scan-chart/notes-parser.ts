// SPDX-License-Identifier: MIT
// NOTICE: vendored from scan-chart 8.0.1 (src/chart/notes-parser.ts), Copyright (c) Geo. See ./LICENSE.
// Local changes: lodash replaced with native code, imports and formatting adapted.

import {parseNotesFromChart} from '@app/features/activities/band/engine/vendor/scan-chart/chart-parser';
import {
	type DrumType,
	drumTypes,
	type Instrument,
} from '@app/features/activities/band/engine/vendor/scan-chart/interfaces';
import {parseNotesFromMidi} from '@app/features/activities/band/engine/vendor/scan-chart/midi-parser';
import {
	defaultIniChartModifiers,
	type EventType,
	eventTypes,
	type IniChartModifiers,
	type NoteEvent,
	type NoteType,
	noteFlags,
	noteTypes,
	type RawChartData,
} from '@app/features/activities/band/engine/vendor/scan-chart/note-parsing-interfaces';

type TrackEvent = RawChartData['trackData'][number]['trackEvents'][number];
type UntimedNoteEvent = Omit<NoteEvent, 'msTime' | 'msLength'>;

export type ParsedChart = ReturnType<typeof parseChartFile>;

/**
 * Parses `buffer` as a chart in the .chart or .mid format.
 *
 * Throws an exception if `buffer` could not be parsed as a chart in the .chart or .mid format.
 */
export function parseChartFile(
	data: Uint8Array,
	format: 'chart' | 'mid',
	partialIniChartModifiers: Partial<IniChartModifiers> = {},
) {
	const iniChartModifiers = Object.assign({}, defaultIniChartModifiers, partialIniChartModifiers) as IniChartModifiers;
	const rawChartData = format === 'mid' ? parseNotesFromMidi(data, iniChartModifiers) : parseNotesFromChart(data);
	const timedTempos = getTimedTempos(rawChartData.tempos, rawChartData.chartTicksPerBeat);
	const drumTracks = rawChartData.trackData.filter((track) => track.instrument === 'drums');
	const drumType =
		drumTracks.length === 0
			? null
			: iniChartModifiers.pro_drums
				? drumTypes.fourLanePro
				: iniChartModifiers.five_lane_drums
					? drumTypes.fiveLane
					: drumTracks.find((track) => track.trackEvents.find((e) => isCymbalOrTomMarker(e.type)))
						? drumTypes.fourLanePro
						: drumTracks.find((track) => track.trackEvents.find((e) => e.type === eventTypes.fiveGreenDrum))
							? drumTypes.fiveLane
							: drumTypes.fourLane;
	const hasForcedNotes = rawChartData.trackData
		.filter((track) => track.instrument !== 'drums')
		.some((track) =>
			track.trackEvents.some((e) => {
				return (
					e.type === eventTypes.forceUnnatural || e.type === eventTypes.forceHopo || e.type === eventTypes.forceStrum
				);
			}),
		);

	return {
		resolution: rawChartData.chartTicksPerBeat,
		drumType,
		metadata: rawChartData.metadata,
		hasLyrics: rawChartData.hasLyrics,
		hasVocals: rawChartData.hasVocals,
		hasForcedNotes,
		endEvents: setEventMsTimes(rawChartData.endEvents, timedTempos, rawChartData.chartTicksPerBeat),
		tempos: timedTempos,
		timeSignatures: setEventMsTimes(rawChartData.timeSignatures, timedTempos, rawChartData.chartTicksPerBeat),
		sections: setEventMsTimes(rawChartData.sections, timedTempos, rawChartData.chartTicksPerBeat),
		trackData: rawChartData.trackData.map((track) => {
			const eventGroups = groupByTick(
				trimSustains(
					track.trackEvents,
					iniChartModifiers.sustain_cutoff_threshold,
					rawChartData.chartTicksPerBeat,
					format,
				),
			);
			const noteGroups = snapChords(
				track.instrument === 'drums'
					? resolveDrumModifiers(eventGroups, drumType!, format)
					: resolveFretModifiers(eventGroups, iniChartModifiers, rawChartData.chartTicksPerBeat, format),
				iniChartModifiers.chord_snap_threshold,
				track.instrument,
			);
			sortAndFixInvalidNoteOverlaps(noteGroups);
			return {
				instrument: track.instrument,
				difficulty: track.difficulty,
				starPowerSections: sortAndFixInvalidEventOverlaps(
					setEventMsTimes(track.starPowerSections, timedTempos, rawChartData.chartTicksPerBeat),
				),
				rejectedStarPowerSections: setEventMsTimes(
					track.rejectedStarPowerSections,
					timedTempos,
					rawChartData.chartTicksPerBeat,
				),
				soloSections: sortAndFixInvalidEventOverlaps(
					setEventMsTimes(track.soloSections, timedTempos, rawChartData.chartTicksPerBeat),
				),
				flexLanes: sortAndFixInvalidFlexLaneOverlaps(
					setEventMsTimes(track.flexLanes, timedTempos, rawChartData.chartTicksPerBeat),
				),
				drumFreestyleSections: setEventMsTimes(
					track.drumFreestyleSections,
					timedTempos,
					rawChartData.chartTicksPerBeat,
				),
				noteEventGroups: setEventGroupMsTimes(noteGroups, timedTempos, rawChartData.chartTicksPerBeat),
			};
		}),
	};
}

/** Groups events by tick, ordered by ascending tick (matches lodash groupBy + values on integer keys). */
function groupByTick<T extends {tick: number}>(events: Array<T>): Array<Array<T>> {
	const groups = new Map<number, Array<T>>();
	for (const event of events) {
		const group = groups.get(event.tick);
		if (group) {
			group.push(event);
		} else {
			groups.set(event.tick, [event]);
		}
	}
	return [...groups.keys()].sort((a, b) => a - b).map((tick) => groups.get(tick)!);
}

function removeWhere<T>(array: Array<T>, predicate: (element: T) => boolean) {
	let writeIndex = 0;
	for (const element of array) {
		if (!predicate(element)) {
			array[writeIndex++] = element;
		}
	}
	array.length = writeIndex;
}

function pullAll<T>(array: Array<T>, values: Array<T>) {
	const removed = new Set(values);
	removeWhere(array, (element) => removed.has(element));
}

function getTimedTempos(
	tempos: Array<{tick: number; beatsPerMinute: number}>,
	chartTicksPerBeat: number,
): Array<{tick: number; beatsPerMinute: number; msTime: number}> {
	const newTempos: Array<{tick: number; beatsPerMinute: number; msTime: number}> = [
		{tick: 0, beatsPerMinute: 120, msTime: 0},
	];

	for (const tempo of tempos) {
		const newTempo = tempo as {tick: number; beatsPerMinute: number; msTime: number};
		const lastTempo = newTempos[newTempos.length - 1];

		newTempo.msTime =
			lastTempo.msTime + ((tempo.tick - lastTempo.tick) * 60000) / (lastTempo.beatsPerMinute * chartTicksPerBeat);
		newTempos.push(newTempo);
	}

	if (newTempos[1] && newTempos[1].tick === 0) {
		newTempos.shift();
	}
	return newTempos;
}

function isCymbalOrTomMarker(type: EventType) {
	switch (type) {
		case eventTypes.yellowCymbalMarker:
		case eventTypes.blueCymbalMarker:
		case eventTypes.greenCymbalMarker:
		case eventTypes.yellowTomMarker:
		case eventTypes.blueTomMarker:
		case eventTypes.greenTomMarker:
			return true;
		default:
			return false;
	}
}

function setEventGroupMsTimes<T extends {tick: number; length?: number}>(
	events: Array<Array<T>>,
	tempos: Array<{tick: number; beatsPerMinute: number; msTime: number}>,
	chartTicksPerBeat: number,
) {
	return setEventOrEventGroupMsTimes(events, tempos, chartTicksPerBeat) as Array<
		Array<T & {msTime: number; msLength: number}>
	>;
}
function setEventMsTimes<T extends {tick: number; length?: number}>(
	events: Array<T>,
	tempos: Array<{tick: number; beatsPerMinute: number; msTime: number}>,
	chartTicksPerBeat: number,
) {
	return setEventOrEventGroupMsTimes(events, tempos, chartTicksPerBeat) as Array<
		T & {msTime: number; msLength: number}
	>;
}
function setEventOrEventGroupMsTimes<T extends {tick: number; length?: number}>(
	events: Array<T> | Array<Array<T>>,
	tempos: Array<{tick: number; beatsPerMinute: number; msTime: number}>,
	chartTicksPerBeat: number,
) {
	let lastTempoIndex = 0;

	const processNextEvent = (event: T) => {
		while (tempos[lastTempoIndex + 1] && tempos[lastTempoIndex + 1].tick <= event.tick) {
			lastTempoIndex++;
		}

		const lastTempo = tempos[lastTempoIndex];
		const newEvent = event as T & {msTime: number; msLength: number};

		newEvent.msTime =
			lastTempo.msTime + ((event.tick - lastTempo.tick) * 60000) / (lastTempo.beatsPerMinute * chartTicksPerBeat);

		if (event.length) {
			let endTempoIndex = lastTempoIndex;
			while (tempos[endTempoIndex + 1] && tempos[endTempoIndex + 1].tick <= event.tick + event.length) {
				endTempoIndex++;
			}
			const endTempo = tempos[endTempoIndex];
			newEvent.msLength =
				// eslint-disable-next-line max-len
				endTempo.msTime -
				newEvent.msTime +
				((event.tick + event.length - endTempo.tick) * 60000) / (endTempo.beatsPerMinute * chartTicksPerBeat);
		} else {
			newEvent.msLength = 0;
		}
	};

	if (Array.isArray(events[0])) {
		for (const eventGroup of events as Array<Array<T>>) {
			for (const event of eventGroup) {
				processNextEvent(event);
			}
		}
	} else {
		for (const event of events as Array<T>) {
			processNextEvent(event);
		}
	}
	return events as Array<Array<T & {msTime: number; msLength: number}>> | Array<T & {msTime: number; msLength: number}>;
}

function trimSustains(
	trackEvents: Array<{tick: number; length: number; type: EventType}>,
	sustain_cutoff_threshold: number,
	chartTicksPerBeat: number,
	format: 'chart' | 'mid',
) {
	const sustainThresholdTicks =
		sustain_cutoff_threshold !== -1
			? sustain_cutoff_threshold
			: format === 'mid'
				? Math.floor(chartTicksPerBeat / 3) + 1
				: 0;

	if (sustainThresholdTicks > 0) {
		for (const event of trackEvents) {
			if (event.length <= sustainThresholdTicks) {
				event.length = 0;
			}
		}
	}

	return trackEvents;
}

function resolveDrumModifiers(
	trackEventGroups: Array<Array<TrackEvent>>,
	drumType: DrumType,
	format: 'chart' | 'mid',
): Array<Array<UntimedNoteEvent>> {
	const noteEventGroups: Array<Array<UntimedNoteEvent>> = [];
	const discoFlipEventTypes = [eventTypes.discoFlipOff, eventTypes.discoFlipOn, eventTypes.discoNoFlipOn] as const;

	let activeDiscoFlip: (typeof discoFlipEventTypes)[number] = eventTypes.discoFlipOff;
	for (const events of trackEventGroups) {
		const notes = events.filter((e) => isDrumNote(e.type) && !isKickNote(e.type));
		const kicks = events.filter((e) => isKickNote(e.type));
		const modifiers = events.filter((e) => !isDrumNote(e.type)).map((m) => m.type);
		const discoFlipModifiers = modifiers.filter((e) =>
			discoFlipEventTypes.includes(e as (typeof discoFlipEventTypes)[number]),
		);
		const discoFlipModifier = discoFlipModifiers.length > 0 ? Math.min(...discoFlipModifiers) : undefined;
		if (discoFlipModifier) {
			activeDiscoFlip = discoFlipModifier as 51 | 52 | 53; // Set before checked for this event (start inclusive, end exclusive)
		}
		if (notes.length + kicks.length === 0) {
			continue; // Skip any event groups with only modifiers
		}

		const noteEventGroup: Array<UntimedNoteEvent> = [];

		const flamFlag = modifiers.find((e) => e === eventTypes.forceFlam) ? noteFlags.flam : noteFlags.none;
		for (const kick of kicks) {
			const kickTypeFlag = kick.type === eventTypes.kick ? noteFlags.none : noteFlags.doubleKick;
			noteEventGroup.push({
				tick: kick.tick,
				length: kick.length,
				type: noteTypes.kick,
				flags: flamFlag | kickTypeFlag | getGhostOrAccentFlags(kick.type, modifiers),
			});
		}

		const hasOrangeAndGreen =
			!!notes.find((e) => e.type === eventTypes.fiveGreenDrum) &&
			!!notes.find((e) => e.type === eventTypes.fiveOrangeFourGreenDrum);

		for (const note of notes) {
			const type = getDrumNoteTypeFromEventType(note.type, hasOrangeAndGreen)!;
			const canBeDisco = type === noteTypes.redDrum || type === noteTypes.yellowDrum;
			const discoFlag =
				!canBeDisco || activeDiscoFlip === eventTypes.discoFlipOff
					? noteFlags.none
					: activeDiscoFlip === eventTypes.discoFlipOn
						? noteFlags.disco
						: noteFlags.discoNoflip;
			const baseFlags = flamFlag | discoFlag;
			noteEventGroup.push({
				tick: note.tick,
				length: note.length,
				type,
				flags:
					baseFlags |
					getTomOrCymbalFlags(note.type, modifiers, drumType, format) |
					getGhostOrAccentFlags(note.type, modifiers),
			});
		}

		noteEventGroups.push(noteEventGroup);
	}

	return noteEventGroups;
}

function isDrumNote(eventType: EventType) {
	switch (eventType) {
		case eventTypes.kick:
		case eventTypes.kick2x:
		case eventTypes.redDrum:
		case eventTypes.yellowDrum:
		case eventTypes.blueDrum:
		case eventTypes.fiveOrangeFourGreenDrum:
		case eventTypes.fiveGreenDrum:
			return true;
		default:
			return false;
	}
}

function isKickNote(eventType: EventType) {
	switch (eventType) {
		case eventTypes.kick:
		case eventTypes.kick2x:
			return true;
		default:
			return false;
	}
}

function getDrumNoteTypeFromEventType(eventType: EventType, hasOrangeAndGreen: boolean): NoteType | null {
	switch (eventType) {
		case eventTypes.redDrum:
			return noteTypes.redDrum;
		case eventTypes.yellowDrum:
			return noteTypes.yellowDrum;
		case eventTypes.blueDrum:
			return noteTypes.blueDrum;
		case eventTypes.fiveOrangeFourGreenDrum:
			return noteTypes.greenDrum;
		case eventTypes.fiveGreenDrum:
			return hasOrangeAndGreen ? noteTypes.blueDrum : noteTypes.greenDrum;
		default:
			return null;
	}
}

function getTomOrCymbalFlags(
	eventType: EventType,
	modifiers: Array<EventType>,
	drumType: DrumType,
	format: 'chart' | 'mid',
) {
	switch (drumType) {
		case drumTypes.fourLane:
			return noteFlags.tom;
		case drumTypes.fourLanePro:
			switch (format) {
				case 'mid':
					switch (eventType) {
						case eventTypes.redDrum:
							return noteFlags.tom;
						case eventTypes.yellowDrum:
							return modifiers.includes(eventTypes.yellowTomMarker) ? noteFlags.tom : noteFlags.cymbal;
						case eventTypes.blueDrum:
							return modifiers.includes(eventTypes.blueTomMarker) ? noteFlags.tom : noteFlags.cymbal;
						case eventTypes.fiveOrangeFourGreenDrum:
							return modifiers.includes(eventTypes.greenTomMarker) ? noteFlags.tom : noteFlags.cymbal;
						case eventTypes.fiveGreenDrum:
							return noteFlags.tom;
						default:
							return noteFlags.none;
					}
				case 'chart':
					switch (eventType) {
						case eventTypes.redDrum:
							return noteFlags.tom;
						case eventTypes.yellowDrum:
							return modifiers.includes(eventTypes.yellowCymbalMarker) ? noteFlags.cymbal : noteFlags.tom;
						case eventTypes.blueDrum:
							return modifiers.includes(eventTypes.blueCymbalMarker) ? noteFlags.cymbal : noteFlags.tom;
						case eventTypes.fiveOrangeFourGreenDrum:
							return modifiers.includes(eventTypes.greenCymbalMarker) ? noteFlags.cymbal : noteFlags.tom;
						case eventTypes.fiveGreenDrum:
							return noteFlags.tom;
						default:
							return noteFlags.none;
					}
				default:
					return noteFlags.none;
			}
		case drumTypes.fiveLane:
			switch (eventType) {
				case eventTypes.redDrum:
					return noteFlags.tom;
				case eventTypes.yellowDrum:
					return noteFlags.cymbal;
				case eventTypes.blueDrum:
					return noteFlags.tom;
				case eventTypes.fiveOrangeFourGreenDrum:
					return noteFlags.cymbal;
				case eventTypes.fiveGreenDrum:
					return noteFlags.tom;
				default:
					return noteFlags.none;
			}
		default:
			return noteFlags.none;
	}
}

function getGhostOrAccentFlags(eventType: EventType, modifiers: Array<EventType>) {
	switch (eventType) {
		case eventTypes.redDrum:
			return modifiers.includes(eventTypes.redAccent)
				? noteFlags.accent
				: modifiers.includes(eventTypes.redGhost)
					? noteFlags.ghost
					: noteFlags.none;
		case eventTypes.yellowDrum:
			return modifiers.includes(eventTypes.yellowAccent)
				? noteFlags.accent
				: modifiers.includes(eventTypes.yellowGhost)
					? noteFlags.ghost
					: noteFlags.none;
		case eventTypes.blueDrum:
			return modifiers.includes(eventTypes.blueAccent)
				? noteFlags.accent
				: modifiers.includes(eventTypes.blueGhost)
					? noteFlags.ghost
					: noteFlags.none;
		case eventTypes.fiveOrangeFourGreenDrum:
			return modifiers.includes(eventTypes.fiveOrangeFourGreenAccent)
				? noteFlags.accent
				: modifiers.includes(eventTypes.fiveOrangeFourGreenGhost)
					? noteFlags.ghost
					: noteFlags.none;
		case eventTypes.fiveGreenDrum:
			return modifiers.includes(eventTypes.fiveGreenAccent)
				? noteFlags.accent
				: modifiers.includes(eventTypes.fiveGreenGhost)
					? noteFlags.ghost
					: noteFlags.none;
		case eventTypes.kick:
			return modifiers.includes(eventTypes.kickAccent)
				? noteFlags.accent
				: modifiers.includes(eventTypes.kickGhost)
					? noteFlags.ghost
					: noteFlags.none;
		case eventTypes.kick2x:
			return modifiers.includes(eventTypes.kickAccent)
				? noteFlags.accent
				: modifiers.includes(eventTypes.kickGhost)
					? noteFlags.ghost
					: noteFlags.none;
		default:
			return noteFlags.none;
	}
}

function resolveFretModifiers(
	trackEventGroups: Array<Array<TrackEvent>>,
	iniChartModifiers: IniChartModifiers,
	chartTicksPerBeat: number,
	format: 'chart' | 'mid',
): Array<Array<UntimedNoteEvent>> {
	const hopoThresholdTicks =
		iniChartModifiers.hopo_frequency ||
		(iniChartModifiers.eighthnote_hopo
			? Math.floor(1 + chartTicksPerBeat / 2)
			: Math.floor(format === 'mid' ? 1 + chartTicksPerBeat / 3 : (65 / 192) * chartTicksPerBeat));

	const noteEventGroups: Array<Array<UntimedNoteEvent>> = [];

	let lastNotes: Array<TrackEvent> | null = null;
	// trackEventGroups only contain notes and note modifiers
	for (let i = 0; i < trackEventGroups.length; i++) {
		const events = trackEventGroups[i];
		if (events.some((n) => n.type === eventTypes.forceOpen)) {
			// Apply open modifier
			// Note: it's not possible for a forceOpen event to generate without there also being at least one playable note here
			const longestEvent = events
				.filter((e) => isFretNote(e.type))
				.reduce((longest, e) => (e.length > longest.length ? e : longest));
			removeWhere(events, (e) => isFretNote(e.type) || e.type === eventTypes.forceOpen);
			longestEvent.type = eventTypes.open;
			events.push(longestEvent);
		}
		const notes = events.filter((e) => isFretNote(e.type));
		if (!notes.length) {
			continue; // Skip any event groups with only modifiers
		}

		const isNaturalHopo =
			!!lastNotes &&
			notes[0].tick - lastNotes[0].tick <= hopoThresholdTicks &&
			!isFretChord(notes) &&
			!isSameFretNote(events, lastNotes) &&
			// This .mid exception is due to compatibility concerns with older games that primarily use .mid
			!(format === 'mid' && isFretChord(lastNotes) && isInFretNote(notes, lastNotes));
		const hasForceUnnatural = !!events.find((n) => n.type === eventTypes.forceUnnatural);
		const forceResult = events.find((n) => n.type === eventTypes.forceTap)
			? noteFlags.tap
			: events.find((n) => n.type === eventTypes.forceHopo)
				? noteFlags.hopo
				: events.find((n) => n.type === eventTypes.forceStrum)
					? noteFlags.strum
					: (hasForceUnnatural && isNaturalHopo) || (!hasForceUnnatural && !isNaturalHopo)
						? noteFlags.strum
						: noteFlags.hopo;

		noteEventGroups.push(
			notes.map((n) => ({
				tick: n.tick,
				length: n.length,
				type: getFretNoteTypeFromEventType(n.type)!, // Should be the only event types at this point
				flags: forceResult,
			})),
		);

		lastNotes = notes;
	}

	return noteEventGroups;
}

function isFretNote(type: EventType) {
	switch (type) {
		case eventTypes.open:
		case eventTypes.green:
		case eventTypes.red:
		case eventTypes.yellow:
		case eventTypes.blue:
		case eventTypes.orange:
		case eventTypes.black3:
		case eventTypes.black2:
		case eventTypes.black1:
		case eventTypes.white3:
		case eventTypes.white2:
		case eventTypes.white1:
			return true;
		default:
			return false;
	}
}

function isSameFretNote(note1: Array<TrackEvent>, note2: Array<TrackEvent>) {
	for (const n1 of note1) {
		if (!isFretNote(n1.type)) {
			continue;
		}

		for (const n2 of note2) {
			if (!isFretNote(n2.type)) {
				continue;
			}

			if (n1.type !== n2.type) {
				return false;
			}
		}
	}

	for (const n2 of note2) {
		if (!isFretNote(n2.type)) {
			continue;
		}

		for (const n1 of note1) {
			if (!isFretNote(n1.type)) {
				continue;
			}

			if (n2.type !== n1.type) {
				return false;
			}
		}
	}

	return true;
}

function isFretChord(note: Array<TrackEvent>) {
	let firstNoteType: EventType | null = null;
	for (const n of note) {
		if (isFretNote(n.type)) {
			if (firstNoteType === null) {
				firstNoteType = n.type;
			} else if (firstNoteType !== n.type) {
				return true;
			}
		}
	}
	return false;
}

function isInFretNote(inNote: Array<TrackEvent>, outerNote: Array<TrackEvent>) {
	const outerTypes = new Set(outerNote.filter((n) => isFretNote(n.type)).map((note) => note.type));
	return inNote.filter((n) => isFretNote(n.type)).every((note) => outerTypes.has(note.type));
}

function getFretNoteTypeFromEventType(eventType: EventType): NoteType | null {
	switch (eventType) {
		case eventTypes.open:
			return noteTypes.open;
		case eventTypes.green:
			return noteTypes.green;
		case eventTypes.red:
			return noteTypes.red;
		case eventTypes.yellow:
			return noteTypes.yellow;
		case eventTypes.blue:
			return noteTypes.blue;
		case eventTypes.orange:
			return noteTypes.orange;
		case eventTypes.black3:
			return noteTypes.black3;
		case eventTypes.black2:
			return noteTypes.black2;
		case eventTypes.black1:
			return noteTypes.black1;
		case eventTypes.white3:
			return noteTypes.white3;
		case eventTypes.white2:
			return noteTypes.white2;
		case eventTypes.white1:
			return noteTypes.white1;
		default:
			return null;
	}
}

function snapChords(noteGroups: Array<Array<UntimedNoteEvent>>, chord_snap_threshold: number, instrument: Instrument) {
	if (chord_snap_threshold <= 0 || noteGroups.length === 0) {
		return noteGroups;
	}

	const newNoteGroups: Array<Array<UntimedNoteEvent>> = [noteGroups[0]];

	for (let i = 1; i < noteGroups.length; i++) {
		const noteGroup = noteGroups[i];
		const lastNoteGroup = newNoteGroups[newNoteGroups.length - 1];

		if (noteGroup[0].tick - lastNoteGroup[0].tick >= chord_snap_threshold) {
			newNoteGroups.push(noteGroup);
		} else {
			// Resolve flag differences between the note groups
			if (instrument === 'drums') {
				for (const note of noteGroup) {
					if (note.type === noteTypes.kick) {
						const lastKickFlags = lastNoteGroup.find((n) => n.type === noteTypes.kick)?.flags ?? null;
						note.flags = lastKickFlags === null ? note.flags : lastKickFlags;
					} else if (note.type === noteTypes.redDrum) {
						const lastRedDrumFlags = lastNoteGroup.find((n) => n.type === noteTypes.redDrum)?.flags ?? null;
						note.flags = lastRedDrumFlags === null ? note.flags : lastRedDrumFlags;
					} else if (note.type === noteTypes.yellowDrum) {
						const lastYellowDrumFlags = lastNoteGroup.find((n) => n.type === noteTypes.yellowDrum)?.flags ?? null;
						note.flags = lastYellowDrumFlags === null ? note.flags : lastYellowDrumFlags;
					} else if (note.type === noteTypes.blueDrum) {
						const lastBlueDrumFlags = lastNoteGroup.find((n) => n.type === noteTypes.blueDrum)?.flags ?? null;
						note.flags = lastBlueDrumFlags === null ? note.flags : lastBlueDrumFlags;
					} else if (note.type === noteTypes.greenDrum) {
						const lastGreenDrumFlags = lastNoteGroup.find((n) => n.type === noteTypes.greenDrum)?.flags ?? null;
						note.flags = lastGreenDrumFlags === null ? note.flags : lastGreenDrumFlags;
					}

					// Handle edge case with resolving disco and discoNoflip modifier differences on red and yellow drum notes
					if (note.type === noteTypes.redDrum || note.type === noteTypes.yellowDrum) {
						const lastRedDrumFlags = lastNoteGroup.find((n) => n.type === noteTypes.redDrum)?.flags ?? null;
						const lastYellowDrumFlags = lastNoteGroup.find((n) => n.type === noteTypes.yellowDrum)?.flags ?? null;
						if (lastRedDrumFlags !== null || lastYellowDrumFlags !== null) {
							const discoNoteFlags = noteFlags.disco | noteFlags.discoNoflip;
							const lastDiscoEventFlags = ((lastRedDrumFlags ?? 0) | (lastYellowDrumFlags ?? 0)) & discoNoteFlags;
							note.flags &= ~discoNoteFlags;
							note.flags |= lastDiscoEventFlags;
						}
					}
				}
			} else {
				const lastNoteGroupFlags = lastNoteGroup[0].flags;
				noteGroup.forEach((n) => (n.flags = lastNoteGroupFlags));
			}

			// Snap notes to previous note group (this can cause stacked notes, but that's resolved later)
			for (const note of noteGroup) {
				note.tick = lastNoteGroup[0].tick;
				lastNoteGroup.push(note);
			}
		}
	}

	return newNoteGroups;
}

function sortAndFixInvalidFlexLaneOverlaps(
	events: Array<{tick: number; length: number; isDouble: boolean; msTime: number; msLength: number}>,
) {
	events.sort((a, b) => {
		if (a.tick !== b.tick) {
			return a.tick - b.tick;
		}
		if (a.isDouble !== b.isDouble) {
			return (a.isDouble ? 1 : 0) - (b.isDouble ? 1 : 0); // false first
		}
		return b.length - a.length; // length descending (longest lane is kept for duplicates)
	});
	let removedEvents: Array<{tick: number; length: number; isDouble: boolean; msTime: number; msLength: number}> | null =
		null;
	for (let i = 1; i < events.length; i++) {
		if (events[i].tick === events[i - 1].tick && events[i].isDouble === events[i - 1].isDouble) {
			(removedEvents ??= []).push(events[i]);
		}
	}

	if (removedEvents) {
		pullAll(events, removedEvents);
	}

	return events;
}

function sortAndFixInvalidEventOverlaps(
	events: Array<{tick: number; length: number; msTime: number; msLength: number}>,
) {
	events.sort((a, b) => a.tick - b.tick || b.length - a.length); // Longest event is kept for duplicates
	let removedEvents: Array<{tick: number; length: number; msTime: number; msLength: number}> | null = null;
	for (let i = 1; i < events.length; i++) {
		if (events[i].tick === events[i - 1].tick) {
			(removedEvents ??= []).push(events[i]);
		}
	}

	if (removedEvents) {
		pullAll(events, removedEvents);
	}

	let previousEvent: {tick: number; length: number; msTime: number; msLength: number} | null = null;
	for (const event of events) {
		if (previousEvent && previousEvent.tick + previousEvent.length > event.tick) {
			event.length = Math.max(event.length, previousEvent.length - (event.tick - previousEvent.tick));
			event.msLength = Math.max(event.msLength, previousEvent.msLength - (event.msTime - previousEvent.msTime));
			previousEvent.length = event.tick - previousEvent.tick;
			previousEvent.msLength = event.msTime - previousEvent.msTime;
		}
		previousEvent = event;
	}

	return events;
}

function sortAndFixInvalidNoteOverlaps(noteGroups: Array<Array<UntimedNoteEvent>>) {
	for (const noteGroup of noteGroups) {
		noteGroup.sort((a, b) => a.type - b.type || b.length - a.length || b.flags - a.flags); // Longest sustain is kept for duplicates
		let removedNotes: Array<UntimedNoteEvent> | null = null;
		for (let i = 1; i < noteGroup.length; i++) {
			if (noteGroup[i].type === noteGroup[i - 1].type) {
				(removedNotes ??= []).push(noteGroup[i]);
			}
		}

		if (removedNotes) {
			pullAll(noteGroup, removedNotes);
		}
	}

	const previousNotesOfType = new Map<NoteType, UntimedNoteEvent>();
	for (const noteGroup of noteGroups) {
		for (const note of noteGroup) {
			const previousNoteOfType = previousNotesOfType.get(note.type);
			previousNotesOfType.set(note.type, note);
			if (previousNoteOfType && previousNoteOfType.tick + previousNoteOfType.length > note.tick) {
				note.length = Math.max(note.length, previousNoteOfType.length - (note.tick - previousNoteOfType.tick));
				previousNoteOfType.length = note.tick - previousNoteOfType.tick;
			}
		}
	}
}

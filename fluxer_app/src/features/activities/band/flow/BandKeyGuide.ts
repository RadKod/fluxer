// SPDX-License-Identifier: AGPL-3.0-or-later

// What the key guide on the select screen draws for a part, read from the same key map and lane mapping the game uses.

import {DrumLane, FretLane, type InstrumentPart} from '@app/features/activities/band/engine/ChartModel';
import {actionForKey, type BandKeyMap} from '@app/features/activities/band/game/BandInput';

export type BandLaneColour = 'green' | 'red' | 'yellow' | 'blue' | 'orange';

export interface BandGuideKey {
	readonly code: string;
	readonly label: string;
	readonly colour: BandLaneColour | null;
}

export interface BandPartKeys {
	readonly lanes: ReadonlyArray<BandGuideKey>;
	readonly kick: BandGuideKey | null;
	readonly starPower: BandGuideKey | null;
}

const FRET_COLOURS: Readonly<Record<number, BandLaneColour>> = {
	[FretLane.Green]: 'green',
	[FretLane.Red]: 'red',
	[FretLane.Yellow]: 'yellow',
	[FretLane.Blue]: 'blue',
	[FretLane.Orange]: 'orange',
};

const DRUM_COLOURS: Readonly<Record<number, BandLaneColour>> = {
	[DrumLane.Kick]: 'orange',
	[DrumLane.Red]: 'red',
	[DrumLane.Yellow]: 'yellow',
	[DrumLane.Blue]: 'blue',
	[DrumLane.Green]: 'green',
};

// KeyboardEvent.code to what is printed on the key: KeyA is A, Digit1 is 1, ShiftRight is Shift.
export function keyCapLabel(code: string): string {
	if (code.startsWith('Key')) return code.slice(3);
	if (code.startsWith('Digit')) return code.slice(5);
	return code.replace(/(Left|Right)$/, '');
}

function guideKey(map: BandKeyMap, part: InstrumentPart, code: string): BandGuideKey {
	const action = actionForKey(map, part, code);
	const colours = part === 'drums' ? DRUM_COLOURS : FRET_COLOURS;
	return {code, label: keyCapLabel(code), colour: action.kind === 'lane' ? (colours[action.lane] ?? null) : null};
}

export function bandPartKeys(map: BandKeyMap, part: InstrumentPart): BandPartKeys {
	const drums = part === 'drums';
	const laneCodes = drums ? map.drumPads : map.frets;
	const [kickCode] = map.kick;
	const [starPowerCode] = map.starPower;
	return {
		lanes: laneCodes.map((code) => guideKey(map, part, code)),
		kick: drums && kickCode ? guideKey(map, part, kickCode) : null,
		starPower: starPowerCode ? guideKey(map, part, starPowerCode) : null,
	};
}

// How many lanes the held keys press together; star power and unmapped keys do not count.
export function heldLaneCount(map: BandKeyMap, part: InstrumentPart, heldCodes: Iterable<string>): number {
	const lanes = new Set<number>();
	for (const code of heldCodes) {
		const action = actionForKey(map, part, code);
		if (action.kind === 'lane') lanes.add(action.lane);
	}
	return lanes.size;
}

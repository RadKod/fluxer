// SPDX-License-Identifier: AGPL-3.0-or-later

export interface TempoChange {
	readonly tick: number;
	readonly beatsPerMinute: number;
	readonly msTime: number;
}

export interface TimeSignatureChange {
	readonly tick: number;
	readonly numerator: number;
	readonly denominator: number;
}

// How strongly a tick sits on the metric grid; lower is stronger. Used to decide which notes survive thinning.
export const BeatStrength = {
	Measure: 0,
	Beat: 1,
	Eighth: 2,
	EighthTriplet: 3,
	Sixteenth: 4,
	SixteenthTriplet: 5,
	OffGrid: 6,
} as const;
export type BeatStrength = (typeof BeatStrength)[keyof typeof BeatStrength];

// Subdivisions of one beat for each grid level from Beat to SixteenthTriplet.
const BEAT_SUBDIVISIONS: ReadonlyArray<readonly [BeatStrength, number]> = [
	[BeatStrength.Beat, 1],
	[BeatStrength.Eighth, 2],
	[BeatStrength.EighthTriplet, 3],
	[BeatStrength.Sixteenth, 4],
	[BeatStrength.SixteenthTriplet, 6],
];

export class TempoMap {
	readonly tempos: ReadonlyArray<TempoChange>;
	readonly timeSignatures: ReadonlyArray<TimeSignatureChange>;

	constructor(
		readonly resolution: number,
		tempos: ReadonlyArray<{tick: number; beatsPerMinute: number}>,
		timeSignatures: ReadonlyArray<TimeSignatureChange>,
	) {
		const sortedTempos = [...tempos].sort((a, b) => a.tick - b.tick);
		if (sortedTempos.length === 0 || sortedTempos[0].tick !== 0) {
			sortedTempos.unshift({tick: 0, beatsPerMinute: 120});
		}
		const timed: Array<TempoChange> = [];
		for (const tempo of sortedTempos) {
			const previous = timed[timed.length - 1];
			const msTime = previous
				? previous.msTime + ((tempo.tick - previous.tick) * 60000) / (previous.beatsPerMinute * resolution)
				: 0;
			timed.push({tick: tempo.tick, beatsPerMinute: tempo.beatsPerMinute, msTime});
		}
		this.tempos = timed;

		const sortedSignatures = [...timeSignatures].sort((a, b) => a.tick - b.tick);
		if (sortedSignatures.length === 0 || sortedSignatures[0].tick !== 0) {
			sortedSignatures.unshift({tick: 0, numerator: 4, denominator: 4});
		}
		this.timeSignatures = sortedSignatures;
	}

	private tempoAtTick(tick: number): TempoChange {
		return this.tempos[lastIndexAtOrBefore(this.tempos, tick, (tempo) => tempo.tick)];
	}

	tickToMs(tick: number): number {
		const tempo = this.tempoAtTick(tick);
		return tempo.msTime + ((tick - tempo.tick) * 60000) / (tempo.beatsPerMinute * this.resolution);
	}

	msToTick(msTime: number): number {
		const tempo = this.tempos[lastIndexAtOrBefore(this.tempos, msTime, (change) => change.msTime)];
		return tempo.tick + ((msTime - tempo.msTime) * tempo.beatsPerMinute * this.resolution) / 60000;
	}

	// Ticks per felt beat: x/8 signatures divisible by three (6/8, 9/8, 12/8) count in dotted quarters.
	beatTicksAt(tick: number): number {
		const signature = this.timeSignatures[lastIndexAtOrBefore(this.timeSignatures, tick, (ts) => ts.tick)];
		const unit = (this.resolution * 4) / signature.denominator;
		const compound = signature.denominator >= 8 && signature.numerator % 3 === 0 && signature.numerator > 3;
		return compound ? unit * 3 : unit;
	}

	beatMsAt(tick: number): number {
		return (this.beatTicksAt(tick) * 60000) / (this.tempoAtTick(tick).beatsPerMinute * this.resolution);
	}

	// Zero-based measure number containing `tick`; a partial measure before a signature change counts as one.
	measureIndexAt(tick: number): number {
		let measures = 0;
		for (let i = 0; i < this.timeSignatures.length; i++) {
			const signature = this.timeSignatures[i];
			const measureTicks = measureLength(this.resolution, signature);
			const nextTick = this.timeSignatures[i + 1]?.tick;
			if (nextTick === undefined || nextTick > tick) {
				return measures + Math.floor((tick - signature.tick) / measureTicks);
			}
			measures += Math.ceil((nextTick - signature.tick) / measureTicks);
		}
		return measures;
	}

	beatStrengthAt(tick: number): BeatStrength {
		const signatureIndex = lastIndexAtOrBefore(this.timeSignatures, tick, (ts) => ts.tick);
		const signature = this.timeSignatures[signatureIndex];
		const offset = tick - signature.tick;
		if (isMultiple(offset, measureLength(this.resolution, signature))) return BeatStrength.Measure;
		const beatTicks = this.beatTicksAt(tick);
		for (const [strength, subdivisions] of BEAT_SUBDIVISIONS) {
			if (isMultiple(offset, beatTicks / subdivisions)) return strength;
		}
		return BeatStrength.OffGrid;
	}

	// Length in ms of one step of the given grid level at `tick`.
	gridStepMsAt(tick: number, strength: BeatStrength): number {
		if (strength === BeatStrength.OffGrid) return 0;
		const subdivisions = BEAT_SUBDIVISIONS.find(([level]) => level === strength)?.[1] ?? 1;
		return this.beatMsAt(tick) / subdivisions;
	}
}

function measureLength(resolution: number, signature: TimeSignatureChange): number {
	return (resolution * 4 * signature.numerator) / signature.denominator;
}

// Charts are authored in integer ticks, but triplet steps are fractional; allow a one-tick rounding error.
function isMultiple(value: number, step: number): boolean {
	if (step <= 0) return false;
	const remainder = value % step;
	return remainder < 1 || step - remainder < 1;
}

function lastIndexAtOrBefore<T>(items: ReadonlyArray<T>, value: number, key: (item: T) => number): number {
	let low = 0;
	let high = items.length - 1;
	while (low < high) {
		const middle = (low + high + 1) >> 1;
		if (key(items[middle]) <= value) low = middle;
		else high = middle - 1;
	}
	return low;
}

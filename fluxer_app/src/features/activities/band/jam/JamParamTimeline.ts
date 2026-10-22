// SPDX-License-Identifier: AGPL-3.0-or-later

// A mirror of what has been scheduled on one AudioParam, so the value at any moment is known without reading the
// param (AudioParam.value lags the render thread). Interrupting a gesture (a bend released half way, a note let go
// while its feedback blooms) cancels from that moment and continues from the computed value, with no jump.
// Only setValueAtTime, linearRampToValueAtTime and setTargetAtTime are used; every cancel leaves a set event behind,
// so a ramp always starts from a set or another ramp.

type TimelineEvent =
	| {readonly kind: 'set'; readonly time: number; readonly value: number}
	| {readonly kind: 'ramp'; readonly time: number; readonly value: number}
	| {readonly kind: 'target'; readonly time: number; readonly value: number; readonly timeConstant: number};

export interface ParamSink {
	setValueAtTime(value: number, time: number): unknown;
	linearRampToValueAtTime(value: number, time: number): unknown;
	setTargetAtTime(value: number, time: number, timeConstant: number): unknown;
	cancelScheduledValues(time: number): unknown;
}

export class ParamTimeline {
	private events: Array<TimelineEvent> = [];

	constructor(
		private readonly initial: number,
		private readonly sink: ParamSink | null = null,
	) {}

	valueAt(time: number): number {
		let value = this.initial;
		let previousTime = Number.NEGATIVE_INFINITY;
		let running: RunningTarget | null = null;
		for (const event of this.events) {
			if (event.time > time) {
				if (running) return targetValue(running, time);
				if (event.kind === 'ramp' && Number.isFinite(previousTime)) {
					return value + ((event.value - value) * (time - previousTime)) / (event.time - previousTime);
				}
				return value;
			}
			if (running) {
				value = targetValue(running, event.time);
				running = null;
			}
			if (event.kind === 'target') {
				running = {value: event.value, timeConstant: event.timeConstant, from: value, start: event.time};
			} else {
				value = event.value;
			}
			previousTime = event.time;
		}
		return running ? targetValue(running, time) : value;
	}

	set(time: number, value: number): void {
		this.insert({kind: 'set', time, value});
		this.sink?.setValueAtTime(value, time);
	}

	rampTo(time: number, value: number): void {
		this.insert({kind: 'ramp', time, value});
		this.sink?.linearRampToValueAtTime(value, time);
	}

	target(time: number, value: number, timeConstant: number): void {
		this.insert({kind: 'target', time, value, timeConstant});
		this.sink?.setTargetAtTime(value, time, timeConstant);
	}

	// Drops everything from `time` on and holds the value the param had there. Returns that value.
	hold(time: number): number {
		const value = this.valueAt(time);
		this.events = this.events.filter((event) => event.time < time);
		// A set also stops a target that started earlier and would otherwise keep running.
		this.events.push({kind: 'set', time, value});
		this.sink?.cancelScheduledValues(time);
		this.sink?.setValueAtTime(value, time);
		return value;
	}

	private insert(event: TimelineEvent): void {
		let index = this.events.length;
		while (index > 0 && this.events[index - 1].time > event.time) index--;
		this.events.splice(index, 0, event);
	}
}

interface RunningTarget {
	readonly value: number;
	readonly timeConstant: number;
	readonly from: number;
	readonly start: number;
}

function targetValue(target: RunningTarget, time: number): number {
	if (time <= target.start) return target.from;
	return target.value + (target.from - target.value) * Math.exp(-(time - target.start) / target.timeConstant);
}

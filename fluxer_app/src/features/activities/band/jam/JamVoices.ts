// SPDX-License-Identifier: AGPL-3.0-or-later

// Sample choice and voice bookkeeping for the jam samplers, without Web Audio: which recorded note plays a pitch,
// and which sounding voices a new note cuts (same note, choke groups, the voice limit).

export interface SampleChoice {
	readonly key: number;
	// Playback shift from the sample to the note, in semitones.
	readonly detune: number;
}

// The nearest recorded note; on a tie the lower one, as the prototype's argmin did.
export function nearestSample(keys: ReadonlyArray<number>, midi: number): SampleChoice {
	if (keys.length === 0) throw new RangeError('No samples to choose from');
	let key = keys[0];
	for (const candidate of keys) {
		if (Math.abs(candidate - midi) < Math.abs(key - midi)) key = candidate;
	}
	return {key, detune: midi - key};
}

export interface VoicePolicy {
	readonly maxVoices: number;
	// Retriggering a note cuts the one still ringing (one string, one drum head).
	readonly chokeSameNote: boolean;
	// A note in group G cuts every voice whose group is listed under G (closed hi-hat cuts the open one).
	readonly chokes?: Readonly<Record<string, ReadonlyArray<string>>>;
	// Ring-out cap per note, for cymbals hit in a roll.
	readonly maxPerNote?: number;
}

export interface TrackedVoice {
	readonly id: number;
	readonly note: number;
	readonly group: string | null;
	readonly startTime: number;
	releasing: boolean;
}

export class VoiceAllocator {
	private readonly voices: Array<TrackedVoice> = [];
	private nextId = 1;

	constructor(private readonly policy: VoicePolicy) {}

	get active(): ReadonlyArray<TrackedVoice> {
		return this.voices;
	}

	// Registers a new voice and returns the ones it cuts, already removed from the books.
	start(note: number, group: string | null, startTime: number): {id: number; cut: ReadonlyArray<TrackedVoice>} {
		const {chokeSameNote, chokes, maxPerNote, maxVoices} = this.policy;
		const choked = group ? (chokes?.[group] ?? []) : [];
		const cut: Array<TrackedVoice> = [];
		const take = (voice: TrackedVoice) => {
			cut.push(voice);
			this.voices.splice(this.voices.indexOf(voice), 1);
		};
		for (const voice of [...this.voices]) {
			if ((chokeSameNote && voice.note === note) || (voice.group !== null && choked.includes(voice.group))) {
				take(voice);
			}
		}
		if (maxPerNote !== undefined) {
			const sameNote = this.voices.filter((voice) => voice.note === note);
			for (const voice of sameNote.slice(0, Math.max(0, sameNote.length - maxPerNote + 1))) take(voice);
		}
		while (this.voices.length >= maxVoices) {
			const releasing = this.voices.find((voice) => voice.releasing);
			take(releasing ?? this.voices[0]);
		}
		const id = this.nextId++;
		this.voices.push({id, note, group, startTime, releasing: false});
		return {id, cut};
	}

	// The held (not yet released) voices playing `note`, oldest first.
	held(note: number): ReadonlyArray<TrackedVoice> {
		return this.voices.filter((voice) => voice.note === note && !voice.releasing);
	}

	newestHeld(): TrackedVoice | null {
		for (let i = this.voices.length - 1; i >= 0; i--) {
			if (!this.voices[i].releasing) return this.voices[i];
		}
		return null;
	}

	release(id: number): void {
		const voice = this.voices.find((v) => v.id === id);
		if (voice) voice.releasing = true;
	}

	// The voice's sound has ended.
	end(id: number): void {
		const index = this.voices.findIndex((v) => v.id === id);
		if (index >= 0) this.voices.splice(index, 1);
	}

	clear(): ReadonlyArray<TrackedVoice> {
		return this.voices.splice(0);
	}
}

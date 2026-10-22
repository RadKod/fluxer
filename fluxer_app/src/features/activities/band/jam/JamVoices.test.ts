// SPDX-License-Identifier: AGPL-3.0-or-later

import {JAM_MAX_DETUNE_SEMITONES} from '@app/features/activities/band/jam/JamScales';
import {JAM_V1_SAMPLE_KEYS} from '@app/features/activities/band/jam/JamTestFixtures';
import {nearestSample, VoiceAllocator} from '@app/features/activities/band/jam/JamVoices';
import {describe, expect, it} from 'vitest';

describe('nearestSample', () => {
	it('picks the closest recorded note and the detune to reach the played one', () => {
		const keys = JAM_V1_SAMPLE_KEYS.gitar_di;
		expect(nearestSample(keys, 57)).toEqual({key: 57, detune: 0});
		expect(nearestSample(keys, 58)).toEqual({key: 57, detune: 1});
		expect(nearestSample(keys, 59)).toEqual({key: 60, detune: -1});
		expect(nearestSample(keys, 85)).toEqual({key: 84, detune: 1});
		expect(nearestSample(keys, 30)).toEqual({key: 37, detune: -7});
	});

	it('takes the lower sample on a tie, like the prototype', () => {
		expect(nearestSample([40, 44], 42)).toEqual({key: 40, detune: 2});
	});

	it('stays within 1.5 semitones inside every v1 sample group', () => {
		for (const keys of Object.values(JAM_V1_SAMPLE_KEYS)) {
			for (let midi = keys[0]; midi <= keys[keys.length - 1]; midi++) {
				expect(Math.abs(nearestSample(keys, midi).detune)).toBeLessThanOrEqual(1.5);
			}
			expect(Math.abs(nearestSample(keys, keys[0] - JAM_MAX_DETUNE_SEMITONES).detune)).toBe(2);
		}
	});

	it('refuses an empty sample set', () => {
		expect(() => nearestSample([], 60)).toThrow(RangeError);
	});
});

describe('VoiceAllocator', () => {
	it('cuts the same note when retriggered', () => {
		const voices = new VoiceAllocator({maxVoices: 6, chokeSameNote: true});
		const first = voices.start(60, null, 0);
		expect(first.cut).toEqual([]);
		const second = voices.start(60, null, 0.1);
		expect(second.cut.map((v) => v.id)).toEqual([first.id]);
		expect(voices.active.map((v) => v.id)).toEqual([second.id]);
	});

	it('steals releasing voices before held ones, then the oldest', () => {
		const voices = new VoiceAllocator({maxVoices: 2, chokeSameNote: true});
		const a = voices.start(60, null, 0);
		const b = voices.start(62, null, 0.1);
		voices.release(b.id);
		expect(voices.start(64, null, 0.2).cut.map((v) => v.id)).toEqual([b.id]);
		expect(voices.start(65, null, 0.3).cut.map((v) => v.id)).toEqual([a.id]);
		expect(voices.active).toHaveLength(2);
	});

	it('lets a closed hi-hat choke the open one but not other pieces', () => {
		const voices = new VoiceAllocator({
			maxVoices: 24,
			chokeSameNote: false,
			chokes: {hh_kapali: ['hh_acik'], hh_acik: ['hh_acik']},
		});
		const open = voices.start(3, 'hh_acik', 0);
		const crash = voices.start(6, 'crash', 0);
		const closed = voices.start(2, 'hh_kapali', 0.2);
		expect(closed.cut.map((v) => v.id)).toEqual([open.id]);
		expect(voices.active.map((v) => v.id)).toEqual([crash.id, closed.id]);
		const reopened = voices.start(3, 'hh_acik', 0.3);
		expect(reopened.cut).toEqual([]);
		expect(voices.start(3, 'hh_acik', 0.4).cut.map((v) => v.id)).toEqual([reopened.id]);
	});

	it('caps ring-outs per note', () => {
		const voices = new VoiceAllocator({maxVoices: 24, chokeSameNote: false, maxPerNote: 3});
		const ids = [0, 1, 2].map((i) => voices.start(6, 'crash', i).id);
		expect(voices.start(6, 'crash', 3).cut.map((v) => v.id)).toEqual([ids[0]]);
		expect(voices.active.filter((v) => v.note === 6)).toHaveLength(3);
	});

	it('finds held voices for note off and the newest held for a bend', () => {
		const voices = new VoiceAllocator({maxVoices: 6, chokeSameNote: true});
		const a = voices.start(60, null, 0);
		const b = voices.start(64, null, 0.1);
		expect(voices.held(60).map((v) => v.id)).toEqual([a.id]);
		voices.release(b.id);
		expect(voices.newestHeld()?.id).toBe(a.id);
		voices.end(a.id);
		expect(voices.newestHeld()).toBeNull();
		expect(voices.clear().map((v) => v.id)).toEqual([b.id]);
	});
});

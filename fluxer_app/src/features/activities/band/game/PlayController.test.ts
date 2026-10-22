// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandHitMessage, BandIntent, BandSeat} from '@app/features/activities/band/BandProtocol';
import {buildMidi, EXPERT_NOTE_BASE} from '@app/features/activities/band/engine/BandTestFixtures';
import {DrumLane, FretLane} from '@app/features/activities/band/engine/ChartModel';
import {SongChart} from '@app/features/activities/band/engine/SongChart';
import {
	FINALE_BONUS_SHARE,
	finaleBonusCap,
	groupStars,
	NoteState,
	nextFinaleBonus,
	PlayController,
	type PlayControllerOptions,
	STAR_THRESHOLDS,
} from '@app/features/activities/band/game/PlayController';
import type {ActivityMessage, ActivityParticipant} from '@app/features/activities/session/ActivitySessionTypes';
import {describe, expect, it, vi} from 'vitest';

const BEAT = 480;
const STAR_POWER = 116;
const FREESTYLE_LANES = [120, 121, 122, 123, 124];
const GREEN = EXPERT_NOTE_BASE + FretLane.Green;
const YELLOW = EXPERT_NOTE_BASE + FretLane.Yellow;

// 120 BPM: one note per beat, every 500 ms. Star power covers the first two guitar notes.
const SONG = SongChart.parse(
	buildMidi({
		tracks: [
			{
				name: 'PART GUITAR',
				notes: [
					...Array.from({length: 8}, (_, i) => ({tick: i * BEAT, note: GREEN})),
					{tick: 0, note: STAR_POWER, length: BEAT + 100},
				],
			},
			{name: 'PART BASS', notes: Array.from({length: 8}, (_, i) => ({tick: i * BEAT, note: GREEN}))},
		],
	}),
	'mid',
);

// A Harmonix-style ending: guitar notes every beat up to beat 12, "[coda]" and the freestyle lanes from beat 8 to 12
// (4 s to 6 s) on guitar and drums, the drums empty under them, and a final hit at beat 12.5 (a guitar chord).
const FINALE_LANES = FREESTYLE_LANES.map((note) => ({tick: 8 * BEAT, note, length: 4 * BEAT}));
const FINAL_HIT_MS = 6_250;
const FINALE_SONG = SongChart.parse(
	buildMidi({
		tracks: [
			{
				name: 'PART GUITAR',
				notes: [
					...Array.from({length: 12}, (_, i) => ({tick: i * BEAT, note: GREEN})),
					...FINALE_LANES,
					{tick: 12.5 * BEAT, note: GREEN},
					{tick: 12.5 * BEAT, note: YELLOW},
				],
			},
			{
				name: 'PART DRUMS',
				notes: [
					...Array.from({length: 8}, (_, i) => ({tick: i * BEAT, note: EXPERT_NOTE_BASE + DrumLane.Red})),
					...FINALE_LANES,
					{tick: 12.5 * BEAT, note: EXPERT_NOTE_BASE + DrumLane.Red},
				],
			},
			{name: 'EVENTS', texts: [{tick: 8 * BEAT, text: '[coda]'}]},
		],
	}),
	'mid',
);

const SEATS: ReadonlyArray<BandSeat> = [
	{part: 'bass', userId: 'u2', difficulty: 'expert', ready: true},
	{part: 'guitar', userId: 'me', difficulty: 'expert', ready: true},
	{part: 'vocals', userId: 'u3', difficulty: 'medium', ready: true},
];

function participant(userId: string): ActivityParticipant {
	return {identity: `${userId}:c`, userId, connectionId: 'c', joinedAt: 0, isLocal: false};
}

function message(userId: string, payload: unknown): ActivityMessage {
	return {from: participant(userId), seq: 1, payload};
}

function setup(overrides: Partial<PlayControllerOptions> = {}) {
	const send = vi.fn();
	const submitIntent = vi.fn<(intent: BandIntent) => void>();
	const duck = vi.fn();
	const restore = vi.fn();
	const playMissSound = vi.fn();
	const controller = new PlayController({
		chart: SONG,
		seats: SEATS,
		myUserId: 'me',
		songEndMs: 6_000,
		joinedAtMs: 0,
		bigRockEnding: true,
		send,
		submitIntent,
		duck,
		restore,
		playMissSound,
		...overrides,
	});
	const sent = () => send.mock.calls.map(([payload]) => payload);
	const hits = () => sent().filter((payload) => payload.t === 'band.hit');
	const finalePresses = () => sent().filter((payload) => payload.t === 'band.finale' && payload.kind === 'press');
	return {controller, send, submitIntent, duck, restore, playMissSound, hits, finalePresses};
}

describe('PlayController', () => {
	it('orders highways guitar first and leaves the singer to the vocals strip', () => {
		const {controller} = setup();
		expect(controller.tracks.map((track) => track.part)).toEqual(['guitar', 'bass']);
		expect(controller.myTrack?.part).toBe('guitar');
		expect(controller.vocalsSeat?.userId).toBe('u3');
	});

	it('puts rhythm guitar next to the lead and drums in the middle of five highways', () => {
		const lane = (name: string) => ({name, notes: [{tick: 0, note: GREEN}]});
		const chart = SongChart.parse(
			buildMidi({
				tracks: ['PART KEYS', 'PART BASS', 'PART DRUMS', 'PART RHYTHM', 'PART GUITAR'].map(lane),
			}),
			'mid',
		);
		const seats: ReadonlyArray<BandSeat> = (['keys', 'bass', 'drums', 'rhythm', 'guitar'] as const).map((part) => ({
			part,
			userId: part,
			difficulty: 'expert',
			ready: true,
		}));
		const {controller} = setup({chart, seats});
		expect(controller.tracks.map((track) => track.part)).toEqual(['guitar', 'rhythm', 'drums', 'bass', 'keys']);
	});

	it('broadcasts each judged note of my seat, lossy, with its index in the full chart', () => {
		const {controller, send, duck, hits} = setup();
		controller.press(FretLane.Green, 10);
		controller.release(FretLane.Green, 60);
		controller.tick(700);
		expect(hits()).toEqual<Array<BandHitMessage>>([
			{t: 'band.hit', part: 'guitar', noteIndex: 0, hit: true, combo: 1, multiplier: 1, starPower: false, score: 100},
			{t: 'band.hit', part: 'guitar', noteIndex: 1, hit: false, combo: 0, multiplier: 1, starPower: false, score: 100},
		]);
		expect(send.mock.calls.every(([, options]) => options?.reliable === false)).toBe(true);
		expect(duck).toHaveBeenCalledWith('guitar');
		const track = controller.myTrack!;
		expect([track.noteStates[0], track.noteStates[1]]).toEqual([NoteState.Hit, NoteState.Missed]);
		expect(track.feedback?.kind).toBe('miss');
		// The miss broke the star power phrase: its notes draw as plain notes from now on.
		expect(track.brokenStarGroups.has(0)).toBe(true);
	});

	it('fills star power from a completed phrase and doubles scoring once deployed', () => {
		const {controller, hits} = setup();
		controller.press(FretLane.Green, 0);
		controller.release(FretLane.Green, 20);
		controller.press(FretLane.Green, 500);
		controller.release(FretLane.Green, 520);
		const {hud} = controller.myTrack!;
		expect(hud.starPowerEnergy).toBe(0.25);
		controller.deployStarPower(600);
		expect(hud.starPowerActive).toBe(false);

		hud.starPowerEnergy = 0.5;
		controller.deployStarPower(600);
		expect(hud.starPowerActive).toBe(true);
		expect(hud.shownMultiplier).toBe(2);
		const before = hud.score;
		controller.press(FretLane.Green, 1_000);
		controller.tick(1_020);
		expect(hud.score - before).toBe(200);
		expect(hits().at(-1)).toMatchObject({noteIndex: 2, starPower: true});
		controller.tick(600 + 8_001);
		expect(hud.starPowerActive).toBe(false);
	});

	it('mirrors another player from their broadcasts and ducks their stem on a miss, without their miss sound', () => {
		const {controller, duck, restore, playMissSound} = setup();
		const bass = controller.tracks[1];
		controller.tick(1_000);
		controller.receive(
			message('u2', {
				t: 'band.hit',
				part: 'bass',
				noteIndex: 2,
				hit: true,
				combo: 3,
				multiplier: 1,
				starPower: true,
				score: 300,
			}),
		);
		expect(bass.noteStates[2]).toBe(NoteState.Hit);
		expect(bass.hud).toMatchObject({combo: 3, score: 300, starPowerActive: true});
		expect(bass.laneFlashMs[FretLane.Green]).toBe(1_000);

		controller.receive(
			message('u2', {
				t: 'band.hit',
				part: 'bass',
				noteIndex: 3,
				hit: false,
				combo: 0,
				multiplier: 1,
				starPower: false,
				score: 300,
			}),
		);
		expect(restore).toHaveBeenCalledWith('bass');
		expect(duck).toHaveBeenCalledWith('bass');
		expect(playMissSound).not.toHaveBeenCalledWith('bass');
		expect(bass.missAtMs).toBe(1_000);
		expect(controller.groupScore).toBe(300);
	});

	it('ignores hits for a part the sender does not hold, my own part and malformed payloads', () => {
		const {controller, duck} = setup();
		const payload = {
			t: 'band.hit',
			part: 'bass',
			noteIndex: 1,
			hit: false,
			combo: 0,
			multiplier: 1,
			starPower: false,
			score: 0,
		};
		controller.receive(message('u3', payload));
		controller.receive(message('u2', {...payload, part: 'guitar'}));
		controller.receive(message('u2', {...payload, noteIndex: 'x'}));
		controller.receive(message('u2', {...payload, noteIndex: 99}));
		expect(duck).not.toHaveBeenCalled();
		expect(controller.tracks[1].noteStates.every((state) => state === NoteState.Pending)).toBe(true);
	});

	it('sends my result to the leader exactly once when the song ends', () => {
		const {controller, submitIntent} = setup();
		controller.press(FretLane.Green, 0);
		controller.tick(5_999);
		expect(submitIntent).not.toHaveBeenCalled();
		controller.tick(6_000);
		controller.tick(6_100);
		controller.finish();
		expect(submitIntent).toHaveBeenCalledTimes(1);
		expect(submitIntent.mock.calls[0][0]).toEqual({
			t: 'band.result',
			result: {
				part: 'guitar',
				difficulty: 'expert',
				score: 100,
				rawScore: 50,
				accuracy: 1 / 8,
				bestStreak: 1,
				notesHit: 1,
				notesMissed: 7,
				starPowerUses: 0,
			},
		});
	});

	it('lets a late joiner start where the song is instead of missing everything before', () => {
		const {controller, hits} = setup({joinedAtMs: 2_000});
		controller.tick(2_000);
		expect(hits()).toEqual([]);
		controller.press(FretLane.Green, 2_510);
		controller.tick(2_530);
		expect(hits()).toEqual([expect.objectContaining({noteIndex: 5, hit: true})]);
	});

	it('drops my stem on my own miss and brings it back with my next hit', () => {
		const {controller, duck, restore, playMissSound} = setup();
		controller.tick(700);
		expect(duck).toHaveBeenCalledWith('guitar');
		expect(playMissSound).toHaveBeenCalledWith('guitar');
		restore.mockClear();
		controller.press(FretLane.Green, 1_000);
		controller.tick(1_020);
		expect(restore).toHaveBeenCalledWith('guitar');
	});

	it('treats a stray press as a miss: combo gone, miss feedback, sound and duck, no note used up', () => {
		const {controller, duck, playMissSound, hits} = setup();
		controller.press(FretLane.Green, 0);
		controller.release(FretLane.Green, 20);
		expect(controller.myTrack!.hud.combo).toBe(1);
		controller.press(FretLane.Blue, 250);
		const track = controller.myTrack!;
		expect(track.hud.combo).toBe(0);
		expect(track.feedback).toEqual({kind: 'miss', atMs: 250});
		expect(duck).toHaveBeenCalledWith('guitar');
		expect(playMissSound).toHaveBeenCalledExactlyOnceWith('guitar');
		expect(hits()).toHaveLength(1);
	});

	it('keeps the miss sound on this device: nothing about it goes out', () => {
		const {controller, send, playMissSound} = setup();
		controller.press(FretLane.Blue, 250);
		controller.tick(1_200);
		expect(playMissSound).toHaveBeenCalled();
		const payloads = send.mock.calls.map(([payload]) => payload);
		expect(payloads.every((payload) => payload.t === 'band.hit')).toBe(true);
		expect(payloads.every((payload) => Object.keys(payload).every((key) => !/sound/i.test(key)))).toBe(true);
	});

	it('makes no miss sound for the notes settled when the song ends', () => {
		const {controller, playMissSound, submitIntent} = setup();
		controller.tick(50);
		controller.finish();
		expect(submitIntent.mock.calls[0][0]).toMatchObject({result: {notesMissed: 8}});
		expect(playMissSound).not.toHaveBeenCalled();
	});

	it('gives spectators the stage without judging or a result', () => {
		const {controller, send, submitIntent} = setup({myUserId: 'watcher'});
		controller.press(FretLane.Green, 0);
		controller.tick(7_000);
		expect(controller.myTrack).toBeNull();
		expect(send).not.toHaveBeenCalled();
		expect(submitIntent).not.toHaveBeenCalled();
	});

	it('still reports a result for the singer, who has no highway', () => {
		const {controller, submitIntent} = setup({myUserId: 'u3'});
		controller.tick(6_000);
		expect(submitIntent).toHaveBeenCalledWith({
			t: 'band.result',
			result: expect.objectContaining({part: 'vocals', difficulty: 'medium', score: 0}),
		});
	});

	describe('Big Rock Ending', () => {
		const finaleSeats: ReadonlyArray<BandSeat> = [
			{part: 'guitar', userId: 'me', difficulty: 'expert', ready: true},
			{part: 'drums', userId: 'u2', difficulty: 'hard', ready: true},
		];
		const LANES = {startMs: 4_000, endMs: 6_000};

		function finaleSetup(overrides: Partial<PlayControllerOptions> = {}) {
			return setup({chart: FINALE_SONG, seats: finaleSeats, songEndMs: 8_000, ...overrides});
		}

		function playBeats(controller: PlayController, beats: number) {
			for (let i = 0; i < beats; i++) {
				controller.press(FretLane.Green, i * 500);
				controller.release(FretLane.Green, i * 500 + 20);
			}
		}

		function playFinalChord(controller: PlayController, atMs = FINAL_HIT_MS) {
			controller.press(FretLane.Green, atMs - 10);
			controller.press(FretLane.Yellow, atMs - 5);
			controller.tick(atMs + 40);
		}

		it('turns the notes under the lanes into free play that never touches the combo', () => {
			const {controller, hits, finalePresses, restore} = finaleSetup();
			expect(controller.finale).toEqual(LANES);
			expect(controller.myTrack?.finale).toMatchObject({...LANES, firstIndex: 8, finalIndex: 12});
			playBeats(controller, 8);
			const {hud} = controller.myTrack!;
			expect(hud.combo).toBe(8);

			controller.tick(4_100);
			expect(controller.finaleActive).toBe(true);
			expect(hud.finaleOn).toBe(true);
			expect(restore).toHaveBeenCalledWith('guitar');
			controller.press(FretLane.Red, 4_200);
			// The same lane again inside its cooldown lights up but does not count.
			controller.press(FretLane.Red, 4_250);
			controller.press(FretLane.Blue, 4_260);
			controller.tick(5_950);
			// Past the lanes and before the final hit's window, a press still only lights its lane.
			controller.press(FretLane.Orange, 6_100);
			controller.tick(6_140);

			expect(hits()).toHaveLength(8);
			expect(hud.combo).toBe(8);
			expect(controller.myTrack!.noteStates.slice(8, 12).every((state) => state === NoteState.Pending)).toBe(true);
			const cap = finaleBonusCap(controller.myTrack!.chart, controller.myTrack!.finale!);
			// A share of the judged lanes: eight notes before the lanes and the two-note final chord, 50 points each,
			// doubled on Expert. The four notes under the lanes do not count.
			expect(cap).toBeCloseTo(FINALE_BONUS_SHARE * 10 * 50 * 2);
			const expected = nextFinaleBonus(nextFinaleBonus(0, LANES, cap), LANES, cap);
			expect(hud.finaleBonus).toBeCloseTo(expected);
			expect(finalePresses().map((payload) => payload.bonus)).toEqual([
				Math.round(nextFinaleBonus(0, LANES, cap)),
				Math.round(expected),
			]);
		});

		it('banks the bonus when the final hit lands', () => {
			const {controller, send, submitIntent} = finaleSetup();
			playBeats(controller, 8);
			controller.tick(4_100);
			for (let i = 0; i < 6; i++) controller.press(i % 5, 4_200 + i * 200);
			const {hud} = controller.myTrack!;
			const collected = Math.round(hud.finaleBonus);
			playFinalChord(controller);

			expect(hud.finalHit).toBe(true);
			expect(hud.finaleOn).toBe(false);
			expect(hud.combo).toBe(9);
			expect(send).toHaveBeenCalledWith({t: 'band.finale', kind: 'final', part: 'guitar', hit: true});
			expect(controller.groupScore).toBe(hud.score + collected);
			controller.tick(8_000);
			expect(submitIntent).toHaveBeenCalledWith({
				t: 'band.result',
				result: expect.objectContaining({finaleBonus: collected, score: Math.round(hud.score + collected)}),
			});
		});

		it('loses the bonus when the final hit is missed', () => {
			const {controller, send, submitIntent} = finaleSetup();
			playBeats(controller, 8);
			controller.tick(4_100);
			controller.press(FretLane.Red, 4_500);
			controller.tick(6_500);
			const {hud} = controller.myTrack!;
			expect(hud.finaleBonus).toBeGreaterThan(0);
			expect(hud.finalHit).toBe(false);
			expect(hud.combo).toBe(0);
			expect(send).toHaveBeenCalledWith({t: 'band.finale', kind: 'final', part: 'guitar', hit: false});
			expect(controller.groupScore).toBe(hud.score);
			expect(controller.groupFinaleBonus).toBe(0);
			controller.tick(8_000);
			const [[report]] = submitIntent.mock.calls;
			expect(report).toMatchObject({t: 'band.result'});
			expect(report.t === 'band.result' && report.result).not.toHaveProperty('finaleBonus');
		});

		it('keeps the stem up through free play, even for a miss judged as it starts', () => {
			const {controller, duck} = finaleSetup();
			playBeats(controller, 7);
			controller.tick(4_100);
			expect(controller.myTrack!.noteStates[7]).toBe(NoteState.Missed);
			expect(duck).not.toHaveBeenCalled();
		});

		it('plays the charted notes when the room turned the ending off', () => {
			const {controller, hits, finalePresses} = finaleSetup({bigRockEnding: false});
			expect(controller.finale).toBeNull();
			expect(controller.myTrack?.finale).toBeNull();
			playBeats(controller, 12);
			controller.tick(5_900);
			expect(controller.finaleActive).toBe(false);
			expect(hits().map((payload) => payload.noteIndex)).toEqual([...Array(12).keys()]);
			expect(controller.myTrack!.hud.combo).toBe(12);
			expect(finalePresses()).toHaveLength(0);
		});

		it('mirrors other players’ free play and final hit', () => {
			const {controller} = finaleSetup();
			controller.tick(4_100);
			controller.receive(
				message('u2', {t: 'band.finale', kind: 'press', part: 'drums', lane: DrumLane.Kick, bonus: 90}),
			);
			const drums = controller.tracks[1];
			expect(drums.laneFlashMs[DrumLane.Kick]).toBe(4_100);
			expect(drums.hud).toMatchObject({finaleOn: true, finaleBonus: 90});
			controller.receive(message('u2', {t: 'band.finale', kind: 'final', part: 'drums', hit: true}));
			expect(drums.hud).toMatchObject({finaleBonus: 90, finalHit: true, bankedFinaleBonus: 90});
			controller.tick(4_200);
			expect(drums.hud.finaleOn).toBe(false);
			controller.receive(
				message('u2', {t: 'band.finale', kind: 'press', part: 'drums', lane: DrumLane.Red, bonus: Number.NaN}),
			);
			expect(drums.hud.finaleBonus).toBe(90);
		});
	});
});

describe('nextFinaleBonus', () => {
	it('earns less per press as the bonus nears its cap', () => {
		const short = {startMs: 0, endMs: 4_000};
		const cap = 10_000;
		let bonus = 0;
		const gains: Array<number> = [];
		for (let i = 0; i < 200; i++) {
			const next = nextFinaleBonus(bonus, short, cap);
			gains.push(next - bonus);
			bonus = next;
		}
		expect(gains[1]).toBeLessThan(gains[0]);
		expect(bonus).toBeLessThan(cap);
		expect(bonus).toBeGreaterThan(cap * 0.99);
		// Four presses a second through the ending reach about two thirds of the cap, eight about 86%.
		const after = (presses: number) => {
			let total = 0;
			for (let i = 0; i < presses; i++) total = nextFinaleBonus(total, short, cap);
			return total / cap;
		};
		expect(after(16)).toBeCloseTo(1 - (1 - 1 / 16) ** 16, 5);
		expect(after(32)).toBeGreaterThan(0.86);
		// A longer ending takes more presses to fill the same cap.
		expect(nextFinaleBonus(0, {startMs: 0, endMs: 16_000}, cap)).toBe(nextFinaleBonus(0, short, cap) / 4);
	});
});

describe('groupStars', () => {
	it('fills stars between the Rock Band thresholds', () => {
		expect(groupStars(0, 1_000)).toBe(0);
		expect(groupStars(STAR_THRESHOLDS[0] * 1_000, 1_000)).toBe(1);
		expect(groupStars(((STAR_THRESHOLDS[2] + STAR_THRESHOLDS[3]) / 2) * 1_000, 1_000)).toBeCloseTo(3.5);
		expect(groupStars(10_000, 1_000)).toBe(5);
		expect(groupStars(100, 0)).toBe(0);
	});
});

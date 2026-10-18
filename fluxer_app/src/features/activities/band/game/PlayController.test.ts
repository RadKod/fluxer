// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandHitMessage, BandIntent, BandSeat} from '@app/features/activities/band/BandProtocol';
import {buildMidi, EXPERT_NOTE_BASE} from '@app/features/activities/band/engine/BandTestFixtures';
import {DrumLane, FretLane} from '@app/features/activities/band/engine/ChartModel';
import {SongChart} from '@app/features/activities/band/engine/SongChart';
import {
	FINALE_PRESS_POINTS,
	groupStars,
	NoteState,
	PlayController,
	type PlayControllerOptions,
	STAR_THRESHOLDS,
} from '@app/features/activities/band/game/PlayController';
import type {ActivityMessage, ActivityParticipant} from '@app/features/activities/session/ActivitySessionTypes';
import {describe, expect, it, vi} from 'vitest';

const BEAT = 480;
const STAR_POWER = 116;
const FILL = 120;
const GREEN = EXPERT_NOTE_BASE + FretLane.Green;

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

// Notes for 12 beats; the drum fill from beat 8 to 12 after "[coda]" is the Big Rock Ending (4 s to 6 s).
const FINALE_SONG = SongChart.parse(
	buildMidi({
		tracks: [
			{name: 'PART GUITAR', notes: Array.from({length: 13}, (_, i) => ({tick: i * BEAT, note: GREEN}))},
			{
				name: 'PART DRUMS',
				notes: [
					...Array.from({length: 13}, (_, i) => ({tick: i * BEAT, note: EXPERT_NOTE_BASE + DrumLane.Red})),
					{tick: 8 * BEAT, note: FILL, length: 4 * BEAT},
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
	const playFinaleNote = vi.fn();
	const controller = new PlayController({
		chart: SONG,
		seats: SEATS,
		myUserId: 'me',
		songEndMs: 6_000,
		joinedAtMs: 0,
		send,
		submitIntent,
		duck,
		restore,
		playFinaleNote,
		...overrides,
	});
	const hits = () => send.mock.calls.map(([payload]) => payload).filter((payload) => payload.t === 'band.hit');
	return {controller, send, submitIntent, duck, restore, playFinaleNote, hits};
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

	it('mirrors another player from their broadcasts and ducks their stem on a miss', () => {
		const {controller, duck, restore} = setup();
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
		const {controller, duck, restore} = setup();
		controller.tick(700);
		expect(duck).toHaveBeenCalledWith('guitar');
		restore.mockClear();
		controller.press(FretLane.Green, 1_000);
		controller.tick(1_020);
		expect(restore).toHaveBeenCalledWith('guitar');
	});

	it('treats a stray press as a miss: combo gone, miss feedback and duck, no note used up', () => {
		const {controller, duck, hits} = setup();
		controller.press(FretLane.Green, 0);
		controller.release(FretLane.Green, 20);
		expect(controller.myTrack!.hud.combo).toBe(1);
		controller.press(FretLane.Blue, 250);
		const track = controller.myTrack!;
		expect(track.hud.combo).toBe(0);
		expect(track.feedback).toEqual({kind: 'miss', atMs: 250});
		expect(duck).toHaveBeenCalledWith('guitar');
		expect(hits()).toHaveLength(1);
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

		function playUpToFinale(controller: PlayController) {
			for (let i = 0; i < 8; i++) {
				controller.press(FretLane.Green, i * 500);
				controller.release(FretLane.Green, i * 500 + 20);
			}
		}

		it('turns the coda into free play that collects a bonus, banked by the final hit', () => {
			const {controller, hits, send, playFinaleNote} = setup({
				chart: FINALE_SONG,
				seats: finaleSeats,
				songEndMs: 8_000,
			});
			expect(controller.finale).toEqual({startMs: 4_000, endMs: 6_000});
			playUpToFinale(controller);
			const judged = hits().length;
			controller.tick(4_100);
			expect(controller.finaleActive).toBe(true);
			controller.press(FretLane.Red, 4_200);
			controller.press(FretLane.Red, 4_250);
			controller.press(FretLane.Blue, 4_260);
			controller.tick(5_900);
			// Free play judges nothing: no hit or miss goes out for the notes under the fill.
			expect(hits()).toHaveLength(judged);
			expect(playFinaleNote).toHaveBeenCalledTimes(3);
			const {hud} = controller.myTrack!;
			expect(hud.finaleBonus).toBe(2 * FINALE_PRESS_POINTS * 2);

			controller.press(FretLane.Green, 6_040);
			expect(hud.finalHit).toBe(true);
			expect(send).toHaveBeenLastCalledWith({t: 'band.finale', kind: 'final', part: 'guitar', hit: true});
			const scoreWithoutBonus = hud.score;
			expect(controller.groupScore).toBe(scoreWithoutBonus + hud.finaleBonus);
		});

		it('drops the bonus when the final hit is missed and shows others landing theirs', () => {
			const {controller, send} = setup({chart: FINALE_SONG, seats: finaleSeats, songEndMs: 8_000});
			playUpToFinale(controller);
			controller.press(FretLane.Red, 4_500);
			controller.tick(6_400);
			const {hud} = controller.myTrack!;
			expect(hud.finalHit).toBe(false);
			expect(send).toHaveBeenCalledWith({t: 'band.finale', kind: 'final', part: 'guitar', hit: false});
			expect(controller.groupScore).toBe(hud.score);

			controller.receive(
				message('u2', {t: 'band.finale', kind: 'press', part: 'drums', lane: DrumLane.Kick, bonus: 90}),
			);
			controller.receive(message('u2', {t: 'band.finale', kind: 'final', part: 'drums', hit: true}));
			const drums = controller.tracks[1];
			expect(drums.hud).toMatchObject({finaleBonus: 90, finalHit: true});
		});
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

// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandSeat} from '@app/features/activities/band/BandProtocol';
import {buildMidi, EXPERT_NOTE_BASE} from '@app/features/activities/band/engine/BandTestFixtures';
import {FretLane} from '@app/features/activities/band/engine/ChartModel';
import {SongChart} from '@app/features/activities/band/engine/SongChart';
import {
	PlayController,
	type PlayControllerOptions,
	STAR_POWER_PHRASE_ENERGY,
	STAR_POWER_WHAMMY_ENERGY_PER_SECOND,
} from '@app/features/activities/band/game/PlayController';
import {WHAMMY, WHAMMY_OFF} from '@app/features/activities/band/game/Whammy';
import type {ActivityMessage, ActivityParticipant} from '@app/features/activities/session/ActivitySessionTypes';
import {describe, expect, it, vi} from 'vitest';

const BEAT = 480;
const GREEN = EXPERT_NOTE_BASE + FretLane.Green;
const SOLO_MARKER = 103;
const STAR_POWER = 116;

// 120 BPM, a guitar and a bass note on every beat for 16 beats; the guitar's solo marker covers beats 4 to 12
// (2 s to 6 s), eight notes.
const SOLO_SONG = SongChart.parse(
	buildMidi({
		tracks: [
			{
				name: 'PART GUITAR',
				notes: [
					...Array.from({length: 16}, (_, i) => ({tick: i * BEAT, note: GREEN})),
					{tick: 4 * BEAT, note: SOLO_MARKER, length: 8 * BEAT},
				],
			},
			{name: 'PART BASS', notes: Array.from({length: 16}, (_, i) => ({tick: i * BEAT, note: GREEN}))},
		],
	}),
	'mid',
);

// A two-second guitar sustain at the start under a star power phrase, then plain notes.
const SUSTAIN_SONG = SongChart.parse(
	buildMidi({
		tracks: [
			{
				name: 'PART GUITAR',
				notes: [
					{tick: 0, note: GREEN, length: 4 * BEAT},
					{tick: 0, note: STAR_POWER, length: BEAT},
					...Array.from({length: 4}, (_, i) => ({tick: (6 + i) * BEAT, note: GREEN})),
				],
			},
		],
	}),
	'mid',
);

function participant(userId: string): ActivityParticipant {
	return {identity: `${userId}:c`, userId, connectionId: 'c', joinedAt: 0, isLocal: false};
}

function message(userId: string, payload: unknown): ActivityMessage {
	return {from: participant(userId), seq: 1, payload};
}

function seat(part: BandSeat['part'], userId: string, freestyleSolo = false): BandSeat {
	return {part, userId, difficulty: 'expert', ready: true, ...(freestyleSolo && {freestyleSolo})};
}

function setup(overrides: Partial<Pick<PlayControllerOptions, 'chart' | 'seats'>> = {}) {
	const options = {
		send: vi.fn<PlayControllerOptions['send']>(),
		submitIntent: vi.fn<PlayControllerOptions['submitIntent']>(),
		duck: vi.fn<PlayControllerOptions['duck']>(),
		restore: vi.fn<PlayControllerOptions['restore']>(),
		whammy: vi.fn<PlayControllerOptions['whammy']>(),
		freestyleEnded: vi.fn<PlayControllerOptions['freestyleEnded']>(),
	};
	const controller = new PlayController({
		chart: SOLO_SONG,
		seats: [seat('guitar', 'me', true), seat('bass', 'u2')],
		myUserId: 'me',
		songEndMs: 9_000,
		joinedAtMs: 0,
		bigRockEnding: true,
		playMissSound: vi.fn(),
		...options,
		...overrides,
	});
	const sent = (kind: string) =>
		options.send.mock.calls
			.map(([payload]) => payload as {readonly t: string; readonly noteIndex?: number})
			.filter((payload) => payload.t === kind);
	const result = () => {
		const [intent] = options.submitIntent.mock.calls[0];
		if (intent.t !== 'band.result') throw new Error('no result');
		return intent.result;
	};
	return {controller, options, sent, result};
}

// Presses and lets go of a lane at `ms`, ticking past the chord slop so the judge settles it.
function tap(controller: PlayController, lane: number, ms: number): void {
	controller.tick(ms);
	controller.press(lane, ms);
	controller.release(lane, ms + 10);
	controller.tick(ms + 30);
}

describe('PlayController freestyle solo', () => {
	it('leaves the solo unjudged, scores presses that follow the cue and keeps the streak going', () => {
		const {controller, options, sent, result} = setup();
		const mine = controller.myTrack;
		if (!mine) throw new Error('no track');
		expect(mine.freestyle).toHaveLength(1);
		for (let beat = 0; beat < 4; beat++) tap(controller, FretLane.Green, beat * 500);
		expect(mine.hud.combo).toBe(4);

		controller.tick(2_050);
		expect(mine.hud.freestyleOn).toBe(true);
		expect(options.restore).toHaveBeenCalledWith('guitar');
		const before = mine.hud.score;
		for (let i = 0; i < 6; i++) tap(controller, i % 5, 2_100 + i * 400);
		expect(mine.hud.combo).toBe(10);
		expect(mine.hud.multiplier).toBe(2);
		expect(mine.hud.score).toBeGreaterThan(before);
		expect(sent('band.freestyle').length).toBeGreaterThan(0);

		controller.tick(6_050);
		expect(mine.hud.freestyleOn).toBe(false);
		expect(options.freestyleEnded).toHaveBeenCalledTimes(1);
		expect(sent('band.hit').filter(({noteIndex = 0}) => noteIndex >= 4 && noteIndex < 12)).toEqual([]);
		expect(options.duck).not.toHaveBeenCalled();

		tap(controller, FretLane.Green, 6_000);
		expect(mine.hud.combo).toBe(11);
		controller.finish({stopped: true});
		expect(result().notesMissed).toBe(0);
		expect(result().notesHit).toBe(5);
		expect(result().freestylePoints).toBeGreaterThan(0);
	});

	it('plays the charted solo for a seat that kept the notes', () => {
		const {controller, options, result} = setup({seats: [seat('guitar', 'me'), seat('bass', 'u2')]});
		expect(controller.myTrack?.freestyle).toEqual([]);
		controller.tick(3_000);
		expect(options.duck).toHaveBeenCalledWith('guitar');
		controller.finish({stopped: true});
		expect(result()).not.toHaveProperty('freestylePoints');
	});

	it('mirrors a freestyle bandmate: their score, their lanes, and no duck for their late misses', () => {
		const {controller, options} = setup({seats: [seat('guitar', 'u2', true), seat('bass', 'me')]});
		const guitar = controller.tracks.find((track) => track.part === 'guitar');
		if (!guitar) throw new Error('no guitar');
		controller.tick(2_500);
		expect(guitar.hud.freestyleOn).toBe(true);
		controller.receive(message('u2', {t: 'band.freestyle', part: 'guitar', score: 4_200, combo: 14, multiplier: 2}));
		expect(guitar.hud).toMatchObject({score: 4_200, combo: 14, multiplier: 2});
		controller.receive(
			message('u2', {
				t: 'band.hit',
				part: 'guitar',
				noteIndex: 3,
				hit: false,
				combo: 0,
				multiplier: 1,
				starPower: false,
				score: 4_200,
			}),
		);
		expect(options.duck).not.toHaveBeenCalledWith('guitar');
		controller.flashRemoteLanes('u2', [3]);
		expect(guitar.laneFlashMs[3]).toBe(2_500);
		controller.receive(message('u2', {t: 'band.freestyle', part: 'guitar', score: 'lots', combo: 1, multiplier: 1}));
		expect(guitar.hud.score).toBe(4_200);
	});
});

describe('PlayController whammy', () => {
	function holdSustain(controller: PlayController) {
		controller.tick(0);
		controller.press(FretLane.Green, 0);
		controller.tick(30);
	}

	it('only bites on a held sustain, wobbles my stem and tells the band, and lets go when the sustain ends', () => {
		const {controller, options, sent} = setup({chart: SUSTAIN_SONG, seats: [seat('guitar', 'me')]});
		const mine = controller.myTrack;
		if (!mine) throw new Error('no track');
		controller.whammy(true, 0);
		expect(options.whammy).not.toHaveBeenCalled();

		holdSustain(controller);
		controller.whammy(true, 100);
		expect(options.whammy).toHaveBeenLastCalledWith('guitar', {depthCents: WHAMMY.gentleDepthCents, rateHz: 5});
		expect(mine.whammy.depthCents).toBe(WHAMMY.gentleDepthCents);
		expect(sent('band.whammy').at(-1)).toEqual({
			t: 'band.whammy',
			part: 'guitar',
			depthCents: WHAMMY.gentleDepthCents,
			rateHz: 5,
		});
		controller.tick(100 + WHAMMY.refreshMs);
		expect(sent('band.whammy')).toHaveLength(2);

		controller.tick(2_100);
		expect(options.whammy).toHaveBeenLastCalledWith('guitar', WHAMMY_OFF);
		expect(mine.whammy.depthCents).toBe(0);
	});

	it('fills star power faster while whammying a star power sustain', () => {
		const still = setup({chart: SUSTAIN_SONG, seats: [seat('guitar', 'me')]});
		const pumped = setup({chart: SUSTAIN_SONG, seats: [seat('guitar', 'me')]});
		for (const {controller} of [still, pumped]) holdSustain(controller);
		pumped.controller.whammy(true, 40);
		for (let ms = 40; ms <= 1_040; ms += 16) {
			still.controller.tick(ms);
			pumped.controller.tick(ms);
		}
		const stillEnergy = still.controller.myTrack?.hud.starPowerEnergy ?? 0;
		const pumpedEnergy = pumped.controller.myTrack?.hud.starPowerEnergy ?? 0;
		expect(stillEnergy).toBe(STAR_POWER_PHRASE_ENERGY);
		expect(pumpedEnergy - stillEnergy).toBeCloseTo(STAR_POWER_WHAMMY_ENERGY_PER_SECOND, 3);
	});

	it('wobbles a bandmate stem from their messages and lets go when they go quiet', () => {
		const {controller, options} = setup({chart: SUSTAIN_SONG, seats: [seat('guitar', 'u2'), seat('bass', 'me')]});
		controller.tick(500);
		controller.receive(message('u2', {t: 'band.whammy', part: 'guitar', depthCents: 400, rateHz: 6}));
		expect(options.whammy).toHaveBeenLastCalledWith('guitar', {depthCents: WHAMMY.maxDepthCents, rateHz: 6});
		controller.tick(500 + WHAMMY.remoteTimeoutMs - 1);
		expect(options.whammy).toHaveBeenCalledTimes(1);
		controller.tick(500 + WHAMMY.remoteTimeoutMs);
		expect(options.whammy).toHaveBeenLastCalledWith('guitar', WHAMMY_OFF);
		controller.receive(message('u2', {t: 'band.whammy', part: 'drums', depthCents: 20, rateHz: 6}));
		expect(options.whammy).toHaveBeenCalledTimes(2);
	});
});

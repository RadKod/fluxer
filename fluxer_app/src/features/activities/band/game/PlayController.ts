// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandHitMessage, BandIntent, BandPlayerResult, BandSeat} from '@app/features/activities/band/BandProtocol';
import type {BigRockEnding} from '@app/features/activities/band/engine/BigRockEnding';
import {
	type BandPart,
	type InstrumentPart,
	type NoteGroup,
	type PartChart,
	STAGE_ORDER,
} from '@app/features/activities/band/engine/ChartModel';
import {
	DIFFICULTY_SCORE_MULTIPLIER,
	type HitRating,
	Judge,
	type JudgeEvent,
	MAX_MULTIPLIER,
	multiplierForStreak,
	NOTE_POINTS,
} from '@app/features/activities/band/engine/Judge';
import type {SongChart} from '@app/features/activities/band/engine/SongChart';
import type {ActivityMessage, ActivitySendOptions} from '@app/features/activities/session/ActivitySessionTypes';
import {makeAutoObservable} from 'mobx';

// Free play during the Big Rock Ending. Not part of BandProtocol yet: lossy presses so others see and hear them, one
// reliable final message saying whether the player landed the last hit.
export type BandFinaleMessage =
	| {
			readonly t: 'band.finale';
			readonly kind: 'press';
			readonly part: BandPart;
			readonly lane: number;
			readonly bonus: number;
	  }
	| {readonly t: 'band.finale'; readonly kind: 'final'; readonly part: BandPart; readonly hit: boolean};

export const NoteState = {Pending: 0, Hit: 1, Missed: 2} as const;

// Star power: completing a phrase adds a quarter bar; from half a bar it can be deployed and doubles scoring.
export const STAR_POWER_PHRASE_ENERGY = 0.25;
export const STAR_POWER_MIN_ENERGY = 0.5;
// A full bar lasts this long once deployed.
export const STAR_POWER_FULL_BAR_MS = 16_000;

// Big Rock Ending: points per free-play press, how often one lane may score, and the final hit's window.
export const FINALE_PRESS_POINTS = 25;
export const FINALE_LANE_COOLDOWN_MS = 90;
export const FINALE_FINAL_WINDOW_MS = 150;

// Group meter per player, 0..1: hits lift it slowly, misses drop it fast.
const PERFORMANCE_START = 0.6;
const PERFORMANCE_HIT = 0.015;
const PERFORMANCE_MISS = 0.05;

// Late joiners skip notes this close to the moment they joined; nobody could have played them.
const JOIN_GRACE_MS = 300;

// Score per base score (every note hit once, no multiplier) at which each star fills, Rock Band style.
export const STAR_THRESHOLDS: ReadonlyArray<number> = [0.21, 0.46, 0.77, 1.85, 3.08];

export type FeedbackKind = HitRating | 'miss';

export function groupStars(score: number, baseScore: number): number {
	if (baseScore <= 0) return 0;
	const ratio = score / baseScore;
	let previous = 0;
	for (let star = 0; star < STAR_THRESHOLDS.length; star++) {
		const threshold = STAR_THRESHOLDS[star];
		if (ratio < threshold) return star + (ratio - previous) / (threshold - previous);
		previous = threshold;
	}
	return STAR_THRESHOLDS.length;
}

export function baseScore(chart: PartChart): number {
	const lanes = chart.groups.reduce((sum, group) => sum + group.lanes.length, 0);
	return lanes * NOTE_POINTS * DIFFICULTY_SCORE_MULTIPLIER[chart.difficulty];
}

// Index into SeatTrack.laneFlashMs; fret lanes 0..5 (open is 5), drum lanes 0..4.
function laneSlot(lane: number): number {
	return Math.min(Math.max(lane, 0), 5);
}

export function isInFinale(finale: BigRockEnding | null, msTime: number): boolean {
	return finale !== null && msTime >= finale.startMs && msTime <= finale.endMs + FINALE_FINAL_WINDOW_MS;
}

// The groups a judge scores: the finale is free play, and a late joiner cannot play what already passed. Returns the
// judged chart and, per judged group, its index in the full chart (the index every client broadcasts).
export function judgedChart(
	chart: PartChart,
	finale: BigRockEnding | null,
	fromMs: number,
): {readonly chart: PartChart; readonly fullIndex: ReadonlyArray<number>} {
	const groups: Array<NoteGroup> = [];
	const fullIndex: Array<number> = [];
	chart.groups.forEach((group, index) => {
		if (group.msTime < fromMs || isInFinale(finale, group.msTime)) return;
		groups.push(group);
		fullIndex.push(index);
	});
	return {chart: {...chart, groups}, fullIndex};
}

export function isBandHitMessage(payload: unknown): payload is BandHitMessage {
	if (typeof payload !== 'object' || payload === null) return false;
	const message = payload as Partial<BandHitMessage>;
	return (
		message.t === 'band.hit' &&
		typeof message.part === 'string' &&
		Number.isInteger(message.noteIndex) &&
		typeof message.hit === 'boolean' &&
		typeof message.combo === 'number' &&
		typeof message.multiplier === 'number' &&
		typeof message.starPower === 'boolean' &&
		typeof message.score === 'number'
	);
}

export function isBandFinaleMessage(payload: unknown): payload is BandFinaleMessage {
	if (typeof payload !== 'object' || payload === null) return false;
	const message = payload as {
		t?: unknown;
		kind?: unknown;
		part?: unknown;
		lane?: unknown;
		bonus?: unknown;
		hit?: unknown;
	};
	if (message.t !== 'band.finale' || typeof message.part !== 'string') return false;
	if (message.kind === 'press') return Number.isInteger(message.lane) && typeof message.bonus === 'number';
	return message.kind === 'final' && typeof message.hit === 'boolean';
}

// What one seat shows: observable, so the HUD around a highway re-renders only when its numbers change.
export class SeatHud {
	combo = 0;
	multiplier = 1;
	starPowerActive = false;
	// 0..1 of the bar; only known for my own seat.
	starPowerEnergy = 0;
	score = 0;
	performance = PERFORMANCE_START;
	finaleBonus = 0;
	// Null until the final hit is decided.
	finalHit: boolean | null = null;

	constructor() {
		makeAutoObservable(this);
	}

	get shownMultiplier(): number {
		return this.starPowerActive ? this.multiplier * 2 : this.multiplier;
	}
}

// Per-seat drawing state, read by the renderer every frame. Plain arrays, not observables: they change per note.
export interface SeatTrack {
	readonly seat: BandSeat;
	readonly part: InstrumentPart;
	readonly chart: PartChart;
	readonly isMine: boolean;
	readonly hud: SeatHud;
	readonly noteStates: Uint8Array;
	// Song ms until which a hit sustain is held; 0 when not held.
	readonly heldUntilMs: Float64Array;
	// Song ms of the last press or hit per lane slot (0..5), for the strike glow and free-play zones.
	readonly laneFlashMs: Float64Array;
	// Groups of star power phrases that were broken by a miss; drawn as plain notes.
	readonly brokenStarGroups: Set<number>;
	feedback: {readonly kind: FeedbackKind; readonly atMs: number} | null;
	missAtMs: number;
}

export interface PlayControllerOptions {
	readonly chart: SongChart;
	readonly seats: ReadonlyArray<BandSeat>;
	readonly myUserId: string;
	// Song ms at which the song is over and my result goes to the leader.
	readonly songEndMs: number;
	// Song ms when this client started following; above zero for a late joiner.
	readonly joinedAtMs: number;
	readonly send: (payload: unknown, options?: ActivitySendOptions) => void;
	readonly submitIntent: (intent: BandIntent) => void;
	readonly duck: (part: BandPart) => void;
	readonly playFinaleNote: (part: InstrumentPart, lane: number, mine: boolean) => void;
}

interface PhraseProgress {
	readonly groups: ReadonlyArray<number>;
	hits: number;
	broken: boolean;
}

// Runs one client's side of a song: judges my seat, broadcasts each judged note, mirrors everyone else's from their
// broadcasts, plays the Big Rock Ending and sends my result to the leader once. Times are song ms.
export class PlayController {
	readonly tracks: ReadonlyArray<SeatTrack>;
	readonly finale: BigRockEnding | null;
	readonly vocalsSeat: BandSeat | null;
	readonly myTrack: SeatTrack | null;
	readonly baseScore: number;
	finished = false;
	// Flips once when the Big Rock Ending begins, so the HUD can switch without watching the clock.
	finaleActive = false;
	nowMs = 0;

	private readonly judge: Judge | null = null;
	private readonly fullIndex: ReadonlyArray<number> = [];
	private readonly phraseOfGroup = new Map<number, PhraseProgress>();
	private readonly finaleLaneMs = new Float64Array(6).fill(Number.NEGATIVE_INFINITY);
	private starPowerUses = 0;
	private starPowerEndsMs = 0;
	private finaleResolved = false;

	constructor(private readonly options: PlayControllerOptions) {
		const {chart, seats, myUserId} = options;
		this.finale = chart.bigRockEnding;
		this.vocalsSeat = seats.find((seat) => seat.part === 'vocals') ?? null;
		const tracks: Array<SeatTrack> = [];
		for (const seat of seats) {
			if (seat.part === 'vocals') continue;
			const partChart = chart.partChart(seat.part, seat.difficulty);
			if (!partChart) continue;
			tracks.push({
				seat,
				part: seat.part,
				chart: partChart,
				isMine: seat.userId === myUserId,
				hud: new SeatHud(),
				noteStates: new Uint8Array(partChart.groups.length),
				heldUntilMs: new Float64Array(partChart.groups.length),
				laneFlashMs: new Float64Array(6).fill(Number.NEGATIVE_INFINITY),
				brokenStarGroups: new Set(),
				feedback: null,
				missAtMs: Number.NEGATIVE_INFINITY,
			});
		}
		tracks.sort((a, b) => STAGE_ORDER.indexOf(a.part) - STAGE_ORDER.indexOf(b.part));
		this.tracks = tracks;
		this.myTrack = tracks.find((track) => track.isMine) ?? null;
		this.baseScore = tracks.reduce((sum, track) => sum + baseScore(track.chart), 0);
		if (this.myTrack) {
			const fromMs = options.joinedAtMs > 0 ? options.joinedAtMs + JOIN_GRACE_MS : Number.NEGATIVE_INFINITY;
			const judged = judgedChart(this.myTrack.chart, this.finale, fromMs);
			this.judge = new Judge(judged.chart);
			this.fullIndex = judged.fullIndex;
			this.indexPhrases(this.myTrack.chart);
		}
		makeAutoObservable<PlayController, 'options' | 'judge' | 'fullIndex' | 'phraseOfGroup' | 'finaleLaneMs'>(
			this,
			{
				tracks: false,
				finale: false,
				vocalsSeat: false,
				myTrack: false,
				baseScore: false,
				nowMs: false,
				options: false,
				judge: false,
				fullIndex: false,
				phraseOfGroup: false,
				finaleLaneMs: false,
			},
			{autoBind: true},
		);
	}

	get mySeat(): BandSeat | null {
		const {myUserId, seats} = this.options;
		return seats.find((seat) => seat.userId === myUserId) ?? null;
	}

	get groupScore(): number {
		return this.tracks.reduce((sum, track) => sum + track.hud.score + this.bankedFinale(track), 0);
	}

	get groupFinaleBonus(): number {
		return this.tracks.reduce((sum, track) => sum + track.hud.finaleBonus, 0);
	}

	get groupPerformance(): number {
		if (this.tracks.length === 0) return PERFORMANCE_START;
		return this.tracks.reduce((sum, track) => sum + track.hud.performance, 0) / this.tracks.length;
	}

	get stars(): number {
		return groupStars(this.groupScore, this.baseScore);
	}

	press(lane: number, songMs: number): void {
		const track = this.myTrack;
		if (!track || !this.judge || this.finished) return;
		this.nowMs = Math.max(this.nowMs, songMs);
		const slot = laneSlot(lane);
		if (this.finale && songMs >= this.finale.startMs && !this.finaleResolved) {
			this.pressFinale(track, lane, slot, songMs);
			return;
		}
		track.laneFlashMs[slot] = songMs;
		this.handleEvents(track, this.judge.press(lane, songMs));
	}

	release(lane: number, songMs: number): void {
		if (!this.myTrack || !this.judge || this.finished) return;
		this.handleEvents(this.myTrack, this.judge.release(lane, songMs));
	}

	deployStarPower(songMs: number): void {
		const track = this.myTrack;
		if (!track || track.hud.starPowerActive || track.hud.starPowerEnergy < STAR_POWER_MIN_ENERGY) return;
		track.hud.starPowerActive = true;
		this.starPowerUses++;
		this.starPowerEndsMs = songMs + track.hud.starPowerEnergy * STAR_POWER_FULL_BAR_MS;
	}

	// Every frame with the song time the player is hearing.
	tick(songMs: number): void {
		this.nowMs = songMs;
		if (this.finale && !this.finaleActive && songMs >= this.finale.startMs) this.finaleActive = true;
		const track = this.myTrack;
		if (track && this.judge && !this.finished) {
			this.handleEvents(track, this.judge.advance(songMs));
			if (track.hud.starPowerActive) {
				const remaining = this.starPowerEndsMs - songMs;
				track.hud.starPowerEnergy = Math.max(0, remaining / STAR_POWER_FULL_BAR_MS);
				if (remaining <= 0) track.hud.starPowerActive = false;
			}
			if (this.finale && !this.finaleResolved && songMs > this.finale.endMs + FINALE_FINAL_WINDOW_MS) {
				this.resolveFinale(track, false);
			}
		}
		if (!this.finished && songMs >= this.options.songEndMs) this.finish();
	}

	receive(message: ActivityMessage): void {
		const {payload, from} = message;
		if (isBandHitMessage(payload)) {
			const track = this.remoteTrack(payload.part, from.userId);
			if (track) this.applyRemoteHit(track, payload);
		} else if (isBandFinaleMessage(payload)) {
			const track = this.remoteTrack(payload.part, from.userId);
			if (!track) return;
			if (payload.kind === 'press') {
				track.laneFlashMs[laneSlot(payload.lane)] = this.nowMs;
				track.hud.finaleBonus = Math.max(track.hud.finaleBonus, payload.bonus);
				this.options.playFinaleNote(track.part, payload.lane, false);
			} else {
				track.hud.finalHit = payload.hit;
			}
		}
	}

	// Settles what is left and sends my result to the leader; runs once.
	finish(): void {
		if (this.finished) return;
		this.finished = true;
		const seat = this.mySeat;
		if (!seat) return;
		const track = this.myTrack;
		if (track && this.judge) {
			this.handleEvents(track, this.judge.finish(), false);
			if (this.finale && !this.finaleResolved) this.resolveFinale(track, false);
		}
		this.options.submitIntent({t: 'band.result', result: this.result(seat)});
	}

	private result(seat: BandSeat): Omit<BandPlayerResult, 'userId'> {
		const track = this.myTrack;
		const snapshot = this.judge?.snapshot;
		const score = track ? track.hud.score + this.bankedFinale(track) : 0;
		const hit = snapshot ? snapshot.judgedGroups - snapshot.misses : 0;
		const missed = snapshot?.misses ?? 0;
		return {
			part: seat.part,
			difficulty: seat.difficulty,
			score: Math.round(score),
			rawScore: Math.round(score / DIFFICULTY_SCORE_MULTIPLIER[seat.difficulty]),
			accuracy: hit + missed === 0 ? 0 : hit / (hit + missed),
			bestStreak: snapshot?.maxCombo ?? 0,
			notesHit: hit,
			notesMissed: missed,
			starPowerUses: this.starPowerUses,
		};
	}

	private bankedFinale(track: SeatTrack): number {
		// The finale bonus only counts once the final hit lands, as in Rock Band.
		return track.hud.finalHit === true ? track.hud.finaleBonus : 0;
	}

	private remoteTrack(part: string, userId: string): SeatTrack | null {
		return this.tracks.find((track) => !track.isMine && track.part === part && track.seat.userId === userId) ?? null;
	}

	private applyRemoteHit(track: SeatTrack, message: BandHitMessage): void {
		const group = track.chart.groups[message.noteIndex];
		if (!group) return;
		const {hud} = track;
		hud.combo = message.combo;
		hud.multiplier = Math.min(MAX_MULTIPLIER, Math.max(1, message.multiplier));
		hud.starPowerActive = message.starPower;
		hud.score = message.score;
		if (message.hit) {
			track.noteStates[message.noteIndex] = NoteState.Hit;
			if (group.msLength > 0) track.heldUntilMs[message.noteIndex] = group.msTime + group.msLength;
			for (const lane of group.lanes) track.laneFlashMs[laneSlot(lane)] = this.nowMs;
			hud.performance = Math.min(1, hud.performance + PERFORMANCE_HIT);
		} else {
			track.noteStates[message.noteIndex] = NoteState.Missed;
			track.missAtMs = this.nowMs;
			track.feedback = {kind: 'miss', atMs: this.nowMs};
			hud.performance = Math.max(0, hud.performance - PERFORMANCE_MISS);
			this.options.duck(track.part);
		}
	}

	private handleEvents(track: SeatTrack, events: ReadonlyArray<JudgeEvent>, broadcast = true): void {
		const {hud} = track;
		for (const event of events) {
			if (event.kind === 'overhit') {
				if (event.comboBroken) hud.combo = 0;
				continue;
			}
			const index = this.fullIndex[event.groupIndex];
			const group = track.chart.groups[index];
			if (event.kind === 'sustain') {
				track.heldUntilMs[index] = 0;
				this.addPoints(hud, event.points);
				continue;
			}
			if (event.kind === 'hit') {
				track.noteStates[index] = NoteState.Hit;
				if (group.msLength > 0) track.heldUntilMs[index] = group.msTime + group.msLength;
				track.feedback = {kind: event.rating, atMs: event.timeMs};
				hud.performance = Math.min(1, hud.performance + PERFORMANCE_HIT);
				this.addPoints(hud, event.points);
				this.advancePhrase(track, index, true);
			} else {
				track.noteStates[index] = NoteState.Missed;
				track.feedback = {kind: 'miss', atMs: event.timeMs};
				hud.performance = Math.max(0, hud.performance - PERFORMANCE_MISS);
				this.advancePhrase(track, index, false);
				this.options.duck(track.part);
			}
			hud.combo = event.kind === 'hit' ? event.combo : 0;
			hud.multiplier = multiplierForStreak(hud.combo);
			if (broadcast) {
				const message: BandHitMessage = {
					t: 'band.hit',
					part: track.part,
					noteIndex: index,
					hit: event.kind === 'hit',
					combo: hud.combo,
					multiplier: hud.multiplier,
					starPower: hud.starPowerActive,
					score: Math.round(hud.score),
				};
				this.options.send(message, {reliable: false});
			}
		}
	}

	private addPoints(hud: SeatHud, points: number): void {
		hud.score += hud.starPowerActive ? points * 2 : points;
	}

	private indexPhrases(chart: PartChart): void {
		for (const span of chart.starPower) {
			const groups: Array<number> = [];
			chart.groups.forEach((group, index) => {
				if (group.tick >= span.tick && group.tick < span.tick + span.length && !isInFinale(this.finale, group.msTime))
					groups.push(index);
			});
			if (groups.length === 0) continue;
			const phrase: PhraseProgress = {groups, hits: 0, broken: false};
			for (const index of groups) this.phraseOfGroup.set(index, phrase);
		}
	}

	private advancePhrase(track: SeatTrack, index: number, hit: boolean): void {
		const phrase = this.phraseOfGroup.get(index);
		if (!phrase || phrase.broken) return;
		if (!hit) {
			phrase.broken = true;
			for (const group of phrase.groups) track.brokenStarGroups.add(group);
			return;
		}
		phrase.hits++;
		if (phrase.hits < phrase.groups.length) return;
		const {hud} = track;
		hud.starPowerEnergy = Math.min(1, hud.starPowerEnergy + STAR_POWER_PHRASE_ENERGY);
		if (hud.starPowerActive) this.starPowerEndsMs += STAR_POWER_PHRASE_ENERGY * STAR_POWER_FULL_BAR_MS;
	}

	private pressFinale(track: SeatTrack, lane: number, slot: number, songMs: number): void {
		const finale = this.finale;
		if (!finale) return;
		track.laneFlashMs[slot] = songMs;
		if (Math.abs(songMs - finale.endMs) <= FINALE_FINAL_WINDOW_MS) {
			this.options.playFinaleNote(track.part, lane, true);
			this.resolveFinale(track, true);
			return;
		}
		this.options.playFinaleNote(track.part, lane, true);
		if (songMs - this.finaleLaneMs[slot] < FINALE_LANE_COOLDOWN_MS) return;
		this.finaleLaneMs[slot] = songMs;
		track.hud.finaleBonus += Math.round(FINALE_PRESS_POINTS * DIFFICULTY_SCORE_MULTIPLIER[track.seat.difficulty]);
		const message: BandFinaleMessage = {
			t: 'band.finale',
			kind: 'press',
			part: track.part,
			lane,
			bonus: track.hud.finaleBonus,
		};
		this.options.send(message, {reliable: false});
	}

	private resolveFinale(track: SeatTrack, hit: boolean): void {
		this.finaleResolved = true;
		track.hud.finalHit = hit;
		const message: BandFinaleMessage = {t: 'band.finale', kind: 'final', part: track.part, hit};
		this.options.send(message);
	}
}

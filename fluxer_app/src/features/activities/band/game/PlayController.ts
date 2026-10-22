// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
	BandFinaleMessage,
	BandHitMessage,
	BandIntent,
	BandPlayerResult,
	BandSeat,
} from '@app/features/activities/band/BandProtocol';
import {
	type BigRockEnding,
	isFreePlayGroup,
	type PartFinale,
	partFinale,
} from '@app/features/activities/band/engine/BigRockEnding';
import {
	type BandPart,
	type InstrumentPart,
	type NoteGroup,
	type PartChart,
	STAGE_ORDER,
} from '@app/features/activities/band/engine/ChartModel';
import {
	DIFFICULTY_SCORE_MULTIPLIER,
	HIT_WINDOWS_MS,
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

export const NoteState = {Pending: 0, Hit: 1, Missed: 2} as const;

// Star power: completing a phrase adds a quarter bar; from half a bar it can be deployed and doubles scoring.
export const STAR_POWER_PHRASE_ENERGY = 0.25;
export const STAR_POWER_MIN_ENERGY = 0.5;
// A full bar lasts this long once deployed.
export const STAR_POWER_FULL_BAR_MS = 16_000;

// Big Rock Ending bonus. Its cap is a share of the part's base score (every judged note once, difficulty included),
// so it scales with the song rather than with the length of the ending. Measured on the six finale songs, a typical
// full Expert run (92% hit, mixed ratings) scores 1.2 to 1.8 times the base, about 1.4; an energetic ending (eight
// presses a second) reaches 86% of the cap, about 7% of such a run (6 to 9%). Each counted press closes a share of
// what is left of the cap, sized so four presses a second through the whole ending reach about two thirds of it:
// mashing faster earns less and less. One lane counts at most once per cooldown.
export const FINALE_BONUS_SHARE = 0.12;
export const FINALE_PRESSES_PER_SECOND = 4;
export const FINALE_LANE_COOLDOWN_MS = 90;

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

// Free-play groups score through the finale bonus instead, so they are left out.
export function baseScore(chart: PartChart, finale: PartFinale | null = null): number {
	const lanes = chart.groups.reduce(
		(sum, group, index) => (isFreePlayGroup(finale, index) ? sum : sum + group.lanes.length),
		0,
	);
	return lanes * NOTE_POINTS * DIFFICULTY_SCORE_MULTIPLIER[chart.difficulty];
}

export function finaleBonusCap(chart: PartChart, finale: PartFinale): number {
	return FINALE_BONUS_SHARE * baseScore(chart, finale);
}

export function nextFinaleBonus(bonus: number, finale: BigRockEnding, cap: number): number {
	const seconds = Math.max(0, finale.endMs - finale.startMs) / 1000;
	return bonus + (cap - bonus) / Math.max(1, FINALE_PRESSES_PER_SECOND * seconds);
}

// Index into SeatTrack.laneFlashMs; fret lanes 0..5 (open is 5), drum lanes 0..4.
function laneSlot(lane: number): number {
	return Math.min(Math.max(lane, 0), 5);
}

// Song ms where a part's free play ends: the final hit's window opens there. Presses before it are free play.
export function freePlayEndMs(finale: PartFinale, chart: PartChart): number {
	if (finale.finalIndex === null) return finale.endMs;
	return chart.groups[finale.finalIndex].msTime - HIT_WINDOWS_MS.ok;
}

// Song ms until which the HUD shows a part's ending: through the final hit's window.
function finaleShownUntilMs(finale: PartFinale, chart: PartChart): number {
	if (finale.finalIndex === null) return finale.endMs;
	return chart.groups[finale.finalIndex].msTime + HIT_WINDOWS_MS.ok;
}

export function isInFreePlay(track: SeatTrack, songMs: number): boolean {
	const {finale} = track;
	return finale !== null && songMs >= finale.startMs && songMs < freePlayEndMs(finale, track.chart);
}

// The groups a judge scores: free play is not judged, and a late joiner cannot play what already passed. Returns the
// judged chart and, per judged group, its index in the full chart (the index every client broadcasts).
export function judgedChart(
	chart: PartChart,
	finale: PartFinale | null,
	fromMs: number,
): {readonly chart: PartChart; readonly fullIndex: ReadonlyArray<number>} {
	const groups: Array<NoteGroup> = [];
	const fullIndex: Array<number> = [];
	chart.groups.forEach((group, index) => {
		if (group.msTime < fromMs || isFreePlayGroup(finale, index)) return;
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
	if (message.kind === 'press') {
		return (
			Number.isInteger(message.lane) &&
			typeof message.bonus === 'number' &&
			Number.isFinite(message.bonus) &&
			message.bonus >= 0
		);
	}
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
	// From the start of the part's Big Rock Ending until its final hit is decided or its window has passed.
	finaleOn = false;
	// Collected during free play; it counts only once the final hit lands.
	finaleBonus = 0;
	// Null until the final hit is decided.
	finalHit: boolean | null = null;

	constructor() {
		makeAutoObservable(this);
	}

	get shownMultiplier(): number {
		return this.starPowerActive ? this.multiplier * 2 : this.multiplier;
	}

	get bankedFinaleBonus(): number {
		return this.finalHit === true ? Math.round(this.finaleBonus) : 0;
	}
}

// Per-seat drawing state, read by the renderer every frame. Plain arrays, not observables: they change per note.
export interface SeatTrack {
	readonly seat: BandSeat;
	readonly part: InstrumentPart;
	readonly chart: PartChart;
	// Null when the chart has no Big Rock Ending or the room turned it off.
	readonly finale: PartFinale | null;
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
	// The room's Big Rock Ending setting; off plays the notes charted under the lanes.
	readonly bigRockEnding: boolean;
	readonly send: (payload: unknown, options?: ActivitySendOptions) => void;
	readonly submitIntent: (intent: BandIntent) => void;
	// A miss drops the part's stem until the next hit restores it, for every player in the band. Free play has no
	// misses and brings the stem back.
	readonly duck: (part: BandPart) => void;
	readonly restore: (part: BandPart) => void;
	// My own misses and overhits as they are judged; everyone hears their own mistakes, not the band's.
	readonly playMissSound: (part: InstrumentPart) => void;
}

interface PhraseProgress {
	readonly groups: ReadonlyArray<number>;
	hits: number;
	broken: boolean;
}

// Runs one client's side of a song: judges my seat, broadcasts each judged note, mirrors everyone else's from their
// broadcasts, plays the Big Rock Ending and sends my result to the leader once. Times are song ms.
//
// Big Rock Ending: each part's notes under its coda lanes are not judged. Presses there light the lanes and collect a
// bonus without touching the combo, and the part's stem plays on. The final hit after the lanes is judged like any
// note; landing it banks the bonus, missing it loses it.
export class PlayController {
	readonly tracks: ReadonlyArray<SeatTrack>;
	// The song's ending across parts, for the banner; null when no highway has one or the room turned it off.
	readonly finale: BigRockEnding | null;
	readonly vocalsSeat: BandSeat | null;
	readonly myTrack: SeatTrack | null;
	readonly baseScore: number;
	finished = false;
	nowMs = 0;

	private readonly judge: Judge | null = null;
	private readonly fullIndex: ReadonlyArray<number> = [];
	private readonly phraseOfGroup = new Map<number, PhraseProgress>();
	private readonly finaleLaneMs = new Float64Array(6).fill(Number.NEGATIVE_INFINITY);
	private readonly finaleCap: number = 0;
	private starPowerUses = 0;
	private starPowerEndsMs = 0;
	private finaleResolved = false;

	constructor(private readonly options: PlayControllerOptions) {
		const {chart, seats, myUserId} = options;
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
				finale: options.bigRockEnding ? partFinale(partChart.bigRockEnding, partChart.groups) : null,
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
		this.finale = tracks.some((track) => track.finale !== null) ? chart.bigRockEnding : null;
		this.baseScore = tracks.reduce((sum, track) => sum + baseScore(track.chart, track.finale), 0);
		if (this.myTrack) {
			const fromMs = options.joinedAtMs > 0 ? options.joinedAtMs + JOIN_GRACE_MS : Number.NEGATIVE_INFINITY;
			const judged = judgedChart(this.myTrack.chart, this.myTrack.finale, fromMs);
			this.judge = new Judge(judged.chart);
			this.fullIndex = judged.fullIndex;
			this.indexPhrases(this.myTrack);
			const {finale} = this.myTrack;
			if (finale) this.finaleCap = finaleBonusCap(this.myTrack.chart, finale);
		}
		makeAutoObservable<
			PlayController,
			'options' | 'judge' | 'fullIndex' | 'phraseOfGroup' | 'finaleLaneMs' | 'finaleCap'
		>(
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
				finaleCap: false,
			},
			{autoBind: true},
		);
	}

	get mySeat(): BandSeat | null {
		const {myUserId, seats} = this.options;
		return seats.find((seat) => seat.userId === myUserId) ?? null;
	}

	get groupScore(): number {
		return this.tracks.reduce((sum, track) => sum + track.hud.score + track.hud.bankedFinaleBonus, 0);
	}

	// Collected and still at stake: a landed final hit moves a share into the score, a missed one drops it.
	get groupFinaleBonus(): number {
		return Math.round(
			this.tracks.reduce((sum, track) => sum + (track.hud.finalHit === null ? track.hud.finaleBonus : 0), 0),
		);
	}

	// True while any highway is in its Big Rock Ending.
	get finaleActive(): boolean {
		return this.tracks.some((track) => track.hud.finaleOn);
	}

	// When the final hit falls: mine when I play a part with one, else the latest of the band's.
	get finalHitMs(): number | null {
		const timeOf = (track: SeatTrack) =>
			track.finale?.finalIndex == null ? null : track.chart.groups[track.finale.finalIndex].msTime;
		const mine = this.myTrack ? timeOf(this.myTrack) : null;
		if (mine !== null) return mine;
		const times = this.tracks.map(timeOf).filter((time) => time !== null);
		return times.length > 0 ? Math.max(...times) : (this.finale?.endMs ?? null);
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
		if (track.finale && !this.finaleResolved && isInFreePlay(track, songMs)) {
			this.pressFinale(track, track.finale, lane, slot, songMs);
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
		for (const seatTrack of this.tracks) this.followFinale(seatTrack, songMs);
		const track = this.myTrack;
		if (track && this.judge && !this.finished) {
			this.handleEvents(track, this.judge.advance(songMs));
			if (track.hud.starPowerActive) {
				const remaining = this.starPowerEndsMs - songMs;
				track.hud.starPowerEnergy = Math.max(0, remaining / STAR_POWER_FULL_BAR_MS);
				if (remaining <= 0) track.hud.starPowerActive = false;
			}
			// A part that plays nothing after its lanes has no final hit to land; the bonus is banked as they end.
			if (track.finale?.finalIndex === null && !this.finaleResolved && songMs >= track.finale.endMs) {
				this.resolveFinale(track, true);
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
			} else {
				track.hud.finalHit = payload.hit;
			}
		}
	}

	// Settles what is left and sends my result to the leader; runs once. A song stopped early (the leader ended it, or
	// the screen closed) counts only the notes that already passed, so the rest do not read as misses.
	finish({stopped = false}: {stopped?: boolean} = {}): void {
		if (this.finished) return;
		this.finished = true;
		const seat = this.mySeat;
		if (!seat) return;
		const track = this.myTrack;
		if (track && this.judge) {
			this.handleEvents(track, stopped ? this.judge.advance(this.nowMs) : this.judge.finish(), false);
			if (!stopped && track.finale && !this.finaleResolved) this.resolveFinale(track, false);
		}
		this.options.submitIntent({t: 'band.result', result: this.result(seat)});
	}

	private result(seat: BandSeat): Omit<BandPlayerResult, 'userId'> {
		const track = this.myTrack;
		const snapshot = this.judge?.snapshot;
		const finaleBonus = track?.hud.bankedFinaleBonus ?? 0;
		const score = track ? track.hud.score + finaleBonus : 0;
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
			...(finaleBonus > 0 && {finaleBonus}),
		};
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
			this.options.restore(track.part);
			track.noteStates[message.noteIndex] = NoteState.Hit;
			if (group.msLength > 0) track.heldUntilMs[message.noteIndex] = group.msTime + group.msLength;
			for (const lane of group.lanes) track.laneFlashMs[laneSlot(lane)] = this.nowMs;
			hud.performance = Math.min(1, hud.performance + PERFORMANCE_HIT);
		} else {
			track.noteStates[message.noteIndex] = NoteState.Missed;
			track.missAtMs = this.nowMs;
			track.feedback = {kind: 'miss', atMs: this.nowMs};
			hud.performance = Math.max(0, hud.performance - PERFORMANCE_MISS);
			// A late miss from before the ending must not silence the free play.
			if (!isInFreePlay(track, this.nowMs)) this.options.duck(track.part);
		}
	}

	// Switches a highway's HUD to its ending and back, and brings back a stem a miss left ducked.
	private followFinale(track: SeatTrack, songMs: number): void {
		const {finale, hud} = track;
		if (!finale) return;
		const on = hud.finalHit === null && songMs >= finale.startMs && songMs < finaleShownUntilMs(finale, track.chart);
		if (on === hud.finaleOn) return;
		hud.finaleOn = on;
		if (on) this.options.restore(track.part);
	}

	// Live judging broadcasts; settling what is left when the song ends or stops does not, and makes no sound either.
	private handleEvents(track: SeatTrack, events: ReadonlyArray<JudgeEvent>, live = true): void {
		const {hud} = track;
		for (const event of events) {
			if (event.kind === 'overhit') {
				hud.combo = 0;
				hud.multiplier = 1;
				track.feedback = {kind: 'miss', atMs: event.timeMs};
				this.signalMiss(track, live);
				continue;
			}
			const index = this.fullIndex[event.groupIndex];
			const group = track.chart.groups[index];
			if (event.kind === 'sustain') {
				track.heldUntilMs[index] = 0;
				this.addPoints(hud, event.points);
				continue;
			}
			const isFinalHit = index === track.finale?.finalIndex && !this.finaleResolved;
			if (event.kind === 'hit') {
				this.options.restore(track.part);
				track.noteStates[index] = NoteState.Hit;
				if (group.msLength > 0) track.heldUntilMs[index] = group.msTime + group.msLength;
				track.feedback = {kind: event.rating, atMs: event.timeMs};
				hud.performance = Math.min(1, hud.performance + PERFORMANCE_HIT);
				this.addPoints(hud, event.points);
				this.advancePhrase(track, index, true);
				if (isFinalHit) this.resolveFinale(track, true);
			} else {
				track.noteStates[index] = NoteState.Missed;
				track.feedback = {kind: 'miss', atMs: event.timeMs};
				hud.performance = Math.max(0, hud.performance - PERFORMANCE_MISS);
				this.advancePhrase(track, index, false);
				if (isFinalHit) this.resolveFinale(track, false);
				this.signalMiss(track, live);
			}
			hud.combo = event.kind === 'hit' ? event.combo : 0;
			hud.multiplier = multiplierForStreak(hud.combo);
			if (live) {
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

	private signalMiss(track: SeatTrack, live: boolean): void {
		if (!isInFreePlay(track, this.nowMs)) this.options.duck(track.part);
		if (live) this.options.playMissSound(track.part);
	}

	private addPoints(hud: SeatHud, points: number): void {
		hud.score += hud.starPowerActive ? points * 2 : points;
	}

	private indexPhrases({chart, finale}: SeatTrack): void {
		for (const span of chart.starPower) {
			const groups: Array<number> = [];
			chart.groups.forEach((group, index) => {
				if (group.tick >= span.tick && group.tick < span.tick + span.length && !isFreePlayGroup(finale, index))
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

	// Every press lights its lane; until the lanes end, each lane also adds to the bonus once per cooldown. Between the
	// lanes' end and the final hit's window a press only lights up, and never counts as an overhit.
	private pressFinale(track: SeatTrack, finale: PartFinale, lane: number, slot: number, songMs: number): void {
		track.laneFlashMs[slot] = songMs;
		if (songMs >= finale.endMs || songMs - this.finaleLaneMs[slot] < FINALE_LANE_COOLDOWN_MS) return;
		this.finaleLaneMs[slot] = songMs;
		const {hud} = track;
		hud.finaleBonus = nextFinaleBonus(hud.finaleBonus, finale, this.finaleCap);
		const message: BandFinaleMessage = {
			t: 'band.finale',
			kind: 'press',
			part: track.part,
			lane,
			bonus: Math.round(hud.finaleBonus),
		};
		this.options.send(message, {reliable: false});
	}

	private resolveFinale(track: SeatTrack, hit: boolean): void {
		this.finaleResolved = true;
		track.hud.finalHit = hit;
		track.hud.finaleOn = false;
		const message: BandFinaleMessage = {t: 'band.finale', kind: 'final', part: track.part, hit};
		this.options.send(message);
	}
}

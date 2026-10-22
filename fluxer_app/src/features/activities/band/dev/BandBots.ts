// SPDX-License-Identifier: AGPL-3.0-or-later

// Simulated bandmates and spectators for the local harness. Each bot is a non-leader peer of a FakeActivitySession
// and only does what a real client could: it reads the leader's BandState and sends BandIntent, BandHitMessage and
// BandCheerMessage payloads.

import {
	BAND_DIFFICULTY_MULTIPLIER,
	BAND_JAM_INSTRUMENTS,
	BAND_RATING_MAX,
	type BandCheerKind,
	type BandHitMessage,
	type BandJamInstrument,
	type BandMessage,
	type BandPlayerResult,
	type BandSeat,
	type BandSongSummary,
	type BandState,
} from '@app/features/activities/band/BandProtocol';
import type {FakeActivityPeer, FakeActivitySession} from '@app/features/activities/band/dev/FakeActivitySession';
import {isFreePlayGroup, type PartFinale} from '@app/features/activities/band/engine/BigRockEnding';
import type {BandDifficulty, BandPart} from '@app/features/activities/band/engine/ChartModel';
import {multiplierForStreak, NOTE_POINTS} from '@app/features/activities/band/engine/Judge';
import {BAND_PARTS} from '@app/features/activities/band/flow/BandRoomMachine';
import {nextFinaleBonus} from '@app/features/activities/band/game/PlayController';
import {encodeJamEvents} from '@app/features/activities/band/jam/JamMessages';
import {jamEngineInstrument} from '@app/features/activities/band/jam/JamRemotes';
import {drumNote, laneNotes} from '@app/features/activities/band/jam/JamScales';
import {action, makeObservable, observable, observableRef} from 'mobx';

export type BandBotRole = 'player' | 'spectator';

export interface BandBotSettings {
	readonly name: string;
	readonly role: BandBotRole;
	// Parts tried in order when claiming a seat; any free part of the song after these.
	readonly preferredParts: ReadonlyArray<BandPart>;
	// Null plays the group difficulty the leader picked.
	readonly difficulty: BandDifficulty | null;
	// Chance of hitting each note, 0..1.
	readonly accuracy: number;
	// Mean gap between a spectator's cheers; 0 never cheers.
	readonly cheerEveryMs: number;
	// Upper bound of the random wait before each pick, claim, ready and rating.
	readonly reactionMs: number;
}

// What a bot needs from a chart: the time (ms from song start) of each note group of its part, by group index, and
// the part's Big Rock Ending, whose notes are free play up to the final hit, with the cap of its bonus.
export interface BandBotChart {
	readonly notes: ReadonlyArray<number>;
	readonly finale: (PartFinale & {readonly bonusCap: number}) | null;
}

// Null when the song cannot be read; the bot then plays an even beat across the song's length.
export type BandBotChartProvider = (
	songId: string,
	part: BandPart,
	difficulty: BandDifficulty,
) => Promise<BandBotChart | null>;

export interface BandBotsOptions {
	readonly session: FakeActivitySession;
	readonly songs: () => ReadonlyArray<BandSongSummary>;
	readonly chart: BandBotChartProvider;
	readonly random?: () => number;
}

const DEFAULT_SETTINGS: BandBotSettings = {
	name: 'Bot',
	role: 'player',
	preferredParts: [],
	difficulty: null,
	accuracy: 0.85,
	cheerEveryMs: 6_000,
	reactionMs: 3_000,
};

const CHEER_KINDS: ReadonlyArray<BandCheerKind> = ['clap', 'fire', 'horns', 'wow'];
const PLAY_TICK_MS = 40;
// Used when the chart cannot be read: one note this often across the song's length.
const FALLBACK_NOTE_GAP_MS = 400;
const RESULT_DELAY_MS = 1_000;
// Gap between a bot's free-play presses during the Big Rock Ending; the real client's per-lane cooldown is 90 ms.
const FINALE_PRESS_GAP_MS = 150;
const FINALE_LANES = 5;
const RATING_STARS_MIN = 3;
// A seated bot readies on its own this long before the select phase ends.
const READY_LEAD_MS = 5_000;
const PICK_DELAY_MS = 4_000;
// A jamming bot plays on the eighths of the loop's tempo and rests on some of them.
const JAM_REST_CHANCE = 0.35;
const JAM_NOTE_LENGTH = 0.8;
const ANY_RANGE = {low: 0, high: 127} as const;
// Drum lanes on the eighths of one bar: kick, hat, snare, hat, kick, kick, snare, hat (lane 2 is the hi-hat).
const JAM_DRUM_BAR = [0, 2, 1, 2, 0, 0, 1, 2] as const;

interface PlayRun {
	readonly part: BandPart;
	readonly difficulty: BandDifficulty;
	readonly startAt: number;
	readonly notes: ReadonlyArray<number>;
	readonly finale: BandBotChart['finale'];
	next: number;
	finaleBonus: number;
	lastPressMs: number;
	finaleResolved: boolean;
	combo: number;
	bestStreak: number;
	rawScore: number;
	hit: number;
	missed: number;
	finished: boolean;
	reported: boolean;
}

function roundKey(state: BandState): string {
	switch (state.phase) {
		case 'pick':
			return `pick:${state.openedAt}`;
		case 'select':
			return `select:${state.songId}:${state.endsAt}`;
		case 'play':
			return `play:${state.songId}:${state.startAt}`;
		case 'results':
			return `results:${state.songId}:${state.endsAt}`;
		case 'jam':
			return `jam:${state.openedAt}`;
	}
}

function isBandState(value: unknown): value is BandState {
	return typeof value === 'object' && value !== null && typeof (value as {phase?: unknown}).phase === 'string';
}

export class BandBot {
	settings: BandBotSettings;
	// What the bot is doing right now, for the harness panel.
	activity = 'idle';

	private readonly peer: FakeActivityPeer;
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();
	private readonly unsubscribe: () => void;
	private round: string | null = null;
	private voted = false;
	private claimedPart: BandPart | null = null;
	private readySent = false;
	private loadedSent = false;
	private rated = false;
	private play: PlayRun | null = null;
	private playTimer: ReturnType<typeof setInterval> | null = null;
	private cheerTimer: ReturnType<typeof setTimeout> | null = null;
	private readyTimer: ReturnType<typeof setTimeout> | null = null;
	private jamTimer: ReturnType<typeof setInterval> | null = null;
	private jamStep = 0;
	private jamClaimed: BandJamInstrument | null = null;

	constructor(
		readonly id: number,
		settings: BandBotSettings,
		private readonly bots: BandBots,
	) {
		this.settings = settings;
		this.peer = bots.session.connectPeer(String(910_000_000_000_000_000n + BigInt(id)));
		makeObservable<BandBot, 'setActivity'>(this, {
			settings: observableRef,
			activity: observable,
			update: action,
			setActivity: action,
		});
		this.unsubscribe = this.peer.onStateChanged((state) => this.react(state));
	}

	get userId(): string {
		return this.peer.participant.userId;
	}

	update(patch: Partial<BandBotSettings>): void {
		this.settings = {...this.settings, ...patch};
		this.react(this.peer.state);
	}

	dispose(): void {
		this.unsubscribe();
		this.stopRound();
		this.peer.leave();
	}

	private react(value: unknown): void {
		if (!isBandState(value)) return;
		const key = roundKey(value);
		if (key !== this.round) {
			// Like the real play screen: a song that ends or is stopped before my report went out reports what I have.
			if (this.play && !this.play.reported) this.reportPlay(this.play);
			this.stopRound();
			this.round = key;
		}
		switch (value.phase) {
			case 'pick':
				this.reactToPick();
				return;
			case 'select':
				this.reactToSelect(value);
				return;
			case 'play':
				this.reactToPlay(value);
				return;
			case 'results':
				this.reactToResults(value);
				return;
			case 'jam':
				this.reactToJam(value);
				return;
		}
	}

	// Jam mode: a player bot takes its preferred instrument (else one by its number) and noodles in the room's key.
	private reactToJam(state: Extract<BandState, {phase: 'jam'}>): void {
		if (this.settings.role === 'spectator') {
			this.setActivity('listening');
			return;
		}
		const wanted =
			this.settings.preferredParts.find((part): part is BandJamInstrument =>
				(BAND_JAM_INSTRUMENTS as ReadonlyArray<string>).includes(part),
			) ?? BAND_JAM_INSTRUMENTS[this.id % BAND_JAM_INSTRUMENTS.length];
		const seat = state.seats.find((candidate) => candidate.userId === this.userId);
		if (seat?.instrument !== wanted) {
			if (this.jamClaimed === wanted) return;
			this.jamClaimed = wanted;
			this.setActivity(`taking ${wanted}`);
			this.later(() => this.send({t: 'band.jamInstrument', instrument: wanted}));
			return;
		}
		this.setActivity(`jamming ${seat.instrument}`);
		if (this.jamTimer) clearInterval(this.jamTimer);
		const eighthMs = 30_000 / state.backing.bpm;
		this.jamTimer = setInterval(() => this.playJamStep(state, seat.instrument, eighthMs), eighthMs);
	}

	private playJamStep(
		state: Extract<BandState, {phase: 'jam'}>,
		instrument: BandJamInstrument,
		eighthMs: number,
	): void {
		const step = this.jamStep++;
		const now = this.bots.session.clock.now();
		if (instrument === 'drums') {
			const note = drumNote(JAM_DRUM_BAR[step % JAM_DRUM_BAR.length], step % 16 === 0);
			this.peer.send(
				encodeJamEvents([
					{kind: 'noteOn', time: now, note, velocity: 0.85, pinchHarmonic: 0, powerChord: false, clean: false},
				]),
			);
			return;
		}
		if (this.bots.random() < JAM_REST_CHANCE) return;
		const engine = jamEngineInstrument(instrument);
		if (engine === 'drums') return;
		const lanes = laneNotes(engine, {key: state.key, scale: state.scale, octave: 0}, ANY_RANGE);
		const note = lanes[Math.floor(this.bots.random() * lanes.length)];
		const lengthMs = eighthMs * JAM_NOTE_LENGTH * (1 + Math.floor(this.bots.random() * 3));
		this.peer.send(
			encodeJamEvents([
				{
					kind: 'noteOn',
					time: now,
					note,
					velocity: 0.85,
					pinchHarmonic: 0,
					powerChord: instrument === 'rhythm',
					clean: false,
				},
			]),
		);
		this.later(
			() => this.peer.send(encodeJamEvents([{kind: 'noteOff', time: this.bots.session.clock.now(), note}])),
			0,
			lengthMs,
		);
	}

	// A person gets a few seconds to search before a bot votes for a random song.
	private reactToPick(): void {
		this.setActivity('voting');
		const songs = this.bots.songs();
		if (this.voted || songs.length === 0) return;
		this.voted = true;
		const songId = songs[Math.floor(this.bots.random() * songs.length)].id;
		this.later(() => this.send({t: 'band.vote', songId}), PICK_DELAY_MS);
	}

	private reactToSelect(state: Extract<BandState, {phase: 'select'}>): void {
		if (this.settings.role === 'spectator') {
			this.setActivity('watching');
			return;
		}
		const mySeat = state.seats.find((seat) => seat.userId === this.userId);
		if (!mySeat) {
			const part = this.pickPart(state.songId, state.seats);
			if (part === null) {
				this.setActivity('no free part');
				return;
			}
			if (part === this.claimedPart) return;
			this.claimedPart = part;
			this.setActivity(`claiming ${part}`);
			this.later(() => {
				this.send({t: 'band.claimSeat', part});
				if (this.settings.difficulty) this.send({t: 'band.difficulty', difficulty: this.settings.difficulty});
			});
			return;
		}
		// Bots play from the chart alone, so their package is loaded as soon as they sit; the leader refuses ready before.
		if (mySeat.loaded === false) {
			this.setActivity(`${mySeat.part} ${mySeat.difficulty}, loading`);
			if (!this.loadedSent) {
				this.loadedSent = true;
				this.later(() => this.send({t: 'band.loaded', songId: state.songId}));
			}
			return;
		}
		this.loadedSent = false;
		this.setActivity(`${mySeat.part} ${mySeat.difficulty}${mySeat.ready ? ', ready' : ''}`);
		// Cleared once the leader shows me ready, so a seat the leader unreadies (a difficulty change) readies again.
		if (mySeat.ready) {
			this.readySent = false;
			return;
		}
		if (this.readySent) return;
		// The leader starts the song once every seated player is ready, so a bot that readied at once would start it
		// before a person could pick a part. It waits until the seated people (not bots) are ready, or until the select
		// phase runs out.
		const people = state.seats.filter((seat) => !this.bots.isBot(seat.userId));
		const remainingMs = state.endsAt - this.bots.session.clock.now();
		if ((people.length === 0 || people.some((seat) => !seat.ready)) && remainingMs > READY_LEAD_MS) {
			this.setActivity(`${mySeat.part} ${mySeat.difficulty}, waiting for people`);
			if (!this.readyTimer) {
				this.readyTimer = setTimeout(() => {
					this.readyTimer = null;
					this.react(this.peer.state);
				}, remainingMs - READY_LEAD_MS);
			}
			return;
		}
		this.readySent = true;
		this.later(() => this.send({t: 'band.ready', ready: true}));
	}

	private reactToPlay(state: Extract<BandState, {phase: 'play'}>): void {
		const seat = state.seats.find((candidate) => candidate.userId === this.userId);
		if (!seat) {
			this.setActivity('watching');
			this.scheduleCheer();
			return;
		}
		if (this.play) return;
		this.setActivity(`playing ${seat.part}`);
		const run = {
			part: seat.part,
			difficulty: seat.difficulty,
			startAt: state.startAt,
			bigRockEnding: state.bigRockEnding !== false,
		};
		const round = this.round;
		void this.bots.chart(state.songId, seat.part, seat.difficulty).then(
			(chart) => this.round === round && this.startPlay(run, chart ?? this.fallbackChart(state.songId)),
			() => this.round === round && this.startPlay(run, this.fallbackChart(state.songId)),
		);
	}

	private reactToResults(state: Extract<BandState, {phase: 'results'}>): void {
		this.setActivity('rating');
		if (this.rated) return;
		this.rated = true;
		const players = state.seats.filter((seat) => seat.userId !== this.userId).map((seat) => seat.userId);
		for (const playerId of players) {
			const stars = RATING_STARS_MIN + Math.floor(this.bots.random() * (BAND_RATING_MAX - RATING_STARS_MIN + 1));
			this.later(() => this.send({t: 'band.rate', playerId, stars}));
		}
	}

	private pickPart(songId: string, seats: ReadonlyArray<BandSeat>): BandPart | null {
		const song = this.bots.songs().find((candidate) => candidate.id === songId);
		// Bots sing only when told to: vocals otherwise stay free for a person to test the mic part.
		const sings = this.settings.preferredParts.includes('vocals');
		const available = BAND_PARTS.filter(
			(part) => (part !== 'vocals' || sings) && (!song || (song.parts[part]?.length ?? 0) > 0),
		);
		const taken = new Set(seats.map((seat) => seat.part));
		const order = [...this.settings.preferredParts, ...BAND_PARTS];
		return order.find((part) => available.includes(part) && !taken.has(part)) ?? null;
	}

	private fallbackChart(songId: string): BandBotChart {
		const lengthMs = this.bots.songs().find((song) => song.id === songId)?.lengthMs ?? 60_000;
		const notes: Array<number> = [];
		for (let at = 2_000; at < lengthMs; at += FALLBACK_NOTE_GAP_MS) notes.push(at);
		return {notes, finale: null};
	}

	private startPlay(
		{bigRockEnding, ...run}: {part: BandPart; difficulty: BandDifficulty; startAt: number; bigRockEnding: boolean},
		chart: BandBotChart,
	): void {
		const finale = bigRockEnding ? chart.finale : null;
		this.play = {
			...run,
			notes: chart.notes,
			finale,
			next: 0,
			finaleBonus: 0,
			lastPressMs: Number.NEGATIVE_INFINITY,
			finaleResolved: finale === null,
			combo: 0,
			bestStreak: 0,
			rawScore: 0,
			hit: 0,
			missed: 0,
			finished: false,
			reported: false,
		};
		this.playTimer = setInterval(() => this.tickPlay(), PLAY_TICK_MS);
	}

	// A late joiner's notes before "now" are skipped, as the real client seeks into the song.
	private tickPlay(): void {
		const play = this.play;
		if (!play || play.finished) return;
		const songMs = this.bots.session.clock.now() - play.startAt;
		if (play.next === 0) {
			while (play.next < play.notes.length && play.notes[play.next] < songMs - 1_000) play.next += 1;
		}
		while (play.next < play.notes.length && play.notes[play.next] <= songMs) {
			if (isFreePlayGroup(play.finale, play.next)) {
				play.next += 1;
				continue;
			}
			const hit = this.bots.random() < this.settings.accuracy;
			const multiplier = multiplierForStreak(play.combo);
			if (hit) {
				play.combo += 1;
				play.hit += 1;
				play.rawScore += NOTE_POINTS * multiplier;
				play.bestStreak = Math.max(play.bestStreak, play.combo);
			} else {
				play.combo = 0;
				play.missed += 1;
			}
			const message: BandHitMessage = {
				t: 'band.hit',
				part: play.part,
				noteIndex: play.next,
				hit,
				combo: play.combo,
				multiplier: multiplierForStreak(play.combo),
				starPower: false,
				score: Math.round(play.rawScore * BAND_DIFFICULTY_MULTIPLIER[play.difficulty]),
			};
			this.peer.send(message, {reliable: false});
			if (play.next === play.finale?.finalIndex) this.resolveFinale(play, hit);
			play.next += 1;
		}
		this.playFinale(play, songMs);
		if (play.next >= play.notes.length && play.finaleResolved) this.finishPlay(play);
	}

	// Free play: lossy presses on random lanes while the lanes run. The final hit is judged with the notes and banks the
	// bonus when it lands; a part with no final hit banks it as the lanes end.
	private playFinale(play: PlayRun, songMs: number): void {
		const finale = play.finale;
		if (!finale || play.finaleResolved || songMs < finale.startMs) return;
		if (songMs >= finale.endMs) {
			if (finale.finalIndex === null) this.resolveFinale(play, true);
			return;
		}
		if (songMs - play.lastPressMs < FINALE_PRESS_GAP_MS) return;
		play.lastPressMs = songMs;
		play.finaleBonus = nextFinaleBonus(play.finaleBonus, finale, finale.bonusCap);
		const lane = Math.floor(this.bots.random() * FINALE_LANES);
		this.peer.send(
			{t: 'band.finale', kind: 'press', part: play.part, lane, bonus: Math.round(play.finaleBonus)},
			{reliable: false},
		);
	}

	private resolveFinale(play: PlayRun, hit: boolean): void {
		play.finaleResolved = true;
		if (hit) {
			play.finaleBonus = Math.round(play.finaleBonus);
			play.rawScore += play.finaleBonus / BAND_DIFFICULTY_MULTIPLIER[play.difficulty];
		} else {
			play.finaleBonus = 0;
		}
		this.peer.send({t: 'band.finale', kind: 'final', part: play.part, hit});
	}

	private finishPlay(play: PlayRun): void {
		play.finished = true;
		if (this.playTimer) clearInterval(this.playTimer);
		this.playTimer = null;
		this.setActivity(`done ${play.part}`);
		this.later(() => this.reportPlay(play), RESULT_DELAY_MS);
	}

	private reportPlay(play: PlayRun): void {
		play.finished = true;
		play.reported = true;
		const judged = play.hit + play.missed;
		const result: Omit<BandPlayerResult, 'userId'> = {
			part: play.part,
			difficulty: play.difficulty,
			score: Math.round(play.rawScore * BAND_DIFFICULTY_MULTIPLIER[play.difficulty]),
			rawScore: Math.round(play.rawScore),
			accuracy: judged === 0 ? 0 : play.hit / judged,
			bestStreak: play.bestStreak,
			notesHit: play.hit,
			notesMissed: play.missed,
			starPowerUses: 0,
			...(play.finaleResolved && play.finaleBonus > 0 && {finaleBonus: play.finaleBonus}),
		};
		this.sendToLeader({t: 'band.result', result});
	}

	private scheduleCheer(): void {
		if (this.cheerTimer || this.settings.cheerEveryMs <= 0) return;
		const wait = this.settings.cheerEveryMs * (0.5 + this.bots.random());
		this.cheerTimer = setTimeout(() => {
			this.cheerTimer = null;
			const kind = CHEER_KINDS[Math.floor(this.bots.random() * CHEER_KINDS.length)];
			this.send({t: 'band.cheer', kind});
			if (isBandState(this.peer.state) && this.peer.state.phase === 'play') this.scheduleCheer();
		}, wait);
	}

	private send(message: BandMessage): void {
		this.peer.send(message);
	}

	private sendToLeader(message: BandMessage): void {
		const leader = this.bots.session.leader;
		this.peer.send(message, leader ? {to: [leader.identity]} : undefined);
	}

	private later(run: () => void, minimumMs = 0, exactMs: number | null = null): void {
		const timer = setTimeout(
			() => {
				this.timers.delete(timer);
				run();
			},
			exactMs ?? minimumMs + this.bots.random() * this.settings.reactionMs,
		);
		this.timers.add(timer);
	}

	private stopRound(): void {
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
		if (this.playTimer) clearInterval(this.playTimer);
		if (this.cheerTimer) clearTimeout(this.cheerTimer);
		if (this.readyTimer) clearTimeout(this.readyTimer);
		if (this.jamTimer) clearInterval(this.jamTimer);
		this.jamTimer = null;
		this.jamStep = 0;
		this.jamClaimed = null;
		this.playTimer = null;
		this.cheerTimer = null;
		this.readyTimer = null;
		this.play = null;
		this.voted = false;
		this.claimedPart = null;
		this.readySent = false;
		this.loadedSent = false;
		this.rated = false;
	}

	private setActivity(activity: string): void {
		this.activity = activity;
	}
}

export class BandBots {
	bots: ReadonlyArray<BandBot> = [];
	readonly session: FakeActivitySession;
	readonly songs: () => ReadonlyArray<BandSongSummary>;
	readonly chart: BandBotChartProvider;
	readonly random: () => number;
	private nextId = 1;

	constructor({session, songs, chart, random = Math.random}: BandBotsOptions) {
		this.session = session;
		this.songs = songs;
		this.chart = chart;
		this.random = random;
		makeObservable(this, {bots: observableRef, add: action, remove: action, clear: action});
	}

	add(settings: Partial<BandBotSettings> = {}): BandBot {
		const id = this.nextId++;
		const bot = new BandBot(id, {...DEFAULT_SETTINGS, name: `Bot ${id}`, ...settings}, this);
		this.bots = [...this.bots, bot];
		return bot;
	}

	remove(bot: BandBot): void {
		bot.dispose();
		this.bots = this.bots.filter((candidate) => candidate !== bot);
	}

	clear(): void {
		for (const bot of this.bots) bot.dispose();
		this.bots = [];
	}

	isBot(userId: string): boolean {
		return this.bots.some((bot) => bot.userId === userId);
	}

	nameOf(userId: string): string | null {
		return this.bots.find((bot) => bot.userId === userId)?.settings.name ?? null;
	}
}

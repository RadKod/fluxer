// SPDX-License-Identifier: AGPL-3.0-or-later

// The room's rules, run only on the leader: one pure reducer for intents and one tick for the clock. Both return the
// same object when nothing changed, so the caller can skip a broadcast by reference.

import {
	BAND_DIFFICULTY_MULTIPLIER,
	BAND_PHASE_MS,
	BAND_RATING_MAX,
	BAND_RATING_MIN,
	BAND_RESULT_WAIT_MS,
	BAND_SUGGESTIONS,
	type BandIntent,
	type BandPlayerResult,
	type BandSeat,
	type BandSongSummary,
	type BandState,
	type BandVote,
} from '@app/features/activities/band/BandProtocol';
import {BAND_DIFFICULTIES, type BandDifficulty, type BandPart} from '@app/features/activities/band/engine/ChartModel';

export const BAND_PARTS: ReadonlyArray<BandPart> = ['guitar', 'rhythm', 'bass', 'drums', 'keys', 'vocals'];
export const BAND_DEFAULT_GROUP_DIFFICULTY: BandDifficulty = 'medium';
// The song ends once every present player has reported, or this long after the index length at the latest. Every client
// reports on its own clock: the chart can run past the index length (a final chord held over the fade, a Big Rock
// Ending) and audio output and input latency push it later still, so the margin is generous; it only matters when
// someone never reports.
export const BAND_PLAY_GRACE_MS = 10_000;

export interface BandRoomContext {
	// User id of the session leader; only it may skip a phase or pick the group difficulty.
	readonly leaderId: string | null;
	// User ids with at least one connection in the room.
	readonly presentUserIds: ReadonlySet<string>;
	// The song library in index order; empty until the index has loaded.
	readonly songs: ReadonlyMap<string, BandSongSummary>;
}

type PickState = Extract<BandState, {phase: 'pick'}>;
type SelectState = Extract<BandState, {phase: 'select'}>;
type ResultsState = Extract<BandState, {phase: 'results'}>;
// Results that arrive while the song still plays ride along in the play state until it ends. The field is not part of
// the shared protocol; clients that do not know it ignore it.
export type BandPlayState = Extract<BandState, {phase: 'play'}> & {
	readonly results?: ReadonlyArray<BandPlayerResult>;
};

export function songPartDifficulties(song: BandSongSummary | undefined, part: BandPart): ReadonlyArray<BandDifficulty> {
	return song?.parts[part] ?? [];
}

export function songPlayableParts(song: BandSongSummary | undefined): Array<BandPart> {
	return BAND_PARTS.filter((part) => songPartDifficulties(song, part).length > 0);
}

// The wanted difficulty when the chart has it, else the nearest charted one (the easier on a tie); null when the part
// has no chart.
export function clampDifficulty(wanted: BandDifficulty, offered: ReadonlyArray<BandDifficulty>): BandDifficulty | null {
	if (offered.includes(wanted)) return wanted;
	const target = BAND_DIFFICULTIES.indexOf(wanted);
	let best: BandDifficulty | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const difficulty of BAND_DIFFICULTIES) {
		if (!offered.includes(difficulty)) continue;
		const distance = Math.abs(BAND_DIFFICULTIES.indexOf(difficulty) - target);
		if (distance < bestDistance) {
			best = difficulty;
			bestDistance = distance;
		}
	}
	return best;
}

function hashSeed(seed: number, songId: string): number {
	let hash = 0x811c9dc5 ^ (seed >>> 0);
	for (let i = 0; i < songId.length; i++) {
		hash ^= songId.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

// Library songs shuffled by the seed, so every round differs but the leader's choice is reproducible.
export function pickSuggestions(
	songs: ReadonlyMap<string, BandSongSummary>,
	excludeSongId: string | null,
	seed: number,
): Array<string> {
	return [...songs.keys()]
		.filter((songId) => songId !== excludeSongId)
		.sort((a, b) => hashSeed(seed, a) - hashSeed(seed, b) || a.localeCompare(b))
		.slice(0, BAND_SUGGESTIONS);
}

export function createBandRoomState(now: number, ctx: BandRoomContext): BandState {
	return startPick(null, now, ctx);
}

function startPick(excludeSongId: string | null, now: number, ctx: BandRoomContext): PickState {
	return {
		phase: 'pick',
		suggestions: pickSuggestions(ctx.songs, excludeSongId, now),
		votes: [],
		openedAt: now,
		endsAt: null,
	};
}

export interface BandVoteTally {
	readonly songId: string;
	readonly voterIds: ReadonlyArray<string>;
}

// Voted songs by vote count; on a tie, the song whose standing votes started first.
export function tallyVotes(votes: ReadonlyArray<BandVote>): Array<BandVoteTally> {
	const bySong = new Map<string, Array<string>>();
	for (const vote of votes) {
		const voters = bySong.get(vote.songId);
		if (voters) voters.push(vote.userId);
		else bySong.set(vote.songId, [vote.userId]);
	}
	return [...bySong]
		.map(([songId, voterIds]) => ({songId, voterIds}))
		.sort((a, b) => b.voterIds.length - a.voterIds.length);
}

// The first vote starts the countdown, the last one taken back stops it.
function withVotes(state: PickState, votes: ReadonlyArray<BandVote>, now: number): PickState {
	return {...state, votes, endsAt: votes.length === 0 ? null : (state.endsAt ?? now + BAND_PHASE_MS.pick)};
}

function castVote(state: PickState, songId: string, fromUserId: string, now: number, ctx: BandRoomContext): PickState {
	if (!ctx.songs.has(songId)) return state;
	const mine = state.votes.find((vote) => vote.userId === fromUserId);
	const others = state.votes.filter((vote) => vote !== mine);
	return withVotes(state, mine?.songId === songId ? others : [...others, {userId: fromUserId, songId}], now);
}

function resolvePick(state: PickState, now: number): BandState {
	const [leading] = tallyVotes(state.votes);
	return leading ? startSelect(leading.songId, now) : state;
}

function dropAbsentVoters(state: PickState, now: number, ctx: BandRoomContext): PickState {
	const votes = state.votes.filter((vote) => ctx.presentUserIds.has(vote.userId));
	return votes.length === state.votes.length ? state : withVotes(state, votes, now);
}

function startSelect(songId: string, now: number): SelectState {
	return {
		phase: 'select',
		songId,
		groupDifficulty: BAND_DEFAULT_GROUP_DIFFICULTY,
		seats: [],
		watching: [],
		endsAt: now + BAND_PHASE_MS.select,
	};
}

function presentSeats(seats: ReadonlyArray<BandSeat>, ctx: BandRoomContext): Array<BandSeat> {
	return seats.filter((seat) => ctx.presentUserIds.has(seat.userId));
}

function startPlay(state: SelectState, now: number, ctx: BandRoomContext): BandState {
	const seats = presentSeats(state.seats, ctx);
	if (seats.length === 0) return startPick(state.songId, now, ctx);
	return {
		phase: 'play',
		songId: state.songId,
		seats,
		startAt: now + BAND_PHASE_MS.countdown,
	};
}

// Early start: everyone in the room has said so, either from a ready seat or by choosing to watch. Someone who has
// done neither (a late joiner too) holds the start until the timer runs out.
function startPlayWhenAllDecided(state: SelectState, now: number, ctx: BandRoomContext): BandState {
	const watching = new Set(state.watching);
	const readySeats = new Set(state.seats.filter((seat) => seat.ready).map((seat) => seat.userId));
	for (const userId of ctx.presentUserIds) if (!watching.has(userId) && !readySeats.has(userId)) return state;
	return startPlay(state, now, ctx);
}

export function playResults(state: BandPlayState): ReadonlyArray<BandPlayerResult> {
	return state.results ?? [];
}

// The results screen waits this long for a missing score, then shows that player without one.
export function resultsWaitEndsAt(state: ResultsState): number {
	return state.endsAt - BAND_PHASE_MS.results + BAND_RESULT_WAIT_MS;
}

function endPlay(state: BandPlayState, now: number): ResultsState {
	return {
		phase: 'results',
		songId: state.songId,
		seats: state.seats,
		results: playResults(state),
		ratings: {},
		endsAt: now + BAND_PHASE_MS.results,
	};
}

function everyPresentPlayerReported(state: BandPlayState, ctx: BandRoomContext): boolean {
	const reported = new Set(playResults(state).map((result) => result.userId));
	return presentSeats(state.seats, ctx).every((seat) => reported.has(seat.userId));
}

function claimSeat(state: SelectState, part: BandPart | null, fromUserId: string, ctx: BandRoomContext): SelectState {
	const current = state.seats.find((seat) => seat.userId === fromUserId);
	if (part === null) {
		if (!current && state.watching.includes(fromUserId)) return state;
		return {
			...state,
			seats: state.seats.filter((seat) => seat !== current),
			watching: state.watching.includes(fromUserId) ? state.watching : [...state.watching, fromUserId],
		};
	}
	if (current?.part === part) return state;
	if (state.seats.some((seat) => seat.part === part)) return state;
	const difficulty = clampDifficulty(state.groupDifficulty, songPartDifficulties(ctx.songs.get(state.songId), part));
	if (!difficulty) return state;
	const seats = state.seats.filter((seat) => seat !== current);
	seats.push({part, userId: fromUserId, difficulty, ready: false});
	seats.sort((a, b) => BAND_PARTS.indexOf(a.part) - BAND_PARTS.indexOf(b.part));
	return {...state, seats, watching: state.watching.filter((userId) => userId !== fromUserId)};
}

function updateSeat(state: SelectState, fromUserId: string, update: (seat: BandSeat) => BandSeat): SelectState {
	const current = state.seats.find((seat) => seat.userId === fromUserId);
	if (!current) return state;
	const next = update(current);
	if (next.difficulty === current.difficulty && next.ready === current.ready) return state;
	return {...state, seats: state.seats.map((seat) => (seat === current ? next : seat))};
}

function setSeatDifficulty(
	state: SelectState,
	difficulty: BandDifficulty,
	fromUserId: string,
	ctx: BandRoomContext,
): SelectState {
	const song = ctx.songs.get(state.songId);
	return updateSeat(state, fromUserId, (seat) => {
		const clamped = clampDifficulty(difficulty, songPartDifficulties(song, seat.part));
		return clamped ? {...seat, difficulty: clamped} : seat;
	});
}

// A seat still on the old group difficulty never picked its own, so it follows the group; the others keep theirs.
function setGroupDifficulty(state: SelectState, difficulty: BandDifficulty, ctx: BandRoomContext): SelectState {
	if (difficulty === state.groupDifficulty) return state;
	const song = ctx.songs.get(state.songId);
	const seats = state.seats.map((seat) => {
		const offered = songPartDifficulties(song, seat.part);
		if (seat.difficulty !== clampDifficulty(state.groupDifficulty, offered)) return seat;
		const next = clampDifficulty(difficulty, offered);
		return next && next !== seat.difficulty ? {...seat, difficulty: next} : seat;
	});
	return {...state, groupDifficulty: difficulty, seats};
}

function finite(value: number, min = 0): number {
	return Number.isFinite(value) ? Math.max(min, value) : min;
}

function count(value: number): number {
	return Math.round(finite(value));
}

// The seat, not the payload, says which part and difficulty the result belongs to, and the score is recomputed from
// the raw score so the multiplier always matches the seat.
function acceptResult(
	results: ReadonlyArray<BandPlayerResult>,
	seats: ReadonlyArray<BandSeat>,
	payload: Omit<BandPlayerResult, 'userId'>,
	fromUserId: string,
): ReadonlyArray<BandPlayerResult> | null {
	const seat = seats.find((candidate) => candidate.userId === fromUserId);
	if (!seat || results.some((result) => result.userId === fromUserId)) return null;
	const rawScore = count(payload.rawScore);
	const result: BandPlayerResult = {
		userId: fromUserId,
		part: seat.part,
		difficulty: seat.difficulty,
		score: Math.round(rawScore * BAND_DIFFICULTY_MULTIPLIER[seat.difficulty]),
		rawScore,
		accuracy: Math.min(1, finite(payload.accuracy)),
		bestStreak: count(payload.bestStreak),
		notesHit: count(payload.notesHit),
		notesMissed: count(payload.notesMissed),
		starPowerUses: count(payload.starPowerUses),
	};
	const next = [...results, result];
	next.sort((a, b) => BAND_PARTS.indexOf(a.part) - BAND_PARTS.indexOf(b.part));
	return next;
}

function rate(state: ResultsState, playerId: string, stars: number, fromUserId: string): BandState {
	if (playerId === fromUserId || !Number.isInteger(stars)) return state;
	if (stars < BAND_RATING_MIN || stars > BAND_RATING_MAX) return state;
	if (!state.seats.some((seat) => seat.userId === playerId)) return state;
	const mine = state.ratings[fromUserId] ?? {};
	if (mine[playerId] === stars) return state;
	return {...state, ratings: {...state.ratings, [fromUserId]: {...mine, [playerId]: stars}}};
}

function skip(state: BandState, now: number, ctx: BandRoomContext): BandState {
	switch (state.phase) {
		case 'pick':
			return resolvePick(state, now);
		case 'select':
			return startPlay(state, now, ctx);
		case 'play':
			return endPlay(state, now);
		case 'results':
			return startPick(state.songId, now, ctx);
	}
}

export function reduceBandIntent(
	state: BandState,
	intent: BandIntent,
	fromUserId: string,
	now: number,
	ctx: BandRoomContext,
): BandState {
	const fromLeader = ctx.leaderId !== null && fromUserId === ctx.leaderId;
	switch (intent.t) {
		case 'band.vote':
			return state.phase === 'pick' ? castVote(state, intent.songId, fromUserId, now, ctx) : state;
		case 'band.playNow':
			return state.phase === 'pick' && fromLeader && ctx.songs.has(intent.songId)
				? startSelect(intent.songId, now)
				: state;
		case 'band.pickAnother':
			return state.phase === 'select' && fromLeader ? startPick(state.songId, now, ctx) : state;
		case 'band.claimSeat':
			return state.phase === 'select'
				? startPlayWhenAllDecided(claimSeat(state, intent.part, fromUserId, ctx), now, ctx)
				: state;
		case 'band.difficulty':
			return state.phase === 'select' ? setSeatDifficulty(state, intent.difficulty, fromUserId, ctx) : state;
		case 'band.groupDifficulty':
			return state.phase === 'select' && fromLeader ? setGroupDifficulty(state, intent.difficulty, ctx) : state;
		case 'band.ready': {
			if (state.phase !== 'select') return state;
			return startPlayWhenAllDecided(
				updateSeat(state, fromUserId, (seat) => ({...seat, ready: intent.ready})),
				now,
				ctx,
			);
		}
		case 'band.result': {
			if (state.phase === 'play') {
				const results = acceptResult(playResults(state), state.seats, intent.result, fromUserId);
				if (!results) return state;
				const next: BandPlayState = {...state, results};
				return everyPresentPlayerReported(next, ctx) ? endPlay(next, now) : next;
			}
			if (state.phase === 'results') {
				const results = acceptResult(state.results, state.seats, intent.result, fromUserId);
				return results ? {...state, results} : state;
			}
			return state;
		}
		case 'band.rate':
			return state.phase === 'results' ? rate(state, intent.playerId, intent.stars, fromUserId) : state;
		case 'band.skip':
			return fromLeader ? skip(state, now, ctx) : state;
	}
}

function dropAbsent(state: SelectState, ctx: BandRoomContext): SelectState {
	const seats = presentSeats(state.seats, ctx);
	const watching = state.watching.filter((userId) => ctx.presentUserIds.has(userId));
	if (seats.length === state.seats.length && watching.length === state.watching.length) return state;
	return {...state, seats, watching};
}

export function tickBandRoom(state: BandState, now: number, ctx: BandRoomContext): BandState {
	switch (state.phase) {
		case 'pick': {
			// Opened while the library was still loading: suggestions arrive with it.
			if (state.suggestions.length === 0 && ctx.songs.size > 0) {
				return {...state, suggestions: pickSuggestions(ctx.songs, null, now)};
			}
			const next = dropAbsentVoters(state, now, ctx);
			return next.endsAt !== null && now >= next.endsAt ? resolvePick(next, now) : next;
		}
		case 'select': {
			const next = dropAbsent(state, ctx);
			if (now >= next.endsAt) return startPlay(next, now, ctx);
			return startPlayWhenAllDecided(next, now, ctx);
		}
		case 'play': {
			if (everyPresentPlayerReported(state, ctx)) return endPlay(state, now);
			// Without the song's length (a new leader still loading the index) only results or a skip end the song.
			const song = ctx.songs.get(state.songId);
			if (song && now >= state.startAt + song.lengthMs + BAND_PLAY_GRACE_MS) return endPlay(state, now);
			return state;
		}
		case 'results':
			return now >= state.endsAt ? startPick(state.songId, now, ctx) : state;
	}
}

// A state from an older client (its phase unknown here) is not a room state, so a new leader opens a fresh one.
const PHASES = new Set<string>(['pick', 'select', 'play', 'results']);

export function isBandState(value: unknown): value is BandState {
	if (typeof value !== 'object' || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.phase === 'string' && PHASES.has(record.phase);
}

function isPart(value: unknown): value is BandPart {
	return typeof value === 'string' && (BAND_PARTS as ReadonlyArray<string>).includes(value);
}

function isDifficulty(value: unknown): value is BandDifficulty {
	return typeof value === 'string' && (BAND_DIFFICULTIES as ReadonlyArray<string>).includes(value);
}

function isNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function isId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

function parseResult(value: unknown): Omit<BandPlayerResult, 'userId'> | null {
	if (typeof value !== 'object' || value === null) return null;
	const record = value as Record<string, unknown>;
	const numbers = ['score', 'rawScore', 'accuracy', 'bestStreak', 'notesHit', 'notesMissed', 'starPowerUses'] as const;
	if (!isPart(record.part) || !isDifficulty(record.difficulty)) return null;
	if (!numbers.every((key) => isNumber(record[key]))) return null;
	return {
		part: record.part,
		difficulty: record.difficulty,
		score: record.score as number,
		rawScore: record.rawScore as number,
		accuracy: record.accuracy as number,
		bestStreak: record.bestStreak as number,
		notesHit: record.notesHit as number,
		notesMissed: record.notesMissed as number,
		starPowerUses: record.starPowerUses as number,
	};
}

// Messages come from other clients; anything that is not a well-formed intent is dropped here.
export function parseBandIntent(payload: unknown): BandIntent | null {
	if (typeof payload !== 'object' || payload === null) return null;
	const record = payload as Record<string, unknown>;
	switch (record.t) {
		case 'band.vote':
		case 'band.playNow':
			return isId(record.songId) ? {t: record.t, songId: record.songId} : null;
		case 'band.pickAnother':
			return {t: 'band.pickAnother'};
		case 'band.claimSeat':
			return record.part === null || isPart(record.part) ? {t: 'band.claimSeat', part: record.part} : null;
		case 'band.difficulty':
		case 'band.groupDifficulty':
			return isDifficulty(record.difficulty) ? {t: record.t, difficulty: record.difficulty} : null;
		case 'band.ready':
			return typeof record.ready === 'boolean' ? {t: 'band.ready', ready: record.ready} : null;
		case 'band.result': {
			const result = parseResult(record.result);
			return result ? {t: 'band.result', result} : null;
		}
		case 'band.rate':
			return isId(record.playerId) && isNumber(record.stars)
				? {t: 'band.rate', playerId: record.playerId, stars: record.stars}
				: null;
		case 'band.skip':
			return {t: 'band.skip'};
		default:
			return null;
	}
}

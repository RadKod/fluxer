// SPDX-License-Identifier: AGPL-3.0-or-later

export const TABLE_GAME_KINDS = ['okey', 'okey101', 'chess', 'dama', 'dama_normal', 'tavla'] as const;

// A table a newer build set up can carry a kind this build has no board, seats or name for.
export function isKnownTableGameKind(game: string): game is (typeof TABLE_GAME_KINDS)[number] {
	return (TABLE_GAME_KINDS as ReadonlyArray<string>).includes(game);
}

export const TABLE_GAME_SPEEDS = ['fast', 'normal', 'slow'] as const;

// Okey, 101 and tavla: per turn. Chess and both damas: each player's whole clock (TABLE_GAME_CLOCK_KINDS).
export const TABLE_GAME_TURN_MS = {
	okey: {fast: 15_000, normal: 30_000, slow: 60_000},
	okey101: {fast: 25_000, normal: 45_000, slow: 90_000},
	chess: {fast: 180_000, normal: 600_000, slow: 1_800_000},
	dama: {fast: 180_000, normal: 600_000, slow: 1_800_000},
	dama_normal: {fast: 180_000, normal: 600_000, slow: 1_800_000},
	tavla: {fast: 20_000, normal: 40_000, slow: 90_000},
} as const;

export const TABLE_GAME_POSITIONS = {
	okey: [1, 2, 3, 4],
	okey101: [1, 2, 3, 4],
	chess: [1, 3],
	dama: [1, 3],
	dama_normal: [1, 3],
	tavla: [1, 3],
} as const;
export const TABLE_GAME_CLOCK_KINDS = ['chess', 'dama', 'dama_normal'] as const;

// Upper bounds that keep move generation and request validation bounded.
export const DAMA_PATH_MAX = 17;
// Measured by DamaProperty's constructed worst cases: at most 547 distinct capture results and
// 240k capture search states per generation (plain moves never exceed 188); both with about 2x margin.
export const DAMA_LEGAL_PATHS_MAX = 1024;
export const DAMA_SEARCH_NODE_BUDGET = 500_000;
export const TAVLA_MOVES_MAX = 4;
export const TAVLA_CHECKERS = 15;
export const TAVLA_LEGAL_SEQUENCES_MAX = 3060;

const DAMA_SQUARE = /^([a-h])([1-8])$/;

// Dama board string: 64 chars, rows a8..h8, a7..h7, …, a1..h1; '.' empty, 'w'/'b' man, 'W'/'B' king.
export function damaSquareIndex(square: string): number {
	const match = DAMA_SQUARE.exec(square);
	if (!match) throw new RangeError(`dama square ${square}`);
	return (8 - Number(match[2])) * 8 + match[1]!.charCodeAt(0) - 97;
}
export const TABLE_GAME_SPECTATOR_LIMIT = 50;
export const TABLE_GAME_DISCONNECT_GRACE_MS = 30_000;
export const TABLE_GAME_MAX_CONSECUTIVE_TIMEOUTS = 2;
export const TABLE_GAME_PRESENCE_CHECK_MS = 60_000;
export const TABLE_GAME_TIMER_SHARDS = 16;

const OKEY_TILE_COUNT = 106;
const OKEY_FACE_TILE_COUNT = 104;
const OKEY_TILE_TOKEN = /^t(?:[0-9]|[1-9][0-9]|10[0-5])$/;

// Tile ids t0..t105. id < 104: copy = floor(id / 52), color = floor((id % 52) / 13)
// (0 yellow, 1 blue, 2 black, 3 red), number = id % 13 + 1. t104 and t105 are the fake okeys.
export function okeyTileFace(id: number): {color: 0 | 1 | 2 | 3; number: number} | {fake: true} {
	if (!Number.isInteger(id) || id < 0 || id >= OKEY_TILE_COUNT) throw new RangeError(`okey tile id ${id}`);
	if (id >= OKEY_FACE_TILE_COUNT) return {fake: true};
	return {color: Math.floor((id % 52) / 13) as 0 | 1 | 2 | 3, number: (id % 13) + 1};
}

export function okeyTileToken(id: number): string {
	return `t${id}`;
}

export function parseOkeyTileToken(token: string): number | null {
	return OKEY_TILE_TOKEN.test(token) ? Number(token.slice(1)) : null;
}

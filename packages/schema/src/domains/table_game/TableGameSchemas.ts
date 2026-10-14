// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	DAMA_LEGAL_PATHS_MAX,
	DAMA_PATH_MAX,
	TABLE_GAME_KINDS,
	TABLE_GAME_SPEEDS,
	TAVLA_LEGAL_SEQUENCES_MAX,
	TAVLA_MOVES_MAX,
} from '@fluxer/constants/src/TableGameConstants';
import {SnowflakeStringType, SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

export const TableGameKind = z.enum(TABLE_GAME_KINDS);
export type TableGameKind = z.infer<typeof TableGameKind>;

export const TableGameSpeed = z.enum(TABLE_GAME_SPEEDS);
export type TableGameSpeed = z.infer<typeof TableGameSpeed>;

// The only values a TABLE_GAME_RULE_VIOLATION error body may carry in `reason`; never a tile.
export const TableGameRuleReason = z.enum([
	'not_your_turn',
	'wrong_phase',
	'tile_not_in_rack',
	'invalid_meld',
	'open_too_low',
	'pairs_too_few',
	'take_unused',
	'not_opened',
	'cannot_add',
	'illegal_move',
	'game_over',
	'unsupported_action',
	'must_finish_with_discard',
]);
export type TableGameRuleReason = z.infer<typeof TableGameRuleReason>;

export const TableGameSlotParam = z.object({
	channel_id: SnowflakeType.describe('The ID of the voice channel'),
	slot: z
		.string()
		.regex(/^T[0-9]{2}$/)
		.describe('Table slot of the channel room theme, like T01'),
});

export const TileToken = z.string().regex(/^t(?:[0-9]|[1-9][0-9]|10[0-5])$/);
export const OkeyMeldInput = z.array(TileToken).min(2).max(13);
export const OkeyAddition = z.object({
	meld_id: z.number().int().min(0).max(255),
	tiles: z.array(TileToken).min(1).max(12),
	at: z.enum(['start', 'end']),
});
export const ChessSquare = z.string().regex(/^[a-h][1-8]$/);
// Tavla points 1..24 from white's side; the bar is only ever a source, bearing off only a target.
export const TavlaPoint = z.union([z.number().int().min(1).max(24), z.literal('bar')]);
export const TavlaTarget = z.union([z.number().int().min(1).max(24), z.literal('off')]);

export const TableGameAction = z.discriminatedUnion('type', [
	z.object({type: z.literal('tick')}),
	z.object({type: z.literal('draw'), from: z.enum(['pile', 'discard'])}),
	z.object({type: z.literal('discard'), tile: TileToken}),
	z.object({type: z.literal('finish'), tile: TileToken, sets: z.array(OkeyMeldInput).min(1).max(7)}),
	z.object({
		type: z.literal('take_discard'),
		open: z.array(OkeyMeldInput).max(12).optional(),
		add: z.array(OkeyAddition).max(12).optional(),
	}),
	z.object({
		type: z.literal('meld'),
		open: z.array(OkeyMeldInput).max(12).optional(),
		add: z.array(OkeyAddition).max(12).optional(),
	}),
	z.object({
		type: z.literal('move'),
		from: ChessSquare,
		to: ChessSquare,
		promotion: z.enum(['q', 'r', 'b', 'n']).optional(),
	}),
	z.object({type: z.literal('resign')}),
	// A whole capture chain in one request: every square the piece stops on, start first.
	z.object({type: z.literal('dama_move'), path: z.array(ChessSquare).min(2).max(DAMA_PATH_MAX)}),
	// A whole tavla turn in one request.
	z.object({
		type: z.literal('tavla_move'),
		moves: z
			.array(z.object({from: TavlaPoint, to: TavlaTarget}))
			.min(1)
			.max(TAVLA_MOVES_MAX),
	}),
]);
export type TableGameAction = z.infer<typeof TableGameAction>;

// The caller's voice connection in this channel: membership is one KV read of the seat hash, no gateway call.
const VoiceConnectionId = z.string().min(1).max(64).describe("The caller's voice connection ID in this channel");

export const CreateTableGameRequest = z.object({
	game: TableGameKind,
	speed: TableGameSpeed,
	connection_id: VoiceConnectionId,
});
export type CreateTableGameRequest = z.infer<typeof CreateTableGameRequest>;

export const JoinTableGameRequest = z.object({
	position: z.number().int().min(1).max(4),
	connection_id: VoiceConnectionId,
});
export type JoinTableGameRequest = z.infer<typeof JoinTableGameRequest>;

export const SpectateTableGameRequest = z.object({connection_id: VoiceConnectionId});
export type SpectateTableGameRequest = z.infer<typeof SpectateTableGameRequest>;

// GET list needs connection_id; GET detail takes it when the caller is neither a player nor holds a watch ticket.
export const TableGameReadQuery = z.object({connection_id: VoiceConnectionId.optional()});
export type TableGameReadQuery = z.infer<typeof TableGameReadQuery>;

export const TableGameActionRequest = z.object({
	version: z.number().int().min(0).describe('Table version the action was made against; ignored for tick'),
	action: TableGameAction,
});
export type TableGameActionRequest = z.infer<typeof TableGameActionRequest>;

// Everything below leaves the server. Strict at every depth: an unknown field is a leak, not extra data.
export const TableGamePlayer = z.strictObject({
	position: z.number().int().min(1).max(4),
	user_id: SnowflakeStringType,
	connected: z.boolean(),
	timeouts: z.number().int(),
});
export type TableGamePlayer = z.infer<typeof TableGamePlayer>;

export const TableGameResult = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('win'),
		winners: z.array(z.number().int()),
		reason: z.enum(['finish', 'checkmate', 'timeout', 'resign', 'score', 'bear_off', 'no_pieces', 'blocked']),
		finish: z.enum(['normal', 'pairs', 'okey', 'hand', 'mars']).optional(),
	}),
	z.strictObject({
		kind: z.literal('forfeit'),
		loser: z.number().int(),
		reason: z.enum(['leave', 'disconnect', 'timeouts']),
	}),
	z.strictObject({
		kind: z.literal('draw'),
		reason: z.enum(['pile_empty', 'stalemate', 'insufficient', 'threefold', 'fifty_move', 'move_limit', 'lone_kings']),
	}),
	z.strictObject({kind: z.literal('canceled'), reason: z.enum(['disabled', 'theme_changed', 'abandoned'])}),
]);
export type TableGameResult = z.infer<typeof TableGameResult>;

export const TableGameSummary = z.strictObject({
	slot: z.string(),
	game: TableGameKind,
	speed: TableGameSpeed,
	status: z.enum(['lobby', 'playing', 'ended']),
	players: z.array(TableGamePlayer),
	spectator_count: z.number().int(),
	version: z.number().int(),
	result: TableGameResult.nullable(),
});
export type TableGameSummary = z.infer<typeof TableGameSummary>;

const OkeyCommon = {
	indicator: TileToken,
	pile_count: z.number().int(),
	discards: z.array(z.array(TileToken)).length(4).describe('Discard piles by position, oldest first'),
	rack_counts: z.array(z.number().int()).length(4),
	turn: z.number().int().min(1).max(4).nullable(),
	phase: z.enum(['draw', 'discard', 'play']),
	deadline_at: z.iso.datetime().nullable(),
	rack: z.array(TileToken).nullable().describe("The viewer's own rack; null for everyone else"),
};

export const OkeyView = z.strictObject({game: z.literal('okey'), ...OkeyCommon});
export type OkeyView = z.infer<typeof OkeyView>;

export const Okey101Meld = z.strictObject({
	id: z.number().int(),
	owner: z.number().int(),
	kind: z.enum(['run', 'group', 'pair']),
	tiles: z.array(TileToken),
});
export type Okey101Meld = z.infer<typeof Okey101Meld>;

export const Okey101View = z.strictObject({
	game: z.literal('okey101'),
	...OkeyCommon,
	melds: z.array(Okey101Meld),
	opened: z.array(z.enum(['none', 'sets', 'pairs'])).length(4),
	penalties: z.array(z.number().int()).length(4),
	scores: z.array(z.number().int()).length(4).nullable().describe('Hand scores; only once the hand is over'),
});
export type Okey101View = z.infer<typeof Okey101View>;

export const ChessView = z.strictObject({
	game: z.literal('chess'),
	fen: z.string(),
	white: z.union([z.literal(1), z.literal(3)]),
	clocks_ms: z.strictObject({white: z.number().int(), black: z.number().int()}),
	turn_started_at: z.iso.datetime().nullable(),
	last_move: z.string().nullable(),
	legal_moves: z.array(z.string()).nullable().describe('UCI moves; only for the player whose turn it is'),
	in_check: z.boolean().describe('The side to move is in check'),
});
export type ChessView = z.infer<typeof ChessView>;

const DamaCommon = {
	board: z
		.string()
		.regex(/^[.wbWB]{64}$/)
		.describe("64 squares a8..h8, a7..h7, …, a1..h1: '.' empty, 'w'/'b' man, 'W'/'B' king"),
	white: z.union([z.literal(1), z.literal(3)]),
	turn: z
		.union([z.literal(1), z.literal(3)])
		.nullable()
		.describe('Position to move; null once the game is over'),
	clocks_ms: z.strictObject({white: z.number().int(), black: z.number().int()}),
	turn_started_at: z.iso.datetime().nullable(),
	last_move: z.array(ChessSquare).nullable().describe('Squares of the last move, start first'),
	last_captured: z.array(ChessSquare).describe('Squares captured by the last move'),
	legal_moves: z
		.array(z.string())
		.max(DAMA_LEGAL_PATHS_MAX)
		.nullable()
		.describe("Full paths like 'c3-c5-e5'; only for the player whose turn it is"),
};

export const DamaView = z.strictObject({game: z.literal('dama'), ...DamaCommon});
export type DamaView = z.infer<typeof DamaView>;

export const DamaNormalView = z.strictObject({game: z.literal('dama_normal'), ...DamaCommon});
export type DamaNormalView = z.infer<typeof DamaNormalView>;

export const TavlaView = z.strictObject({
	game: z.literal('tavla'),
	white: z.union([z.literal(1), z.literal(3)]),
	points: z
		.array(z.number().int().min(-15).max(15))
		.length(24)
		.describe('Index 0 is point 1; positive counts are white checkers, negative black'),
	bar: z.strictObject({white: z.number().int(), black: z.number().int()}),
	off: z.strictObject({white: z.number().int(), black: z.number().int()}),
	turn: z.union([z.literal(1), z.literal(3)]).nullable(),
	dice: z.array(z.number().int().min(1).max(6)).length(2).nullable().describe("This turn's roll only"),
	opening: z.array(z.number().int().min(1).max(6)).length(2).nullable().describe('Opening roll; first turn only'),
	deadline_at: z.iso.datetime().nullable(),
	last_moves: z.array(z.strictObject({from: TavlaPoint, to: TavlaTarget, hit: z.boolean()})).max(TAVLA_MOVES_MAX),
	legal_moves: z
		.array(z.string())
		.max(TAVLA_LEGAL_SEQUENCES_MAX)
		.nullable()
		.describe(
			"Whole turns like '24/18 13/7', farthest from the mover's home first; only for the player whose turn it is",
		),
});
export type TavlaView = z.infer<typeof TavlaView>;

export const TableGameView = z.strictObject({
	summary: TableGameSummary,
	game_view: z
		.discriminatedUnion('game', [OkeyView, Okey101View, ChessView, DamaView, DamaNormalView, TavlaView])
		.nullable()
		.describe('Null while the table is in the lobby'),
	viewer_position: z.number().int().nullable(),
	spectating: z.boolean(),
});
export type TableGameView = z.infer<typeof TableGameView>;

export const TableGameListResponse = z.strictObject({tables: z.array(TableGameSummary)});
export type TableGameListResponse = z.infer<typeof TableGameListResponse>;

export const TableGameSpectateResponse = z.strictObject({subscribed: z.boolean(), view: TableGameView});
export type TableGameSpectateResponse = z.infer<typeof TableGameSpectateResponse>;

export const TableGameUpdateEvent = z.strictObject({
	channel_id: SnowflakeStringType,
	guild_id: SnowflakeStringType,
	slot: z.string(),
	view: TableGameView,
});
export type TableGameUpdateEvent = z.infer<typeof TableGameUpdateEvent>;

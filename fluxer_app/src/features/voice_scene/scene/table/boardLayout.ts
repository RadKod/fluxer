// SPDX-License-Identifier: AGPL-3.0-or-later

import {isWhitePiece, parseFenBoard, squareName} from '@app/features/table_game/utils/ChessFen';
import type {TableScene3DInput} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {SEAT_READABILITY_PROBES} from '@app/features/voice_scene/utils/SeatedView';
import type {
	ChessView,
	DamaNormalView,
	DamaView,
	TableGameView,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

// Chess, Türk daması and Normal dama share one 8 × 8 board. Board frame: table-local metres, y = 0 the table top,
// white's first rank on +Z, file a on −X (white's left); the model turns the board with boardTurn.

export type BoardGameView = ChessView | DamaView | DamaNormalView;
export type BoardPieceKind = 'k' | 'q' | 'r' | 'b' | 'n' | 'p' | 'dm' | 'dk';
export interface BoardPiece {
	square: string;
	kind: BoardPieceKind;
	white: boolean;
}
export type BoardMarkKind = 'last' | 'check' | 'selected' | 'target';
export interface BoardMark {
	square: string;
	kind: BoardMarkKind;
}

const FILES = 'abcdefgh';

// The dama board string's order: a8..h8, a7..h7, …, a1..h1.
export const BOARD_SQUARES: ReadonlyArray<string> = Array.from({length: 64}, (_, index) =>
	squareName(index % 8, Math.floor(index / 8)),
);

// inside SeatedView's probe box (8 × share × top_size, centred), where its readability floors hold.
export function boardSquareSize(topSize: number): number {
	return SEAT_READABILITY_PROBES.boardSquareShare * topSize;
}

// The board with its wooden frame (SeatedView frames this outline).
export function boardOuterSize(topSize: number): number {
	return 2 * SEAT_READABILITY_PROBES.boardOuterHalfSquares * boardSquareSize(topSize);
}

export function squarePosition(square: string, squareSize: number): {x: number; z: number} {
	const file = FILES.indexOf(square[0]!);
	const rank = Number(square[1]);
	return {x: (file - 3.5) * squareSize, z: (4.5 - rank) * squareSize};
}

// Turn (about +Y) that puts white's side towards the white player's seat, seen from `perspective` (root +Z). Seats
// sit 90° apart, counter-clockwise from above (GLB contract rev 2: 1 south, then 2, 3, 4), as the host turns root.
export function boardTurn(white: 1 | 3, perspective: 1 | 2 | 3 | 4): number {
	return ((((white - perspective) % 4) + 4) % 4) * (Math.PI / 2);
}

// The parts' knight looks along +Z; each side faces the other across the board.
export function pieceYaw(white: boolean): number {
	return white ? Math.PI : 0;
}

export function isBoardGameView(view: TableGameView['game_view']): view is BoardGameView {
	return view?.game === 'chess' || view?.game === 'dama' || view?.game === 'dama_normal';
}

export function boardPieces(view: TableGameView['game_view']): Array<BoardPiece> {
	if (!isBoardGameView(view)) return [];
	const pieces: Array<BoardPiece> = [];
	if (view.game === 'chess') {
		parseFenBoard(view.fen).forEach((row, rankRow) =>
			row.forEach((cell, file) => {
				if (cell)
					pieces.push({
						square: squareName(file, rankRow),
						kind: cell.toLowerCase() as BoardPieceKind,
						white: isWhitePiece(cell),
					});
			}),
		);
		return pieces;
	}
	BOARD_SQUARES.forEach((square, index) => {
		const cell = view.board[index];
		if (cell && cell !== '.')
			pieces.push({square, kind: cell === 'W' || cell === 'B' ? 'dk' : 'dm', white: cell === 'w' || cell === 'W'});
	});
	return pieces;
}

function lastMoveSquares(view: BoardGameView): ReadonlyArray<string> {
	if (view.game !== 'chess') return view.last_move ?? [];
	return view.last_move ? [view.last_move.slice(0, 2), view.last_move.slice(2, 4)] : [];
}

export function boardMarks(input: TableScene3DInput): Array<BoardMark> {
	const view = input.view.game_view;
	if (!isBoardGameView(view)) return [];
	const marks: Array<BoardMark> = lastMoveSquares(view).map((square) => ({square, kind: 'last'}));
	if (view.game === 'chess' && view.in_check) {
		const whiteToMove = view.fen.split(' ')[1] !== 'b';
		const king = boardPieces(view).find((piece) => piece.kind === 'k' && piece.white === whiteToMove);
		if (king) marks.push({square: king.square, kind: 'check'});
	}
	if (input.selection?.kind === 'square') marks.push({square: input.selection.square, kind: 'selected'});
	for (const target of input.targets) if (target.kind === 'square') marks.push({square: target.square, kind: 'target'});
	return marks;
}

// Squares the last moved piece travels (dama: every leg of the capture chain), when `next` brings a new move.
export function movePath(previous: TableGameView['game_view'], next: TableGameView['game_view']): Array<string> | null {
	if (!isBoardGameView(previous) || !isBoardGameView(next)) return null;
	const path = lastMoveSquares(next);
	if (path.length < 2 || path.join('-') === lastMoveSquares(previous).join('-')) return null;
	return [...path];
}

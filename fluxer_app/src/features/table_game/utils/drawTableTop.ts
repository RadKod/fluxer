// SPDX-License-Identifier: AGPL-3.0-or-later

import {chessGlyph, isWhitePiece, parseFenBoard} from '@app/features/table_game/utils/ChessFen';
import {okeyTileFace, parseOkeyTileToken} from '@fluxer/constants/src/TableGameConstants';
import type {
	ChessView,
	DamaNormalView,
	DamaView,
	OkeyView,
	TableGameView,
	TavlaView,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

const SIZE = 512;
const SQUARE = SIZE / 8;
const TILE_W = 44;
const TILE_H = 60;

// Okey tile colours by face colour index: yellow, blue, black, red.
const TILE_INK = ['#c98a00', '#1f63c6', '#1d1d1f', '#c8303a'] as const;
const TILE_FACE = '#f6f1e6';
const BOARD_LIGHT = '#eadcc0';
const BOARD_DARK = '#9c7552';
const PIECE_WHITE = '#fbfaf7';
const PIECE_BLACK = '#17120d';

// Canvas edges face the table seats: bottom = position 1, right = 2, top = 3, left = 4.
const EDGE_CENTERS: Record<number, [number, number]> = {
	1: [SIZE / 2, SIZE - 52],
	2: [SIZE - 52, SIZE / 2],
	3: [SIZE / 2, 52],
	4: [52, SIZE / 2],
};

function drawChess(context: CanvasRenderingContext2D, view: ChessView): void {
	// The white player's side of the board faces the white player's seat.
	const flipped = view.white === 3;
	const rows = parseFenBoard(view.fen);
	context.font = `${Math.round(SQUARE * 0.78)}px serif`;
	context.textAlign = 'center';
	context.textBaseline = 'middle';
	for (let row = 0; row < 8; row++) {
		for (let file = 0; file < 8; file++) {
			const x = (flipped ? 7 - file : file) * SQUARE;
			const y = (flipped ? 7 - row : row) * SQUARE;
			context.fillStyle = (row + file) % 2 === 0 ? BOARD_LIGHT : BOARD_DARK;
			context.fillRect(x, y, SQUARE, SQUARE);
			const piece = rows[row]?.[file];
			if (!piece) continue;
			context.fillStyle = isWhitePiece(piece) ? PIECE_WHITE : PIECE_BLACK;
			context.fillText(chessGlyph(piece), x + SQUARE / 2, y + SQUARE / 2);
		}
	}
}

// A disc with an outline that reads on both square colours; a king gets an inner ring.
function drawDisc(context: CanvasRenderingContext2D, x: number, y: number, radius: number, white: boolean): void {
	context.fillStyle = white ? PIECE_WHITE : PIECE_BLACK;
	context.strokeStyle = white ? PIECE_BLACK : PIECE_WHITE;
	context.lineWidth = 2;
	context.beginPath();
	context.arc(x, y, radius, 0, Math.PI * 2);
	context.fill();
	context.stroke();
}

function drawDama(context: CanvasRenderingContext2D, view: DamaView | DamaNormalView): void {
	// Like chess: the white player's side faces the white player's seat.
	const flipped = view.white === 3;
	for (let index = 0; index < 64; index++) {
		const row = Math.floor(index / 8);
		const file = index % 8;
		const x = (flipped ? 7 - file : file) * SQUARE;
		const y = (flipped ? 7 - row : row) * SQUARE;
		context.fillStyle = (row + file) % 2 === 0 ? BOARD_LIGHT : BOARD_DARK;
		context.fillRect(x, y, SQUARE, SQUARE);
	}
	for (let index = 0; index < 64; index++) {
		const piece = view.board[index]!;
		if (piece === '.') continue;
		const row = Math.floor(index / 8);
		const file = index % 8;
		const x = (flipped ? 7 - file : file) * SQUARE + SQUARE / 2;
		const y = (flipped ? 7 - row : row) * SQUARE + SQUARE / 2;
		const white = piece === 'w' || piece === 'W';
		drawDisc(context, x, y, SQUARE * 0.36, white);
		if (piece === 'W' || piece === 'B') {
			context.lineWidth = 3;
			context.beginPath();
			context.arc(x, y, SQUARE * 0.2, 0, Math.PI * 2);
			context.stroke();
		}
	}
}

// Tavla from the white seat (bottom): points 1–12 along the bottom right to left, 13–24 along the top left to right,
// the bar in the middle. For white at position 3 every point is turned half a circle.
const TAVLA_MARGIN = 16;
const TAVLA_BAR = 32;
const TAVLA_HALF = (SIZE - 2 * TAVLA_MARGIN - TAVLA_BAR) / 2;
const TAVLA_POINT_W = TAVLA_HALF / 6;
const TAVLA_POINT_H = 200;
const TAVLA_RADIUS = 16;
const TAVLA_STACK = 5;
const DIE = 36;
// Pips on a 3×3 grid, cells -1..1.
const PIPS: Record<number, ReadonlyArray<[number, number]>> = {
	1: [[0, 0]],
	2: [
		[-1, -1],
		[1, 1],
	],
	3: [
		[-1, -1],
		[0, 0],
		[1, 1],
	],
	4: [
		[-1, -1],
		[1, -1],
		[-1, 1],
		[1, 1],
	],
	5: [
		[-1, -1],
		[1, -1],
		[0, 0],
		[-1, 1],
		[1, 1],
	],
	6: [
		[-1, -1],
		[1, -1],
		[-1, 0],
		[1, 0],
		[-1, 1],
		[1, 1],
	],
};

function tavlaColumnX(column: number): number {
	const left = TAVLA_MARGIN + column * TAVLA_POINT_W + TAVLA_POINT_W / 2;
	return column < 6 ? left : left + TAVLA_BAR;
}

function drawTavla(context: CanvasRenderingContext2D, view: TavlaView): void {
	const flip = view.white === 3;
	const at = (x: number, y: number): [number, number] => (flip ? [SIZE - x, SIZE - y] : [x, y]);
	const bottom = SIZE - TAVLA_MARGIN;
	context.fillStyle = BOARD_LIGHT;
	context.fillRect(0, 0, SIZE, SIZE);
	context.fillStyle = BOARD_DARK;
	context.fillRect(SIZE / 2 - TAVLA_BAR / 2, 0, TAVLA_BAR, SIZE);
	context.font = 'bold 18px sans-serif';
	context.textAlign = 'center';
	context.textBaseline = 'middle';
	// A stack grows from its edge towards the middle; past five a number says how many.
	const stack = (x: number, edgeY: number, direction: 1 | -1, count: number, white: boolean) => {
		for (let k = 0; k < Math.min(count, TAVLA_STACK); k++) {
			const [cx, cy] = at(x, edgeY + direction * (TAVLA_RADIUS + k * TAVLA_RADIUS * 2));
			drawDisc(context, cx, cy, TAVLA_RADIUS - 1, white);
		}
		if (count > TAVLA_STACK) {
			const [tx, ty] = at(x, edgeY + direction * (TAVLA_RADIUS + (TAVLA_STACK - 1) * TAVLA_RADIUS * 2));
			context.fillStyle = white ? PIECE_BLACK : PIECE_WHITE;
			context.fillText(String(count), tx, ty);
		}
	};
	for (let point = 1; point <= 24; point++) {
		const top = point > 12;
		const x = tavlaColumnX(top ? point - 13 : 12 - point);
		const edgeY = top ? TAVLA_MARGIN : bottom;
		const tipY = top ? TAVLA_MARGIN + TAVLA_POINT_H : bottom - TAVLA_POINT_H;
		const corners = [at(x - TAVLA_POINT_W / 2, edgeY), at(x + TAVLA_POINT_W / 2, edgeY), at(x, tipY)];
		context.fillStyle = point % 2 === 0 ? BOARD_DARK : '#5e3f26';
		context.beginPath();
		context.moveTo(...corners[0]!);
		context.lineTo(...corners[1]!);
		context.lineTo(...corners[2]!);
		context.closePath();
		context.fill();
		const count = view.points[point - 1] ?? 0;
		if (count !== 0) stack(x, edgeY, top ? 1 : -1, Math.abs(count), count > 0);
	}
	stack(SIZE / 2, SIZE / 2, 1, view.bar.white, true);
	stack(SIZE / 2, SIZE / 2, -1, view.bar.black, false);
	view.dice?.forEach((face, index) => {
		const [cx, cy] = at(tavlaColumnX(9) + (index === 0 ? -DIE / 2 - 4 : DIE / 2 + 4), SIZE / 2);
		context.fillStyle = PIECE_WHITE;
		context.beginPath();
		context.roundRect(cx - DIE / 2, cy - DIE / 2, DIE, DIE, 6);
		context.fill();
		context.fillStyle = PIECE_BLACK;
		for (const [px, py] of PIPS[face] ?? []) {
			context.beginPath();
			context.arc(cx + px * DIE * 0.28, cy + py * DIE * 0.28, 3.5, 0, Math.PI * 2);
			context.fill();
		}
	});
}

function drawTile(context: CanvasRenderingContext2D, token: string, centerX: number, centerY: number): void {
	const id = parseOkeyTileToken(token);
	if (id === null) return;
	const face = okeyTileFace(id);
	context.fillStyle = TILE_FACE;
	context.beginPath();
	context.roundRect(centerX - TILE_W / 2, centerY - TILE_H / 2, TILE_W, TILE_H, 6);
	context.fill();
	context.fillStyle = 'fake' in face ? TILE_INK[2] : TILE_INK[face.color];
	context.fillText('fake' in face ? '★' : String(face.number), centerX, centerY);
}

function drawOkey(
	context: CanvasRenderingContext2D,
	view: OkeyView | Extract<TableGameView['game_view'], {game: 'okey101'}>,
): void {
	context.font = 'bold 30px sans-serif';
	context.textAlign = 'center';
	context.textBaseline = 'middle';
	drawTile(context, view.indicator, SIZE / 2 - 30, SIZE / 2);
	context.fillStyle = '#f6f1e6';
	context.fillText(String(view.pile_count), SIZE / 2 + 34, SIZE / 2);
	view.discards.forEach((pile, index) => {
		const top = pile.at(-1);
		const [x, y] = EDGE_CENTERS[index + 1]!;
		if (top) drawTile(context, top, x, y);
	});
}

// The public face of a table for the 3D room: never a rack, only what every spectator may see.
export function drawTableTop(canvas: HTMLCanvasElement, view: TableGameView | null): void {
	canvas.width = SIZE;
	canvas.height = SIZE;
	const context = canvas.getContext('2d');
	if (!context) return;
	context.clearRect(0, 0, SIZE, SIZE);
	const gameView = view?.game_view;
	if (!gameView) return;
	switch (gameView.game) {
		case 'chess':
			drawChess(context, gameView);
			break;
		case 'okey':
		case 'okey101':
			drawOkey(context, gameView);
			break;
		case 'dama':
		case 'dama_normal':
			drawDama(context, gameView);
			break;
		case 'tavla':
			drawTavla(context, gameView);
			break;
		// A kind only a newer build knows: cleared, nothing drawn.
	}
}

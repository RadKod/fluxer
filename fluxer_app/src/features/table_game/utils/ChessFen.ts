// SPDX-License-Identifier: AGPL-3.0-or-later

// Board rows from rank 8 down to rank 1, files a..h; each cell a FEN piece letter or null.
export type ChessBoardRows = ReadonlyArray<ReadonlyArray<string | null>>;

export function parseFenBoard(fen: string): ChessBoardRows {
	const placement = fen.split(' ')[0] ?? '';
	return placement.split('/').map((rank) => {
		const cells: Array<string | null> = [];
		for (const char of rank) {
			if (char >= '1' && char <= '8') cells.push(...Array<null>(Number(char)).fill(null));
			else cells.push(char);
		}
		return cells;
	});
}

export function isWhitePiece(piece: string): boolean {
	return piece === piece.toUpperCase();
}

// Solid glyphs for both sides; colour tells the sides apart, which reads better than outline glyphs at small sizes.
const SOLID_GLYPHS: Record<string, string> = {k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟'};

export function chessGlyph(piece: string): string {
	return SOLID_GLYPHS[piece.toLowerCase()] ?? '';
}

export function squareName(file: number, rankRow: number): string {
	return `${'abcdefgh'[file]}${8 - rankRow}`;
}

// SPDX-License-Identifier: AGPL-3.0-or-later

// A dama legal move is a whole path of the squares the piece stops on, 'c3-c5-e5' (DamaView.legal_moves, at most
// DAMA_LEGAL_PATHS_MAX, only for the player to move). These are the choices offered, never anything else.
export function parsePaths(legalMoves: ReadonlyArray<string> | null): Array<Array<string>> {
	return (legalMoves ?? []).map((path) => path.split('-'));
}

// More than one path with the same start and end: the player picks one.
export function pathsFor(
	paths: ReadonlyArray<ReadonlyArray<string>>,
	from: string,
	to: string,
): Array<ReadonlyArray<string>> {
	return paths.filter((path) => path[0] === from && path.at(-1) === to);
}

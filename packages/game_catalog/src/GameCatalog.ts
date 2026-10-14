// SPDX-License-Identifier: AGPL-3.0-or-later

import catalog from './catalog.json';

export interface GameCatalogEntry {
	readonly id: string;
	readonly name: string;
	readonly exe: ReadonlyArray<string>;
	readonly icon: string | null;
	readonly icon_source: {readonly url: string; readonly date: string} | null;
}

export const catalogVersion = catalog.version;
export const gameCatalog: ReadonlyArray<GameCatalogEntry> = catalog.games;

const gamesById = new Map(gameCatalog.map((game) => [game.id.toLowerCase(), game]));
const gamesByExe = new Map(gameCatalog.flatMap((game) => game.exe.map((exe) => [exe.toLowerCase(), game] as const)));

export function getGameById(id: string): GameCatalogEntry | undefined {
	return gamesById.get(id.toLowerCase());
}

export function matchGameByExe(exeName: string): GameCatalogEntry | undefined {
	return gamesByExe.get(exeName.toLowerCase());
}

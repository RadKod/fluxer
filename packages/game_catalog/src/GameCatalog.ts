// SPDX-License-Identifier: AGPL-3.0-or-later

import catalog from './catalog.json';

export interface GameCatalogEntry {
	readonly id: string;
	readonly name: string;
	readonly exe: ReadonlyArray<string>;
	// Native process basenames (lowercase, no extension rule) for macOS and Linux builds of the game.
	readonly mac?: ReadonlyArray<string>;
	readonly linux?: ReadonlyArray<string>;
	readonly icon: string | null;
	readonly icon_source: {readonly url: string; readonly date: string} | null;
}

export const catalogVersion = catalog.version;
export const gameCatalog: ReadonlyArray<GameCatalogEntry> = catalog.games;

const gamesById = new Map(gameCatalog.map((game) => [game.id.toLowerCase(), game]));
const gamesByExe = new Map(gameCatalog.flatMap((game) => game.exe.map((exe) => [exe.toLowerCase(), game] as const)));

const STRIPPED_EXE_MIN_LENGTH = 5;
const gamesByNativeProcess = {
	darwin: nativeIndex('mac'),
	linux: nativeIndex('linux'),
};

function nativeIndex(field: 'mac' | 'linux'): Map<string, GameCatalogEntry> {
	const index = new Map<string, GameCatalogEntry>();
	// A Windows basename without `.exe` is a fallback guess for native ports; short names are too generic.
	for (const game of gameCatalog) {
		for (const exe of game.exe) {
			const stripped = exe.slice(0, -'.exe'.length);
			if (stripped.length >= STRIPPED_EXE_MIN_LENGTH && !index.has(stripped)) index.set(stripped, game);
		}
	}
	for (const game of gameCatalog) for (const name of game[field] ?? []) index.set(name.toLowerCase(), game);
	return index;
}

export function getGameById(id: string): GameCatalogEntry | undefined {
	return gamesById.get(id.toLowerCase());
}

export function matchGameByExe(exeName: string): GameCatalogEntry | undefined {
	return gamesByExe.get(exeName.toLowerCase());
}

// Matches a process basename on any desktop platform. Windows keeps exact `.exe` matching; on macOS and
// Linux a `.exe` name (Wine, Proton, CrossOver) uses the Windows table and native names use `mac`/`linux`.
export function matchGameByProcess(processName: string, platform: string): GameCatalogEntry | undefined {
	const name = processName.toLowerCase();
	if (platform === 'win32' || name.endsWith('.exe')) return gamesByExe.get(name);
	if (platform === 'darwin' || platform === 'linux') return gamesByNativeProcess[platform].get(name);
	return undefined;
}

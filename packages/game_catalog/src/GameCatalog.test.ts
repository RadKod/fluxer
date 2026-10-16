// SPDX-License-Identifier: AGPL-3.0-or-later

import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import * as reader from './GameCatalog';

interface CatalogEntry {
	id: string;
	name: string;
	exe: Array<string>;
	mac?: Array<string>;
	linux?: Array<string>;
	icon: string | null;
	icon_source: {url: string; date: string} | null;
}

const catalogPath = fileURLToPath(new URL('./catalog.json', import.meta.url));
const catalog: {version: number; games: Array<CatalogEntry>} = JSON.parse(readFileSync(catalogPath, 'utf8'));

function webpDimensions(bytes: Buffer): [number, number] {
	expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
	expect(bytes.toString('ascii', 8, 12)).toBe('WEBP');
	for (let offset = 12; offset + 8 <= bytes.length; ) {
		const chunk = bytes.toString('ascii', offset, offset + 4);
		const length = bytes.readUInt32LE(offset + 4);
		const data = offset + 8;
		if (chunk === 'VP8X') return [bytes.readUIntLE(data + 4, 3) + 1, bytes.readUIntLE(data + 7, 3) + 1];
		if (chunk === 'VP8 ') return [bytes.readUInt16LE(data + 6) & 0x3fff, bytes.readUInt16LE(data + 8) & 0x3fff];
		if (chunk === 'VP8L') {
			const bits = bytes.readUInt32LE(data + 1);
			return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
		}
		offset = data + length + (length % 2);
	}
	throw new Error('Missing WebP image chunk');
}

describe('game catalog schema', () => {
	test('has version 1 and approximately 150 games', () => {
		expect(catalog.games.length).toBeGreaterThanOrEqual(140);
		expect(catalog.games.length).toBeLessThanOrEqual(170);
		expect(catalog.version).toBe(1);
	});

	test('uses unique valid ids, names and exact lowercase executable basenames', () => {
		const ids = new Set<string>();
		const executableOwners = new Map<string, string>();
		for (const game of catalog.games) {
			const keys = Object.keys(game).filter((key) => key !== 'mac' && key !== 'linux');
			expect(keys.sort()).toEqual(['exe', 'icon', 'icon_source', 'id', 'name']);
			expect(game.id).toMatch(/^[a-z0-9][a-z0-9-]{0,47}$/);
			expect(ids.has(game.id), game.id).toBe(false);
			ids.add(game.id);
			expect(game.name.trim()).toBe(game.name);
			expect(game.name.length).toBeGreaterThan(0);
			expect(game.name.length).toBeLessThanOrEqual(128);
			expect(Array.isArray(game.exe)).toBe(true);
			for (const exe of game.exe) {
				expect(exe).toBe(exe.toLowerCase());
				expect(exe).toMatch(/^[^\\/:]+\.exe$/);
				expect([...exe].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)).toBe(
					true,
				);
				expect(exe).not.toMatch(/javaw?\.exe|launcher|patcher|anticheat|anti-cheat|easyanticheat|battleye|beservice/);
				expect(executableOwners.has(exe), `${exe}: ${game.id} / ${executableOwners.get(exe)}`).toBe(false);
				executableOwners.set(exe, game.id);
			}
		}
	});

	test('uses lowercase native macOS and Linux process basenames owned by one game', () => {
		for (const field of ['mac', 'linux'] as const) {
			const owners = new Map<string, string>();
			for (const game of catalog.games) {
				if (game[field] === undefined) continue;
				expect(Array.isArray(game[field]), game.id).toBe(true);
				expect(game[field]!.length, game.id).toBeGreaterThan(0);
				for (const name of game[field]!) {
					expect(name).toBe(name.toLowerCase());
					expect(name).toMatch(/^[^\\/:]{1,128}$/);
					expect(name.endsWith('.exe'), name).toBe(false);
					expect([...name].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)).toBe(
						true,
					);
					expect(name).not.toMatch(/^(?:java|python\d*|node|electron|wine\d*|steam)$|launcher|patcher|anticheat/);
					expect(owners.has(name), `${field} ${name}: ${game.id} / ${owners.get(name)}`).toBe(false);
					owners.set(name, game.id);
				}
			}
		}
	});

	test('records an exact source URL and date for every bundled icon', () => {
		for (const game of catalog.games) {
			if (game.icon === null) {
				expect(game.icon_source, game.id).toBeNull();
				continue;
			}
			expect(game.icon).toBe(game.id);
			expect(game.icon_source, game.id).not.toBeNull();
			expect(Object.keys(game.icon_source!).sort()).toEqual(['date', 'url']);
			expect(game.icon_source!.url).toMatch(/^https:\/\/\S+$/);
			expect(game.icon_source!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(Number.isNaN(Date.parse(game.icon_source!.date))).toBe(false);
		}
	});

	test('bundles square 64 and 128 pixel WebP assets under 12 KiB each', () => {
		for (const game of catalog.games) {
			if (game.icon === null) continue;
			for (const size of [64, 128]) {
				const path = fileURLToPath(
					new URL(`../../../fluxer_app/src/assets/images/games/${game.icon}-${size}.webp`, import.meta.url),
				);
				expect(existsSync(path), path).toBe(true);
				const bytes = readFileSync(path);
				expect(bytes.length, path).toBeLessThanOrEqual(12 * 1024);
				expect(webpDimensions(bytes), path).toEqual([size, size]);
			}
		}
	});
});

describe('game catalog reader', () => {
	test('exports the catalog version and entries', () => {
		expect(reader.catalogVersion).toBe(1);
		expect(reader.gameCatalog).toEqual(catalog.games);
	});

	test('looks up exact ids and executable basenames without case sensitivity', () => {
		for (const game of catalog.games) {
			expect(reader.getGameById(game.id)).toEqual(game);
			expect(reader.getGameById(game.id.toUpperCase())).toEqual(game);
			for (const exe of game.exe) {
				expect(reader.matchGameByExe(exe)).toBe(reader.getGameById(game.id));
				expect(reader.matchGameByExe(exe.toUpperCase())).toBe(reader.getGameById(game.id));
				expect(reader.matchGameByExe(`C:\\Games\\${exe}`)).toBeUndefined();
				expect(reader.matchGameByExe(`/games/${exe}`)).toBeUndefined();
				expect(reader.matchGameByExe(`${exe}.bak`)).toBeUndefined();
			}
		}
	});

	test('matches processes per platform without changing Windows matching', () => {
		const cs2 = reader.getGameById('counter-strike-2');
		expect(reader.matchGameByProcess('CS2.EXE', 'win32')).toBe(cs2);
		expect(reader.matchGameByProcess('cs2', 'win32')).toBeUndefined();
		expect(reader.matchGameByProcess('cs2', 'linux')).toBe(cs2);
		expect(reader.matchGameByProcess('cs2.exe', 'linux')).toBe(cs2);
		expect(reader.matchGameByProcess('cs2.exe', 'darwin')).toBe(cs2);
		expect(reader.matchGameByProcess('LeagueOfLegends', 'darwin')).toBe(reader.getGameById('league-of-legends'));
		expect(reader.matchGameByProcess('leagueoflegends', 'linux')).toBeUndefined();
		expect(reader.matchGameByProcess('factorio', 'linux')).toBe(reader.getGameById('factorio'));
		expect(reader.matchGameByProcess('Factorio', 'darwin')).toBe(reader.getGameById('factorio'));
		expect(reader.matchGameByProcess('repo', 'darwin')).toBeUndefined();
		expect(reader.matchGameByProcess('fm', 'linux')).toBeUndefined();
		expect(reader.matchGameByProcess('spotify', 'darwin')).toBeUndefined();
		expect(reader.matchGameByProcess('cs2', 'freebsd')).toBeUndefined();
		for (const game of catalog.games) {
			for (const name of game.mac ?? [])
				expect(reader.matchGameByProcess(name, 'darwin')).toBe(reader.getGameById(game.id));
			for (const name of game.linux ?? [])
				expect(reader.matchGameByProcess(name.toUpperCase(), 'linux')).toBe(reader.getGameById(game.id));
		}
	});

	test('rejects unknown names, shared Java runtimes, launchers and object keys', () => {
		for (const value of ['', 'unknown-game', 'toString', '__proto__', 'constructor']) {
			expect(reader.getGameById(value)).toBeUndefined();
		}
		for (const value of [
			'',
			'unknown.exe',
			'java.exe',
			'javaw.exe',
			'steam.exe',
			'epicgameslauncher.exe',
			'__proto__',
		]) {
			expect(reader.matchGameByExe(value)).toBeUndefined();
		}
	});
});

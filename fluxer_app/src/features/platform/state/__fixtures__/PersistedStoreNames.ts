// SPDX-License-Identifier: AGPL-3.0-or-later

import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AppStorageKey} from '@app/features/platform/state/AppStorageKeys';

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const EXCLUDED_PATH_PATTERN = /node_modules|\.test\.|__fixtures__/;
const PERSISTED_STORE_PATTERN = /makePersistent\(\s*this,\s*([A-Za-z_.']+)/g;

function collectSourceFiles(directory: string): Array<string> {
	const files: Array<string> = [];
	for (const name of readdirSync(directory)) {
		const path = join(directory, name);
		if (EXCLUDED_PATH_PATTERN.test(path)) {
			continue;
		}
		if (statSync(path).isDirectory()) {
			files.push(...collectSourceFiles(path));
		} else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
			files.push(path);
		}
	}
	return files;
}

function resolveImportedConstant(expression: string, source: string, sourcePath: string): string | undefined {
	for (const match of source.matchAll(/import\s*{([^}]+)}\s*from\s*'([^']+)'/g)) {
		const importedName = match[1]!
			.split(',')
			.map((name) => name.trim())
			.find((name) => name === expression);
		if (importedName === undefined) continue;
		const moduleName = match[2]!;
		const modulePath = moduleName.startsWith('@app/')
			? resolve(SOURCE_ROOT, moduleName.slice('@app/'.length))
			: resolve(dirname(sourcePath), moduleName);
		const file = ['.ts', '.tsx'].map((extension) => `${modulePath}${extension}`).find(existsSync);
		if (file === undefined) continue;
		return new RegExp(`const ${expression} = '([^']+)'`).exec(readFileSync(file, 'utf8'))?.[1];
	}
	return undefined;
}

function resolveStoreName(expression: string, source: string, sourcePath: string): string {
	if (expression.startsWith("'")) {
		return expression.slice(1, -1);
	}
	const value = expression.startsWith('AppStorageKey.')
		? (AppStorageKey as Record<string, string>)[expression.slice('AppStorageKey.'.length)]
		: (new RegExp(`const ${expression} = '([^']+)'`).exec(source)?.[1] ??
			resolveImportedConstant(expression, source, sourcePath));
	if (value === undefined) {
		throw new Error(`makePersistent is called with an unresolvable store name: ${expression}`);
	}
	return value;
}

export const STORES_WITHOUT_DEPLOYED_DATA: ReadonlySet<string> = new Set(['SourceMaps', 'WindowsFont', 'GameActivityLocalSettings']);

export function readPersistedStoreNames(): Array<string> {
	const names = new Set<string>();
	for (const path of collectSourceFiles(SOURCE_ROOT)) {
		const source = readFileSync(path, 'utf8');
		for (const match of source.matchAll(PERSISTED_STORE_PATTERN)) {
			names.add(resolveStoreName(match[1]!, source, path));
		}
	}
	return [...names].sort();
}

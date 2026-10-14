// SPDX-License-Identifier: AGPL-3.0-or-later

import {readdirSync, readFileSync} from 'node:fs';
import {dirname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import type {I18n} from '@lingui/core';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../../../..');

// Specifiers loaded at runtime: value and side-effect imports, re-exports and dynamic imports. `import type` is erased.
function runtimeSpecifiers(source: string): Array<string> {
	const statements = /^\s*(?:import|export)\s+(?!type\s)(?:[^;'"]*?\bfrom\s+)?['"]([^'"]+)['"]/gm;
	const dynamic = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
	return [...source.matchAll(statements), ...source.matchAll(dynamic)].map(([, specifier]) => specifier!);
}

describe('GuildSettingsConstants', () => {
	it('reads runtime import specifiers one statement at a time', () => {
		expect(runtimeSpecifiers("import {B} from '@fluxer/b';\nimport type {A} from '@app/a';")).toEqual(['@fluxer/b']);
		expect(
			runtimeSpecifiers(
				"import '@app/side';\nexport {C} from '@app/c';\nexport * from '@app/d';\nexport type {E} from '@app/e';",
			),
		).toEqual(['@app/side', '@app/c', '@app/d']);
		expect(runtimeSpecifiers("import {\n\tF,\n\ttype G,\n} from '@app/f';\nconst h = () => import('@app/h');")).toEqual(
			['@app/f', '@app/h'],
		);
	});

	// Upstream shares its category labels through a descriptor module; it holds message descriptors, no component.
	it('imports no app module but the shared descriptors, so loading tab metadata cannot start a tab component', () => {
		const source = readFileSync(join(HERE, 'GuildSettingsConstants.ts'), 'utf8');
		const appImports = runtimeSpecifiers(source).filter((specifier) => /^(@app\/|\.)/.test(specifier));
		expect(appImports).toEqual(['@app/features/user/components/settings_utils/section_registry/SharedDescriptors']);
	});

	it('leaves the tab component registry as the only importer of the sanalyer tab modules', () => {
		const tabModules = [
			'features/boost/components/GuildBoostTab',
			'features/roster/components/GuildRosterTab',
			'features/micupbot/components/MicupBotTab',
		].map((path) => join(SRC, path));
		const importers = readdirSync(SRC, {recursive: true, encoding: 'utf8'})
			.filter((path) => /\.tsx?$/.test(path) && !/\.(test|spec)\.tsx?$/.test(path))
			.filter((path) => {
				const file = join(SRC, path);
				return runtimeSpecifiers(readFileSync(file, 'utf8')).some((specifier) => {
					const target = specifier.startsWith('@app/')
						? join(SRC, specifier.slice('@app/'.length))
						: specifier.startsWith('.')
							? resolve(dirname(file), specifier)
							: null;
					return target !== null && tabModules.includes(target.replace(/\.(tsx?|jsx?)$/, ''));
				});
			})
			.map((path) => path.split(sep).join('/'));
		expect(importers).toEqual(['features/user/components/settings_utils/GuildSettingsTabComponents.ts']);
	});

	it('registers the boost, event bot and community bot tabs before webhooks', async () => {
		const {getGuildSettingsTabs} = await import('@app/features/user/components/settings_utils/GuildSettingsConstants');
		const i18n = {_: (descriptor: {message: string}) => descriptor.message} as unknown as I18n;
		const tabs = getGuildSettingsTabs(i18n);
		const types = tabs.map((tab) => tab.type);
		expect(types.slice(types.indexOf('boost'), types.indexOf('webhooks'))).toEqual(['boost', 'roster', 'micupbot']);
		expect(tabs.find((tab) => tab.type === 'boost')).toMatchObject({category: 'community', label: 'Boosts'});
		expect(tabs.find((tab) => tab.type === 'boost')?.permission).toBeUndefined();
		expect(tabs.find((tab) => tab.type === 'roster')).toMatchObject({
			category: 'community',
			label: 'Event bot',
			permission: Permissions.MANAGE_GUILD,
		});
		expect(tabs.find((tab) => tab.type === 'micupbot')).toMatchObject({
			category: 'integrations',
			label: 'Community bot',
			permission: Permissions.MANAGE_GUILD,
		});
	});
});

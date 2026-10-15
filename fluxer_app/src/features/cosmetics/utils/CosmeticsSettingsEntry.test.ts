// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parse} from '@babel/parser';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));

const {profileCosmeticsIndex} = await import(
	'@app/features/user/components/settings_utils/search_index/ProfileCosmeticsIndex'
);
const {COSMETIC_TYPE_LABELS} = await import('@app/features/cosmetics/utils/CosmeticLabels');

// The settings registry imports most of the app (generated avatar masks, the wasm markdown parser), so the two
// registration lines are read from the source instead of imported.
const SETTINGS_UTILS = fileURLToPath(new URL('../../user/components/settings_utils/', import.meta.url));

function matchesInDeclaration(file: string, declaration: string, pattern: RegExp): Array<string> {
	const source = readFileSync(`${SETTINGS_UTILS}${file}`, 'utf8');
	const declarator = parse(source, {sourceType: 'module', plugins: ['typescript']})
		.program.body.flatMap((statement) => (statement.type === 'VariableDeclaration' ? statement.declarations : []))
		.find((node) => node.id.type === 'Identifier' && node.id.name === declaration);
	const init = declarator?.init;
	if (!init) return [];
	return [...source.slice(init.start ?? 0, init.end ?? 0).matchAll(pattern)].map((match) => match[1] ?? '');
}

describe('profile decorations settings entry', () => {
	it('can be opened from a settings deep link', () => {
		expect(matchesInDeclaration('UserSettingsDeepLinks.ts', 'USER_SETTINGS_TAB_TYPES', /'(\w+)'/g)).toContain(
			'profile_cosmetics',
		);
	});

	it('is part of the settings search', () => {
		expect(matchesInDeclaration('SettingsSearchIndex.ts', 'ADDITIONAL_SEARCHABLE_ITEMS', /\.\.\.(\w+)/g)).toContain(
			'profileCosmeticsIndex',
		);
	});

	it('finds each decoration type by its name and common synonyms', () => {
		expect(profileCosmeticsIndex.map((entry) => [entry.tabType, entry.label])).toEqual([
			['profile_cosmetics', COSMETIC_TYPE_LABELS.avatar_decoration],
			['profile_cosmetics', COSMETIC_TYPE_LABELS.nameplate],
			['profile_cosmetics', COSMETIC_TYPE_LABELS.profile_effect],
		]);
		const words = profileCosmeticsIndex.flatMap((entry) =>
			entry.keywords.map((keyword) =>
				typeof keyword === 'function' ? keyword() : typeof keyword === 'string' ? keyword : keyword.message,
			),
		);
		expect(words).toEqual(expect.arrayContaining(['Frame', 'Decoration', 'Nameplate', 'Profile effect']));
	});
});

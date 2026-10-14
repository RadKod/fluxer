// SPDX-License-Identifier: AGPL-3.0-or-later

import {readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from '@babel/parser';
import {describe, expect, it} from 'vitest';

// Rendering every profile surface needs most of the app, so this reads the JSX instead: a surface that stops passing
// the effect (an upstream merge, a new card) fails here.
interface AstNode {
	type?: string;
	[key: string]: unknown;
}

const SRC_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function listTsxFiles(directory: string): Array<string> {
	return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return listTsxFiles(path);
		return entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') ? [path] : [];
	});
}

function openingElements(file: string, name: string): Array<Array<string>> {
	const ast = parse(readFileSync(file, 'utf8'), {sourceType: 'module', plugins: ['typescript', 'jsx']});
	const found: Array<Array<string>> = [];
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			node.forEach(visit);
			return;
		}
		if (!node || typeof node !== 'object') return;
		const astNode = node as AstNode & {name?: {name?: string}; attributes?: Array<{name?: {name?: string}}>};
		if (astNode.type === 'JSXOpeningElement' && astNode.name?.name === name) {
			found.push((astNode.attributes ?? []).map((attribute) => attribute.name?.name ?? ''));
		}
		for (const [key, value] of Object.entries(astNode)) {
			if (key !== 'loc' && key !== 'start' && key !== 'end') visit(value);
		}
	};
	visit(ast.program);
	return found;
}

describe('profile effect surfaces', () => {
	it('passes the profile effect to every profile card', () => {
		const cards = listTsxFiles(SRC_ROOT).flatMap((file) =>
			openingElements(file, 'ProfileCardLayout').map((attributes) => ({
				file: relative(SRC_ROOT, file).replaceAll('\\', '/'),
				hasEffect: attributes.includes('profileEffect'),
			})),
		);
		expect(cards.map((card) => card.file).sort()).toEqual([
			'features/app/components/floating/UserAreaPopout.tsx',
			'features/user/components/popouts/UserProfilePopout.tsx',
			'features/user/components/profile/ProfilePreview.tsx',
		]);
		expect(cards.filter((card) => !card.hasEffect)).toEqual([]);
	});

	it.each([
		'features/user/components/modals/UserProfileModal.tsx',
		'features/user/components/modals/UserProfileMobileSheet.tsx',
	])('draws the profile effect over %s', (file) => {
		expect(openingElements(join(SRC_ROOT, file), 'ProfileEffectOverlay')).toEqual([['effect', 'data-flx']]);
	});
});

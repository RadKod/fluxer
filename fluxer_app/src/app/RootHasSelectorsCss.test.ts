// SPDX-License-Identifier: AGPL-3.0-or-later

import {readdirSync, readFileSync} from 'node:fs';
import {join, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// Micup: a rule anchored at the root with :has(), like
// `:global(html:is(.theme-coal, .theme-dark):not(:has(#fluxer-custom-theme-style))) .x`, makes Chromium re-check its
// targets on every DOM change. A class target keeps that to the elements carrying the class; a pseudo-element or a
// bare tag target cannot be scoped, so every change restyled the whole document (70-84 ms per change against ~1 ms)
// and every page switch in the coal and dark themes lagged. Such a target needs a class of its own.
const SRC = fileURLToPath(new URL('..', import.meta.url));

// Comments become spaces of the same length, so offsets still give line numbers.
const blankComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));

// Splits at `separator` outside parentheses and brackets.
function splitTopLevel(text: string, separator: RegExp): Array<string> {
	const parts: Array<string> = [];
	let depth = 0;
	let current = '';
	for (const char of text) {
		if (char === '(' || char === '[') depth++;
		else if (char === ')' || char === ']') depth--;
		if (depth === 0 && separator.test(char)) {
			if (current) parts.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	if (current) parts.push(current);
	return parts;
}

// `:global(X)` reads as X.
function unwrapGlobal(selector: string): string {
	let result = selector;
	for (let start = result.indexOf(':global('); start !== -1; start = result.indexOf(':global(')) {
		let depth = 0;
		let end = start + ':global'.length;
		for (; end < result.length; end++) {
			if (result[end] === '(') depth++;
			else if (result[end] === ')' && --depth === 0) break;
		}
		result = result.slice(0, start) + result.slice(start + ':global('.length, end) + result.slice(end + 1);
	}
	return result;
}

function targetProblem(target: string): string | null {
	if (target.includes('::')) return 'pseudo-element target';
	const positive = target.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, '');
	return /[.#[]/.test(positive) ? null : 'bare tag target';
}

function rootHasViolations(file: string, source = readFileSync(file, 'utf8')): Array<string> {
	const css = blankComments(source);
	const violations: Array<string> = [];
	let start = 0;
	for (let index = 0; index < css.length; index++) {
		const char = css[index];
		if (char === '}' || char === ';') start = index + 1;
		if (char !== '{') continue;
		const prelude = css.slice(start, index);
		const offset = start + prelude.indexOf(prelude.trim());
		start = index + 1;
		const trimmed = prelude.trim();
		if (!trimmed.includes(':has(') || trimmed.startsWith('@')) continue;
		const line = css.slice(0, offset).split('\n').length;
		for (const selector of splitTopLevel(trimmed, /,/)) {
			const compounds = splitTopLevel(unwrapGlobal(selector.trim()), /[\s>+~]/);
			const anchor = compounds[0] ?? '';
			if (compounds.length < 2 || !/^(?:html|body|:root)(?![\w-])/.test(anchor) || !anchor.includes(':has(')) {
				continue;
			}
			const problem = targetProblem(compounds[compounds.length - 1]);
			const path = relative(SRC, file).split(sep).join('/');
			const text = selector.trim().replace(/\s+/g, ' ');
			if (problem) violations.push(`${path}:${line} ${text} (${problem})`);
		}
	}
	return violations;
}

describe('root :has() rules', () => {
	it('allows a local pane anchor with a bare descendant target', () => {
		const css =
			'.pane:has(:is(flx-channel-textarea-typing-slot, flx-channel-textarea-slowmode-slot)) > flx-channel-textarea {}';
		expect(rootHasViolations(join(SRC, 'fixture.css'), css)).toEqual([]);
	});

	it.each(['html', 'body', ':root', ':global(html:is(.theme-coal, .theme-dark))'])(
		'rejects bare and pseudo-element targets on a %s anchor while allowing a class target',
		(anchor) => {
			const file = join(SRC, 'fixture.css');
			expect(rootHasViolations(file, `${anchor}:has(.active) textarea {}`)).toHaveLength(1);
			expect(rootHasViolations(file, `${anchor}:has(.active) .textarea::placeholder {}`)).toHaveLength(1);
			expect(rootHasViolations(file, `${anchor}:has(.active) .textarea {}`)).toEqual([]);
		},
	);

	it('target a class, never a pseudo-element or a bare tag', () => {
		const files = readdirSync(SRC, {recursive: true, encoding: 'utf8'})
			.filter((path) => path.endsWith('.css'))
			.map((path) => join(SRC, path));
		expect(files.length).toBeGreaterThan(100);
		expect(files.flatMap((file) => rootHasViolations(file))).toEqual([]);
	});
});

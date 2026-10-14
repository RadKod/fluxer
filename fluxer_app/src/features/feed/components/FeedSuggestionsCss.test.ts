// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// happy-dom has no layout or media queries, so the stylesheet is read (like FeedCommentsCss.test.ts).
const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
const css = read('./FeedSuggestions.module.css');
const card = read('./FeedProfileAside.module.css');

// The declarations of the rule whose whole selector is `selector` (a regular expression source), at any depth.
const rule = (source: string, selector: string) =>
	source.match(new RegExp(`(?:^|\\n)\\t*${selector} \\{([^}]*)\\}`))?.[1] ?? '';
const TOUCH = '@media (max-width: 640px), (pointer: coarse) {';

describe('feed suggestions design', () => {
	it('uses the theme tokens of the profile card and no fixed colour', () => {
		const section = rule(css, '\\.section');
		// The same surface as the profile card above it.
		for (const token of [
			'border: 0.0625rem solid var(--background-modifier-accent);',
			'border-radius: var(--radius-2xl);',
			'background-color: var(--background-secondary-alt);',
		]) {
			expect(rule(card, '\\.card')).toContain(token);
			expect(section).toContain(token);
		}
		expect(section).toContain('padding: 0.75rem;');
		expect(rule(css, '\\.heading')).toContain('color: var(--text-primary);');
		expect(rule(css, '\\.name')).toContain('color: var(--text-primary);');
		expect(rule(css, '\\.detail')).toContain('color: var(--text-primary-muted);');
		expect(rule(css, '\\.joined')).toContain('color: var(--text-primary-muted);');
		// Colours come only from the theme: no hex, rgb, hsl or named colour.
		expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|:\s*(white|black)\b/i);
	});

	it('cuts long names to one line', () => {
		expect(rule(css, '\\.identity')).toContain('min-width: 0;');
		expect(rule(css, '\\.names')).toContain('min-width: 0;');
		for (const selector of ['\\.name', '\\.detail']) {
			const declarations = rule(css, selector);
			expect(declarations).toContain('overflow: hidden;');
			expect(declarations).toContain('text-overflow: ellipsis;');
			expect(declarations).toContain('white-space: nowrap;');
		}
	});

	it('gives buttons a 44px target on touch', () => {
		expect(rule(css, '\\.row')).toContain('min-height: 2.75rem;');
		const touch = css.slice(css.indexOf(TOUCH));
		expect(css.indexOf(TOUCH)).toBeGreaterThan(-1);
		// Three parts, to outrank Fluxer's .button.small (0,2,0), like the profile card's Your posts button.
		expect(rule(touch, '\\.section \\.row \\.action')).toContain('min-height: 2.75rem;');
	});
});

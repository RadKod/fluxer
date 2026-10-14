// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// happy-dom has no layout or media queries, so the stylesheets are read (like FeedCommentsCss.test.ts): the phone layout,
// the touch targets and the reduced-motion paths are rules in the right blocks.
const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

// Every block that opens with `head`, from the head to its closing brace (not included).
const blocks = (css: string, head: string) => {
	const found: Array<string> = [];
	for (let start = css.indexOf(head); start >= 0; start = css.indexOf(head, start + 1)) {
		let depth = 0;
		for (let index = css.indexOf('{', start); index < css.length; index++) {
			if (css[index] === '{') depth++;
			else if (css[index] === '}' && --depth === 0) {
				found.push(css.slice(start, index));
				break;
			}
		}
	}
	return found;
};
const block = (css: string, head: string) => blocks(css, head)[0] ?? '';
const without = (css: string, parts: Array<string>) => parts.reduce((rest, part) => rest.replace(part, ''), css);
// The declarations of the rule whose whole selector is `selector` (a regular expression source), at any depth.
const rule = (css: string, selector: string) =>
	css.match(new RegExp(`(?:^|\\n)\\t*${selector} \\{([^}]*)\\}`))?.[1] ?? '';

// The desktop layout prefix (Fluxer's html.mobile-layout class, in the form of Button.module.css:89), as a regular
// expression.
const D = ':global\\(html:not\\(\\.auth-page\\):not\\(\\.mobile-layout\\)\\) ';
const FINE = '@media (hover: hover) and (pointer: fine) {';
const TOUCH = '@media (max-width: 640px), (pointer: coarse) {';
const REDUCED = '@media (prefers-reduced-motion: reduce) {';

describe('feed composer design', () => {
	const css = read('./FeedComposer.module.css');
	const fineBlocks = blocks(css, FINE);

	// a wide video filled only the top of its upload card (preflight's video height: auto won).
	it('fills the upload card with a picked video like an image', () => {
		expect(rule(css, '\\.images video:not\\(\\[data-embed-media\\]\\)')).toContain('height: 100%;');
	});

	it('keeps the phone text size and writes 15px on a 1.5 line only on the desktop layout', () => {
		expect(rule(css, '\\.field textarea')).toContain('font-size: 1.1875rem;');
		const desktop = rule(css, `${D}\\.field textarea`);
		expect(desktop).toContain('font-size: 0.9375rem;');
		expect(desktop).toContain('line-height: 1.5;');
	});

	it('pads the post box like a post on the desktop layout only, with border-color lines', () => {
		const base = rule(css, '\\.composer');
		expect(base).toContain('padding: 1rem 1rem 0.75rem;');
		expect(base).toContain('border-bottom: 0.0625rem solid var(--border-color);');
		expect(rule(css, `${D}\\.composer`)).toContain('padding: 1.125rem 1.25rem 0.875rem;');
		expect(rule(css, '\\.footer')).toContain('border-top: 0.0625rem solid var(--border-color);');
		expect(css).not.toContain('--background-modifier-accent');
	});

	it('leaves the Post button its Fluxer corner', () => {
		// Only X's bold pill in the coal and dark themes (FeedXLookCss.test.ts).
		expect(css.match(/\.postButton \{[^}]*border-radius/g)).toHaveLength(1);
		expect(css.match(/--radius-full/g)).toHaveLength(1);
	});

	it('squares the tool buttons and makes them 34px only for a fine pointer, so touch keeps 44px on the desktop layout', () => {
		expect(rule(css, '\\.toolButton')).toContain('border-radius: var(--radius-lg);');
		const desktop = rule(fineBlocks.join('\n'), `${D}\\.toolButton`);
		expect(desktop).toContain('width: 2.125rem;');
		expect(desktop).toContain('height: 2.125rem;');
		expect(without(css, fineBlocks)).not.toMatch(new RegExp(`${D}\\.toolButton \\{`));
		// A coarse pointer on the desktop layout skips the fine block and gets the touch block's 44px.
		const touch = rule(block(css, TOUCH), '\\.toolButton');
		expect(touch).toContain('width: 2.75rem;');
		expect(touch).toContain('height: 2.75rem;');
	});

	it('presses the tool buttons to 0.97, off under html.reduced-motion only', () => {
		expect(rule(css, '\\.toolButton:active')).toContain('transform: scale(0.97);');
		expect(css).toContain(':global(html.reduced-motion) .toolButton:active');
		expect(css).not.toContain(REDUCED);
	});
});

describe('feed processing row design', () => {
	const css = read('./FeedPendingVideos.module.css');

	it('draws the row on the card colour with a muted status and an accent meter on a modifier-accent track', () => {
		expect(rule(css, '\\.row')).toContain('background-color: var(--background-secondary-alt);');
		expect(rule(css, '\\.status')).toContain('color: var(--text-primary-muted);');
		expect(rule(css, '\\.meter')).toContain('background-color: var(--background-modifier-accent);');
		expect(rule(css, '\\.meterValue')).toContain('background-color: var(--brand-primary);');
		expect(rule(css, '\\.meterPulse')).toContain('background-color: var(--brand-primary);');
		expect(css).not.toContain(':global(.theme-light)');
	});

	it('presses Cancel to 0.97, off under html.reduced-motion only, and keeps 44px on touch', () => {
		expect(rule(css, '\\.cancel')).toContain('color: var(--text-primary-muted);');
		expect(rule(css, '\\.cancel:active')).toContain('transform: scale(0.97);');
		expect(css).toContain(':global(html.reduced-motion) .cancel:active');
		expect(css).not.toContain(REDUCED);
		const touch = rule(block(css, TOUCH), '\\.cancel');
		expect(touch).toContain('width: 2.75rem;');
		expect(touch).toContain('height: 2.75rem;');
	});
});

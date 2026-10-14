// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// happy-dom has no layout or media queries, so the stylesheets are read (like FeedPostCardCss.test.ts): the phone layout,
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

describe('feed comments design', () => {
	const card = read('./FeedPostCard.module.css');
	const comments = card.slice(card.indexOf('\n.comments {'), card.indexOf('\n.status {'));

	it('paints the inline comment panel with the card colour and drops the pill Send button', () => {
		expect(rule(comments, '\\.comments')).toContain('background-color: var(--background-secondary-alt);');
		// Only X's bold pill in the coal and dark themes (FeedXLookCss.test.ts).
		expect(card.match(/\.sendButton \{[^}]*border-radius/g)).toHaveLength(1);
	});

	it('squares the comment box and sizes the comment name only on the desktop layout', () => {
		// With innerActionButton the box is Textarea's wrapper (comment and reply boxes alike).
		const wrapper =
			"\\.commentComposerInput \\[data-flx='ui\\.form\\.input\\.textarea-with-actions\\.textarea-wrapper'\\]";
		expect(rule(comments, wrapper)).toContain('border-radius: 1.3125rem;');
		expect(comments).toContain(
			":global(html:not(.auth-page):not(.mobile-layout))\n\t.commentComposerInput\n\t[data-flx='ui.form.input.textarea-with-actions.textarea-wrapper'] {\n\tborder-radius: var(--radius-lg);",
		);
		// GIF and emoji inside the box, on its last row.
		const actions =
			"\\.commentComposerInput \\[data-flx='ui\\.form\\.input\\.textarea-with-actions\\.textarea-actions'\\]";
		expect(rule(comments, actions)).toContain('padding: 0.125rem 0.25rem;');
		expect(comments).not.toContain(':has(');
		expect(rule(comments, '\\.commentAuthor')).toContain('font-size: 0.875rem;');
		// Above D1's desktop .authorButton rules (0,3,1): the comment name keeps its own size.
		expect(rule(comments, `${D}\\.comment \\.commentAuthor`)).toContain('font-size: 0.8125rem;');
	});
});

describe('feed post page design', () => {
	const css = read('./pages/FeedPostDetail.module.css');
	const fineBlocks = blocks(css, FINE);
	const fine = fineBlocks.join('\n');
	const touch = block(css, TOUCH);

	it('draws the time line in the card with a divider under it', () => {
		const stamp = rule(css, '\\.cardStamp');
		expect(stamp).toContain('border-bottom: 0.0625rem solid var(--border-color);');
		expect(stamp).toContain('color: var(--text-primary-muted);');
		expect(stamp).toContain('font-size: 0.8125rem;');
	});

	it('gives See who liked 44px on touch, in the card as under it, and 2rem only for a fine pointer', () => {
		expect(rule(touch, '\\.likersButton')).toContain('min-height: 2.75rem;');
		expect(touch).not.toContain('.meta .likersButton');
		expect(rule(fine, `${D}\\.likersButton`)).toContain('height: 2rem;');
		expect(without(css, fineBlocks)).not.toMatch(new RegExp(`${D}\\.likersButton \\{[^}]*height:`));
	});

	it('squares See who liked, muted at rest and primary on the control hover colour', () => {
		const base = rule(css, '\\.likersButton');
		expect(base).toContain('border-radius: var(--radius-lg);');
		expect(base).toContain('color: var(--text-primary-muted);');
		const hover = rule(fine, '\\.likersButton:hover');
		expect(hover).toContain('background-color: var(--control-button-hover-bg);');
		expect(hover).toContain('color: var(--text-primary);');
		expect(without(css, fineBlocks)).not.toContain('.likersButton:hover');
	});

	it('pads the page comments like the post on the desktop layout only, under a divider in place of the time line', () => {
		expect(rule(css, '\\.comments > section')).toContain('padding: 1rem 1rem 0.75rem;');
		expect(rule(css, `${D}\\.comments > section`)).toContain('padding: 1rem 1.25rem 0.25rem;');
		// 16px above and below the comment box.
		expect(rule(css, '\\.comments > section > :first-child')).toContain('margin-bottom: 0.25rem;');
		expect(rule(css, `${D}\\.comments`)).toContain('border-top: 0.0625rem solid var(--border-color);');
	});

	it('no longer overrides the card hover (the card skips it on the post page itself)', () => {
		expect(css).not.toContain('article:hover');
	});
});

describe('feed replies design', () => {
	const css = read('./FeedReplies.module.css');
	const fineBlocks = blocks(css, FINE);

	it('keeps the phone thread line and draws the desktop one apart, stopping above the reply box', () => {
		const base = rule(css, '\\.thread');
		expect(base).toContain('padding-inline-start: 0.75rem;');
		expect(base).toContain('border-inline-start: 0.125rem solid var(--background-modifier-accent);');
		const desktop = rule(css, `${D}\\.thread`);
		expect(desktop).toContain('margin-inline-start: 1rem;');
		expect(desktop).toContain('padding-inline-start: 1.625rem;');
		expect(desktop).toContain('border-inline-start: none;');
		const line = rule(css, `${D}\\.thread::before`);
		expect(line).toContain('width: 0.125rem;');
		expect(line).toContain('bottom: 1.125rem;');
		expect(line).toContain('background: var(--background-modifier-accent);');
	});

	it('draws the author tag at 18px or more with a heavy, spaced label', () => {
		const tag = rule(css, '\\.authorTag');
		expect(tag).toContain('min-height: 1.125rem;');
		expect(tag).toContain('font-weight: 800;');
		expect(tag).toContain('letter-spacing: 0.04em;');
		expect(tag).not.toMatch(/[^-]height:/);
	});

	// Read from Fluxer's bot tag, so the two tags beside a name keep one look whatever its tokens become.
	it("paints the author tag with the bot tag's colour tokens", () => {
		const bot = rule(read('../../channel/components/ChannelUserTag.module.css'), '\\.tag');
		const tag = rule(css, '\\.authorTag');
		for (const property of ['background-color', 'color']) {
			const value = bot.match(new RegExp(`\\n\\t${property}: ([^;]+);`))?.[1];
			expect(value, property).toMatch(/^var\(--/);
			expect(tag).toMatch(new RegExp(`\\n\\t${property}: ${value?.replace(/[()]/g, '\\$&')};`));
		}
	});

	it('gives Reply and N replies a bold secondary label with room for an icon', () => {
		const button = rule(css, '\\.textButton');
		expect(button).toContain('display: inline-flex;');
		expect(button).toContain('gap: 0.375rem;');
		expect(button).toContain('color: var(--text-secondary);');
		expect(button).toContain('font-weight: 700;');
		const hover = rule(fineBlocks.join('\n'), '\\.textButton:hover');
		expect(hover).toContain('background: var(--control-button-hover-bg);');
		expect(hover).toContain('color: var(--text-primary);');
		expect(without(css, fineBlocks)).not.toContain('.textButton:hover');
	});

	it('presses Reply to 0.97, off under html.reduced-motion only', () => {
		expect(rule(css, '\\.textButton:active')).toContain('transform: scale(0.97);');
		expect(css).toContain(':global(html.reduced-motion) .textButton:active');
		expect(css).not.toContain(REDUCED);
	});

	it('keeps 44px Reply buttons on touch', () => {
		expect(rule(block(css, TOUCH), '\\.textButton')).toContain('min-height: 2.75rem;');
	});
});

describe('feed likers design', () => {
	const css = read('./FeedLikers.module.css');

	it('rounds the rows 10px and sizes the names only on the desktop layout', () => {
		expect(rule(css, '\\.row')).toContain('border-radius: 0.625rem;');
		expect(rule(css, '\\.name')).toContain('font-size: 0.9375rem;');
		expect(rule(css, '\\.tag')).toContain('font-size: 0.8125rem;');
		const name = rule(css, `${D}\\.name`);
		expect(name).toContain('font-size: 0.8125rem;');
		expect(name).toContain('font-weight: 700;');
		expect(rule(css, `${D}\\.tag`)).toContain('font-size: 0.75rem;');
	});
});

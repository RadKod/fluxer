// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// Micup: the X "Lights out" look of the feed, in the coal and dark themes only. happy-dom has no layout
// or media queries, so the stylesheets are read (like FeedPageCss.test.ts), without comments and on one line: the
// formatter breaks long selectors over lines.
const source = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
const read = (file: string) =>
	source(file)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\s+/g, ' ');

const X = ':global(html:is(.theme-coal, .theme-dark):not(:has(#fluxer-custom-theme-style)))';
// A rule whose target is a pseudo-element or a bare tag keeps only the theme gate: Chromium cannot scope a :has() root
// for it and restyles the whole page on every DOM change (RootHasSelectorsCss.test.ts).
const THEME = ':global(html:is(.theme-coal, .theme-dark))';
const FINE = '@media (hover: hover) and (pointer: fine) {';
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The declarations of every X rule for `selector`, alone or in a selector list.
const x = (css: string, selector: string, prefix = X) =>
	[...css.matchAll(new RegExp(`(?:^|[{},]) *${escapeRegExp(`${prefix} ${selector}`)}(?:,[^{]*)? \\{([^}]*)\\}`, 'g'))]
		.map((found) => found[1])
		.join(' ');

// The fine-pointer blocks, joined.
const fine = (css: string) =>
	css
		.split(FINE)
		.slice(1)
		.map((part) => {
			let depth = 1;
			for (let index = 0; index < part.length; index++) {
				if (part[index] === '{') depth++;
				else if (part[index] === '}' && --depth === 0) return part.slice(0, index);
			}
			return part;
		})
		.join(' ');

const TINT_WHITE = 'var(--text-primary)';

describe('feed X look in the coal and dark themes', () => {
	const page = read('./pages/FeedPage.module.css');
	const detail = read('./pages/FeedPostDetail.module.css');
	const aside = read('./FeedProfileAside.module.css');
	const list = read('./FeedTimelineList.module.css');
	const card = read('./FeedPostCard.module.css');
	const composer = read('./FeedComposer.module.css');

	// no column lines beside the feed; the rail drops its own line too.
	it('paints the feed black without column lines; the rail drops its line and titles the card at 20px', () => {
		expect(x(page, '.main')).toContain('background-color: var(--background-secondary-lighter);');
		expect(page).not.toMatch(/custom-theme-style\)\)\) \.timeline/);
		expect(x(aside, '.aside')).toContain('border-inline-start: none;');
		expect(x(aside, '.name')).toContain('font-size: 1.25rem;');
	});

	// the header tabs stay where they were; only the title takes X's 20px.
	it('keeps the header tabs as they were and gives the title 20px', () => {
		expect(x(page, '.feedTitle')).toContain('font-size: 1.25rem;');
		expect(page).not.toMatch(/custom-theme-style\)\)\) \.tab/);
	});

	it('draws X rows: 12/16px padding, a 15px header with the muted handle and time, 17px text on the post page', () => {
		expect(x(card, '.post')).toContain('padding: 0.75rem 1rem;');
		expect(x(card, '.header')).toContain('font-size: 0.9375rem;');
		for (const part of ['.tag', '.timestamp', '.publicMarker']) {
			expect(x(card, part)).toContain('color: var(--text-tertiary);');
		}
		expect(x(card, '.pageVariant .content')).toContain('font-size: 1.0625rem;');
		expect(x(detail, '.cardStamp')).toContain('color: var(--text-tertiary);');
		expect(x(detail, '.stamp')).toContain('font-size: 0.9375rem;');
	});

	it('lines the images with the border colour, through the image wrapper of the post card', () => {
		expect(x(card, '.media')).toContain('margin-top: 0.5rem;');
		expect(x(card, ".media[data-flx='feed.feed-post-card.media'] :is(img, video)", THEME)).toContain(
			'outline: 0.0625rem solid var(--border-color);',
		);
		expect(source('./FeedPostCard.tsx')).toContain('data-flx="feed.feed-post-card.media"');
	});

	it('spreads the actions over 425px, muted, with white and pink circles behind the icon for a mouse only', () => {
		const actions = x(card, '.actions');
		expect(actions).toContain('justify-content: space-between;');
		expect(actions).toContain('max-width: 26.5625rem;');
		expect(x(card, '.actionsEnd')).toContain('margin-inline-start: 0;');
		const rest = x(card, '.viewCount');
		expect(rest).toContain('color: var(--text-tertiary);');
		expect(rest).toContain(`--feed-tint: ${TINT_WHITE};`);
		expect(x(card, '.likeButton')).toContain('--feed-tint: var(--feed-like);');
		const hover = fine(card);
		expect(x(hover, '.viewCount:hover')).toContain('color: var(--feed-tint);');
		expect(x(hover, '.viewCount:hover .actionIcon')).toContain(
			'box-shadow: 0 0 0 0.5rem color-mix(in srgb, var(--feed-tint) 10%, transparent);',
		);
	});

	it("makes the primary buttons X's bold pill: Follow, Send, Post and Go to Discover", () => {
		expect(x(card, '.followPill')).toContain('font-weight: 700;');
		expect(x(card, '.followPill:disabled')).toContain('opacity: 0.5;');
		for (const [css, selector, prefix] of [
			[card, '.sendButton', X],
			[composer, '.postButton', X],
			[list, '.empty .emptyActions > button', THEME],
		] as const) {
			const pill = x(css, selector, prefix);
			expect(pill, selector).toContain('border-radius: var(--radius-full);');
			expect(pill, selector).toContain('font-weight: 700;');
		}
	});

	it("gives the composer X's 20px text, a muted placeholder and round white tools", () => {
		expect(x(composer, '.composer')).toContain('padding: 0.75rem 1rem;');
		expect(x(composer, '.field textarea', THEME)).toContain('font-size: 1.25rem;');
		expect(x(composer, '.field textarea::placeholder', THEME)).toContain('color: var(--text-tertiary);');
		const tool = x(composer, '.toolButton');
		expect(tool).toContain('border-radius: 50%;');
		expect(tool).toContain(`color: ${TINT_WHITE};`);
	});
});

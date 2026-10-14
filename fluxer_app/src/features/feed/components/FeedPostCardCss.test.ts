// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// happy-dom has no layout or media queries, so the stylesheets are read (like FeedPageCss.test.ts): the phone layout,
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

// The desktop layout prefix (Fluxer's html.mobile-layout class, in the form of Button.module.css:89), as a regular
// expression.
const D = ':global\\(html:not\\(\\.auth-page\\):not\\(\\.mobile-layout\\)\\) ';
const FINE = '@media (hover: hover) and (pointer: fine) {';
const TOUCH = '@media (max-width: 640px), (pointer: coarse) {';
const REDUCED = '@media (prefers-reduced-motion: reduce) {';

describe('feed post card design', () => {
	const css = read('./FeedPostCard.module.css');
	// The file has more than one fine-pointer block: take all of them, and the rest of the file without them.
	const fineBlocks = blocks(css, FINE);
	const fine = fineBlocks.join('\n');
	const outsideFine = fineBlocks.reduce((rest, found) => rest.replace(found, ''), css);
	const touch = block(css, TOUCH);

	it('colours only the liked heart icon pink, darker in the light theme; the count stays muted', () => {
		expect(css).toMatch(
			/\.post \{[^}]*--feed-like: hsl\(332\.3, calc\(94\.9% \* var\(--saturation-factor\)\), 53\.5%\);/,
		);
		expect(css).toMatch(
			/:global\(\.theme-light\) \.post \{\s*--feed-like: hsl\(332\.3, calc\(94\.9% \* var\(--saturation-factor\)\), 40%\);/,
		);
		expect(css).toMatch(/\.actionButtonActive \.actionIcon \{[^}]*color: var\(--feed-like\);/);
		expect(css).not.toMatch(/\.actionButtonActive \{[^}]*color:/);
		// Danger red only for Unfollow on a hovered follow pill (akis-takip), never on the like. [^{}] keeps each match to
		// one rule, not an @media block around it.
		expect([...css.matchAll(/([^{}]+)\{[^{}]*--status-danger/g)].map((found) => found[1]!.trim())).toEqual([
			'.followPillFollowing:hover',
		]);
	});

	it('tints the like button pink on hover, icon only, and the other actions with the control hover colour', () => {
		expect(fine).toMatch(
			/\.actionButton:hover \{[^}]*background: var\(--control-button-hover-bg\);[^}]*color: var\(--text-primary\);/,
		);
		expect(fine).toMatch(
			/\.likeButton:hover \{[^}]*background: color-mix\(in srgb, var\(--feed-like\) 10%, transparent\);/,
		);
		expect(fine).toMatch(/\.likeButton:hover \.actionIcon \{[^}]*color: var\(--feed-like\);/);
		expect(outsideFine).not.toMatch(/\.actionButton:hover/);
	});

	it('keeps the phone layout: base padding, font size and action gap as today', () => {
		expect(css).toMatch(/\n\.post \{[^}]*padding: 0\.875rem 1rem 0\.625rem;/);
		expect(css).toMatch(/\n\.header \{[^}]*font-size: 0\.9375rem;/);
		expect(css).toMatch(/\n\.actions \{[^}]*gap: 1\.5rem;/);
		expect(css).toMatch(new RegExp(`${D}\\.post \\{[^}]*padding: 1rem 1\\.25rem 0\\.625rem;`));
		expect(css).toMatch(new RegExp(`${D}\\.actions \\{[^}]*gap: 0\\.25rem;`));
		expect(css).not.toMatch(/@media \(min-width/);
	});

	it('gives the post text the chat colour, and the post page a bigger text on the desktop layout', () => {
		expect(css).toMatch(/\n\.content \{[^}]*color: var\(--text-chat\);/);
		expect(css).toMatch(new RegExp(`${D}\\.pageVariant \\.content \\{[^}]*font-size: 1\\.0625rem;`));
	});

	it('shrinks buttons only for a fine pointer, so touch keeps 44px on the desktop layout', () => {
		expect(fine).toMatch(new RegExp(`${D}\\.moreButton \\{[^}]*width: 1\\.75rem;`));
		expect(outsideFine).not.toMatch(new RegExp(`${D}\\.moreButton \\{[^}]*width:`));
		expect(touch).toMatch(/\.moreButton,[\s\S]*min-width: 2\.75rem;/);
	});

	it('squares the corners of the "..." and action buttons', () => {
		expect(css).toMatch(/\n\.moreButton \{[^}]*border-radius: var\(--radius-lg\);/);
		expect(css).toMatch(/\n\.actionButton \{[^}]*border-radius: var\(--radius-lg\);/);
	});

	it('hovers a timeline row with modifier-hover outside the light theme, never the post page card', () => {
		expect(css).toMatch(
			/:global\(html:not\(\.theme-light\)\) \.post:not\(\.pageVariant\):hover \{[^}]*var\(--background-modifier-hover\)/,
		);
		expect(fine).toMatch(/\n\t\.post:not\(\.pageVariant\):hover \{[^}]*var\(--background-secondary-alt\)/);
		expect(css).not.toMatch(/\.post:hover/);
	});

	it('presses buttons to 0.97, off under html.reduced-motion only', () => {
		for (const sel of ['.actionButton:active', '.moreButton:active']) {
			expect(css).toContain(`${sel} {`);
			expect(css).toContain(`:global(html.reduced-motion) ${sel}`);
		}
		expect(css).toMatch(/\.actionButton:active \{[^}]*transform: scale\(0\.97\);/);
		expect(css).not.toContain(REDUCED);
	});

	it('puts the action row end slot at the end of the row', () => {
		expect(css).toMatch(/\n\.actionsEnd \{[^}]*margin-inline-start: auto;/);
	});

	it('the view count (eye icon and number) sits at the end of the action row in the muted count colour', () => {
		expect(css).toMatch(
			/\n\.viewCount \{[^}]*margin-inline-start: auto;[^}]*color: var\(--text-primary-muted\);[^}]*font-size: 0\.8125rem;/,
		);
		expect(css).toMatch(/\n\.viewCount \{[^}]*display: inline-flex;[^}]*align-items: center;/);
		// The post page's likers button after it keeps to the count instead of taking the row end.
		expect(css).toMatch(/\n\.viewCount \+ \.actionsEnd \{[^}]*margin-inline-start: 0;/);
		expect(css.indexOf('.viewCount + .actionsEnd {')).toBeGreaterThan(css.indexOf('\n.actionsEnd {'));
	});

	it('the follow pill uses the accent with its on-brand text, the outline tokens once following, and no fixed colour', () => {
		expect(css).toMatch(
			/\n\.followPill \{[^}]*background: var\(--brand-primary\);[^}]*color: var\(--text-on-brand-primary\);/,
		);
		expect(css).toMatch(
			/\n\.followPillFollowing \{[^}]*border-color: var\(--background-modifier-accent\);[^}]*background: transparent;[^}]*color: var\(--text-primary\);/,
		);
		// Unfollow in the danger colour replaces Following on a mouse hover only: a tap on touch leaves a sticky :hover, which
		// would show Unfollow right after the follow (kod-inceleme Önemli-1).
		expect(fine).toMatch(
			/\.followPillFollowing:hover \{[^}]*border-color: var\(--status-danger\);[^}]*color: var\(--status-danger\);/,
		);
		expect(css).toMatch(/\n\.followHoverLabel \{[^}]*display: none;/);
		expect(fine).toMatch(/\.followPillFollowing:hover \.followIdleLabel \{[^}]*display: none;/);
		expect(fine).toMatch(/\.followPillFollowing:hover \.followHoverLabel \{[^}]*display: inline;/);
		expect(outsideFine).not.toMatch(/\.followPillFollowing:hover/);
		const followRules = [...css.matchAll(/[^{}]*\.follow\w*[^{}]*\{[^}]*\}/g)].map((found) => found[0]).join('\n');
		expect(followRules).toContain('.followPill');
		expect(followRules).not.toMatch(
			/(color|background|border[\w-]*):[^;]*(#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(white|black)\b)/i,
		);
	});

	it('keeps the header on one line with the pill: it neither shrinks nor wraps, is no taller than the "..." button, and the name gives way', () => {
		expect(css).toMatch(/\n\.followPill \{[^}]*flex-shrink: 0;[^}]*height: 1\.75rem;[^}]*white-space: nowrap;/);
		// The "..." button is 28px with a mouse and 44px on touch, so a 28px pill never makes the header taller.
		expect(fine).toMatch(new RegExp(`${D}\\.moreButton \\{[^}]*height: 1\\.75rem;`));
		expect(css).not.toMatch(/flex-wrap/);
		expect(css).toMatch(
			/\n\.authorButton \{[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/,
		);
		// Touch gets a 44px target around the pill instead of a taller pill.
		expect(touch).toMatch(/\.followPill::before \{[^}]*position: absolute;[^}]*inset: -0\.5rem 0;/);
		expect(touch).not.toMatch(/\.followPill[^{]*\{[^}]*min-height/);
	});

	it('never gives a post or its text a fixed height', () => {
		expect(css).not.toMatch(/\.(post|content|header) \{[^}]*[^-]height:/);
	});
});

// The profile header's Follow button shares the pill's hover rule (ProfileFollowActions.module.css).
describe('profile follow button design', () => {
	const css = read('../../follow/components/ProfileFollowActions.module.css');
	const fineBlocks = blocks(css, FINE);
	const outsideFine = fineBlocks.reduce((rest, found) => rest.replace(found, ''), css);

	it('shows Unfollow in the danger colour on a mouse hover only, so a tap on touch leaves Following', () => {
		expect(css).toMatch(/\n\.followHoverLabel \{[^}]*display: none;/);
		expect(fineBlocks.join('\n')).toMatch(/\.followingButton:hover \.followIdleLabel \{[^}]*display: none;/);
		expect(fineBlocks.join('\n')).toMatch(
			/\.followingButton:hover \.followHoverLabel \{[^}]*display: inline;[^}]*color: var\(--status-danger\);/,
		);
		expect(outsideFine).not.toMatch(/\.followingButton:hover/);
	});
});

describe('feed video box design', () => {
	const css = read('./FeedVideo.module.css');

	it('draws the box border and the play shadow', () => {
		expect(css).toMatch(/\n\.video \{[^}]*border: 0\.0625rem solid var\(--background-modifier-accent\);/);
		expect(css).toMatch(/\n\.play \{[^}]*box-shadow: var\(--shadow-lg\);/);
	});

	it('grows the play circle on hover for a fine pointer only and presses it to 0.97', () => {
		expect(block(css, FINE)).toMatch(/\.poster:hover \.play \{[^}]*transform: scale\(1\.06\);/);
		expect(blocks(css, FINE).reduce((rest, found) => rest.replace(found, ''), css)).not.toMatch(
			/\.poster:hover \.play \{[^}]*scale/,
		);
		expect(css).toMatch(/\n\.poster:active \.play \{[^}]*transform: scale\(0\.97\);/);
	});

	it('turns the play motion off under html.reduced-motion only', () => {
		for (const sel of ['.poster:hover .play', '.poster:active .play']) {
			expect(css).toContain(`:global(html.reduced-motion) ${sel}`);
		}
		expect(css).toMatch(/:global\(html\.reduced-motion\) \.poster:active \.play \{[^}]*transform: none;/);
		expect(css).not.toContain(REDUCED);
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// The profile rail beside the feed hides by a container query on the feed page body. happy-dom has no layout or media
// queries, so the stylesheets are read: dropping the container, renaming a class or moving one width without the
// other fails here, and so does a desktop rule leaking into the phone layout.
const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
const rem = (css: string, pattern: RegExp) => Number(css.match(pattern)?.[1]);

// The first block that opens with `head`, from the head to its closing brace (not included).
const block = (css: string, head: string) => {
	const start = css.indexOf(head);
	if (start < 0) return '';
	let depth = 0;
	for (let index = css.indexOf('{', start); index < css.length; index++) {
		if (css[index] === '{') depth++;
		else if (css[index] === '}' && --depth === 0) return css.slice(start, index);
	}
	return '';
};

// The desktop layout prefix (Fluxer's html.mobile-layout class, in the form of Button.module.css:89), as a regular
// expression.
const D = ':global\\(html:not\\(\\.auth-page\\):not\\(\\.mobile-layout\\)\\) ';
const TOUCH = '@media (max-width: 640px), (pointer: coarse) {';

const page = read('./FeedPage.module.css');
const aside = read('../FeedProfileAside.module.css');
const list = read('../FeedTimelineList.module.css');

describe('feed page width breakpoint', () => {
	it('makes the feed page body the inline-size container', () => {
		expect(page).toMatch(/\.body \{[^}]*container-type: inline-size;/);
	});

	it('hides the profile rail exactly below the column and the rail side by side', () => {
		const column = rem(page, /\n\.timeline \{[^}]*max-width: ([\d.]+)rem;/);
		const rail = rem(aside, /\n\.aside \{[^}]*width: ([\d.]+)rem;/);
		const breakpoint = rem(aside, /@container \(max-width: ([\d.]+)rem\) \{\s*\.aside \{\s*display: none;/);
		expect([column, rail]).toEqual([37.5, 19.75]);
		expect(breakpoint).toBe(column + rail);
		// The rail's padding and line count in its width.
		expect(aside).toMatch(/\n\.aside \{[^}]*box-sizing: border-box;/);
	});

	it('centres the column in the space beside the rail, with no gap and no column lines', () => {
		expect(page).toMatch(/\n\.timeline \{[^}]*margin-inline: auto;/);
		expect(page).not.toMatch(/\.body \{[^}]*(gap|justify-content):/);
		expect(page).not.toContain('border-inline');
		expect(aside).toMatch(/\n\.aside \{[^}]*border-inline-start: 0\.0625rem solid var\(--border-color\);/);
	});
});

describe('feed page frame design', () => {
	// Only "Feed" before the tabs shrinks: .headerTitle is also the sidebar title (composes), "Post" and "Your posts".
	it('keeps the phone header sizes and shrinks the Feed title and tabs on the desktop layout only', () => {
		expect(page).toMatch(/\n\.headerTitle \{[^}]*font-size: 1\.25rem;/);
		expect(page).toMatch(/\n\.tabList \{[^}]*gap: 1rem;/);
		expect(page).toMatch(/\n\.tab \{[^}]*font-size: 1rem;/);
		expect(page).toMatch(new RegExp(`${D}\\.feedTitle \\{[^}]*font-size: 0\\.9375rem;`));
		expect(page).not.toMatch(new RegExp(`${D}\\.headerTitle`));
		expect(page).toMatch(new RegExp(`${D}\\.tabList \\{[^}]*gap: 1\\.125rem;`));
		expect(page).toMatch(new RegExp(`${D}\\.tab \\{[^}]*font-size: 0\\.875rem;`));
		expect(page).toMatch(/\n\.headerDivider \{[^}]*height: 1\.375rem;[^}]*background: var\(--border-color-hover\);/);
		expect(page).not.toMatch(/@media \(min-width/);
	});

	// Micup: the feed sidebar rows are the DM list rows (DMListPageItems.tsx, DirectMessageList.module.css): the feed has
	// no row rules of its own that could drift from them.
	it('leaves the sidebar rows to the DM list stylesheet', () => {
		expect(page).not.toMatch(/\.(feedNav|navItem)/);
	});

	it('divides the posts with a border on the row the virtual list measures, never a margin (K6)', () => {
		expect(list).toMatch(/\n\.row \{[^}]*border-bottom: 0\.0625rem solid var\(--border-color\);/);
		expect(list).not.toMatch(/\n\.rows? \{[^}]*margin[\w-]*:/);
	});

	it('gives the titled empty feed a dashed icon box and a larger padding on the desktop layout only', () => {
		expect(list).toMatch(/\n\.empty \{[^}]*padding: 1\.5rem 1rem;/);
		expect(list).toMatch(new RegExp(`${D}\\.empty \\{[^}]*padding: 6\\.875rem 1\\.5rem;`));
		expect(list).toMatch(
			/\n\.emptyIcon \{[^}]*border: 0\.0625rem dashed var\(--background-modifier-accent-focus\);[^}]*border-radius: 30%;/,
		);
		expect(list).toMatch(/\n\.emptyText \{[^}]*max-width: 40ch;/);
	});

	it('draws the rail card on the card surface, clipped round its cover, with a square-cornered Fluxer button', () => {
		expect(aside).toMatch(/\n\.card \{[^}]*overflow: hidden;[^}]*background-color: var\(--background-secondary-alt\);/);
		expect(aside).toMatch(
			/\n\.avatar \{[^}]*margin-top: -2\.5rem;[^}]*box-shadow: 0 0 0 0\.3125rem var\(--background-secondary-alt\);/,
		);
		expect(aside).not.toMatch(/--radius-full/);
		expect(aside).not.toMatch(/\.card \{[^}]*[^-]height:/);
	});
});

describe('feed 44px touch targets on narrow screens and touch', () => {
	const post = block(read('../FeedPostCard.module.css'), TOUCH);
	const asideTouch = block(aside, TOUCH);
	const insetPx = (pattern: RegExp) => -Number(post.match(pattern)?.[1]) * 16;

	// "Add option" is a small Button (min-height from .button.small, 0,2,0) and the length picker a compact Combobox
	// (34px input group); the picker's input fills the group so the whole 44px opens it.
	it('gives the poll editor Add option button and length picker 44px', () => {
		const poll = block(read('../FeedPollEditor.module.css'), TOUCH);
		expect(poll).toMatch(/\.editor \.footer \.addOption \{\s*min-height: 2\.75rem;/);
		expect(poll).toMatch(/\.length \[data-flx='ui\.form\.combobox\.input-group'\] \{\s*min-height: 2\.75rem;/);
		expect(poll).toMatch(/\.length \[data-flx='ui\.form\.combobox\.input'\] \{\s*align-self: stretch;/);
	});

	it('gives the profile card button a 44px minimum height', () => {
		expect(asideTouch).toMatch(/\.aside \.card \.postsButton \{\s*min-height: 2\.75rem;/);
	});

	// The Discover button is a small Button (.button.small, 0,2,0): two classes and the element outrank it.
	it("gives the empty feed's Discover button a 44px minimum height", () => {
		expect(block(list, TOUCH)).toMatch(/\.empty \.emptyActions > button \{\s*min-height: 2\.75rem;/);
	});

	// The names stay inline text: a 44px name would push a one-line comment from 44 to 64px. The avatar
	// beside each name opens the same profile and carries the 44px target (WCAG 2.5.8 equivalent control).
	it('keeps the author names at text height', () => {
		expect(post).not.toMatch(/(authorButton|commentAuthor)[^{]*\{[^}]*min-height/);
	});

	// A top-level comment on the post page has a 32px avatar on the desktop layout only; touch there gets 52px.
	it('grows the hit area around the 40px post avatar and the comment avatars to 44px or more, not the avatars', () => {
		expect(post).toMatch(/\.avatarButton \{\s*position: relative;/);
		expect(post).toMatch(/\n\t\.avatarButton::before \{\s*content: '';\s*position: absolute;/);
		expect(40 + 2 * insetPx(/\n\t\.avatarButton::before \{[^}]*inset: (-[\d.]+)rem;/)).toBe(44);
		const comment = insetPx(/\.comment \.avatarButton::before \{[^}]*inset: (-[\d.]+)rem;/);
		expect(24 + 2 * comment).toBe(44);
		expect(32 + 2 * comment).toBe(52);
	});
});

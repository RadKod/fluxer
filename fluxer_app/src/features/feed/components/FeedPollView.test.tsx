// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {FeedPoll, FeedPost} from '@app/features/feed/state/FeedTimeline';
import {act, cloneElement, createElement, type ReactElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Fills {name} and a "{count, plural, one {# x} other {# y}}" message, enough to read the rendered text.
function format(message: string, values: Record<string, unknown> = {}): string {
	return message
		.replace(/\{count, plural, one \{# ([^}]+)\} other \{# ([^}]+)\}\}/, (_, one: string, other: string) =>
			values.count === 1 ? `1 ${one}` : `${values.count} ${other}`,
		)
		.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]));
}

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({
		i18n: {
			_: (descriptor: {message: string}, values?: Record<string, unknown>) => format(descriptor.message, values),
			number: (value: number, options?: Intl.NumberFormatOptions) =>
				new Intl.NumberFormat('en-US', options).format(value),
		},
	}),
}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: '1'}}));
vi.mock('@app/features/feed/commands/FeedCommands', () => ({votePoll: vi.fn(async () => 'ok')}));
vi.mock('@app/features/feed/components/FeedItemMenu', () => ({toastFeedFailure: vi.fn()}));
vi.mock('@app/features/user/utils/DateFormatting', () => ({getRelativeDateString: () => 'Tomorrow at 10:00'}));
// The FocusRing mock marks the element it wraps, so a test can see which controls get Fluxer's focus ring.
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({
	default: ({children}: {children: ReactElement<Record<string, unknown>>}) =>
		cloneElement(children, {'data-focus-ring': ''}),
}));

const FeedCommands = await import('@app/features/feed/commands/FeedCommands');
const {toastFeedFailure} = await import('@app/features/feed/components/FeedItemMenu');
const {FeedPollView} = await import('@app/features/feed/components/FeedPollView');
const {default: styles} = await import('@app/features/feed/components/FeedPollView.module.css');

const OPEN = '2999-01-01T00:00:00.000Z';
const ENDED = '2020-01-01T00:00:00.000Z';

function postWith(poll: FeedPoll, authorId = '7'): FeedPost {
	return {id: '100', author: {id: authorId}, poll} as unknown as FeedPost;
}

describe('FeedPollView', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = (post: FeedPost) => act(() => root.render(createElement(FeedPollView, {post})));
	const voteButtons = () => [...container.querySelectorAll<HTMLButtonElement>('button')];

	it('offers the options as buttons before voting and calls votePoll', async () => {
		let answer: (outcome: 'ok' | 'failed') => void = () => {};
		vi.mocked(FeedCommands.votePoll).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		render(postWith({options: ['Tea', 'Coffee'], expiresAt: OPEN, votes: null, voted: null}));
		const buttons = voteButtons();
		expect(buttons.map((button) => button.textContent)).toEqual(['Tea', 'Coffee']);
		expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['Vote for Tea', 'Vote for Coffee']);
		expect(container.textContent).toContain('Ends Tomorrow at 10:00');
		act(() => buttons[1].click());
		expect(FeedCommands.votePoll).toHaveBeenCalledWith('100', 1);
		// No second vote while the first one is on its way.
		expect(voteButtons().every((button) => button.disabled)).toBe(true);
		await act(async () => answer('failed'));
		expect(toastFeedFailure).toHaveBeenCalledWith(expect.anything(), 'failed');
		expect(voteButtons().every((button) => !button.disabled)).toBe(true);
	});

	it("gives every vote button Fluxer's focus ring", () => {
		render(postWith({options: ['Tea', 'Coffee'], expiresAt: OPEN, votes: null, voted: null}));
		expect(voteButtons()).toHaveLength(2);
		for (const button of voteButtons()) expect(button.hasAttribute('data-focus-ring')).toBe(true);
	});

	it('shows bars, counts and your choice once results are there', () => {
		render(postWith({options: ['Tea', 'Coffee', 'Water'], expiresAt: OPEN, votes: [1, 3, 0], voted: 1}));
		expect(voteButtons()).toHaveLength(0);
		const rows = [...container.querySelectorAll('li')];
		expect(rows).toHaveLength(3);
		expect(rows[0].textContent).toContain('Tea');
		expect(rows[0].textContent).toContain('25%');
		expect(rows[0].textContent).toContain('1 vote');
		expect(rows[1].textContent).toContain('75%');
		expect(rows[1].textContent).toContain('3 votes');
		expect(rows[2].textContent).toContain('0%');
		expect(rows[1].querySelector('[aria-label="Your vote"]')).not.toBeNull();
		expect(rows[0].querySelector('[aria-label="Your vote"]')).toBeNull();
		expect(container.textContent).toContain('4 votes');
		expect(container.querySelector('[role="img"][aria-label="Your vote"]')).not.toBeNull();
	});

	it('shows results without buttons to the author and after it ends', () => {
		render(postWith({options: ['Tea', 'Coffee'], expiresAt: OPEN, votes: [2, 2], voted: null}, '1'));
		expect(voteButtons()).toHaveLength(0);
		expect(container.textContent).toContain('50%');

		render(postWith({options: ['Tea', 'Coffee'], expiresAt: ENDED, votes: [0, 0], voted: null}));
		expect(voteButtons()).toHaveLength(0);
		expect(container.textContent).toContain('Poll ended');
		expect(container.textContent).toContain('0 votes');
		expect(container.textContent).not.toContain('Ends');
	});

	it('draws a result as a box with its fill behind the text, sized by the share', () => {
		render(postWith({options: ['Tea', 'Coffee'], expiresAt: OPEN, votes: [1, 3], voted: null}, '1'));
		const rows = [...container.querySelectorAll('li')];
		expect(rows[1].classList).toContain(styles.result);
		const bar = rows[1].firstElementChild as HTMLElement;
		expect(bar.dataset.flx).toBe('feed.feed-poll-view.bar');
		expect(bar.style.width).toBe('75%');
		expect(bar.getAttribute('aria-hidden')).toBe('true');
		expect(rows[1].children[1].classList).toContain(styles.resultLine);
		expect(container.querySelector('[data-flx="feed.feed-poll-view.track"]')).toBeNull();
	});

	it('marks your answer with the mine class and the tick', () => {
		render(postWith({options: ['Tea', 'Coffee'], expiresAt: OPEN, votes: [1, 3], voted: 1}));
		const rows = [...container.querySelectorAll('li')];
		expect(rows[1].classList).toContain(styles.mine);
		expect(rows[0].classList).not.toContain(styles.mine);
		expect(rows[1].querySelector('[data-flx="feed.feed-poll-view.check"]')).not.toBeNull();
		expect(rows[0].querySelector('[data-flx="feed.feed-poll-view.check"]')).toBeNull();
	});

	it('no results in the DOM while votes is null', () => {
		render(postWith({options: ['Tea', 'Coffee'], expiresAt: OPEN, votes: null, voted: null}));
		expect(container.textContent).not.toMatch(/%|votes?\b/);
		// Nor for the author or after the end, should a server ever leave them out there: options only, no buttons.
		render(postWith({options: ['Tea', 'Coffee'], expiresAt: ENDED, votes: null, voted: null}, '1'));
		expect(voteButtons()).toHaveLength(0);
		expect(container.textContent).toContain('Tea');
		expect(container.textContent).not.toMatch(/%|votes?\b/);
	});
});

// happy-dom has no layout or media queries, so the stylesheet is read (like FeedComposerCss.test.ts).
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

describe('feed poll design', () => {
	const css = read('./FeedPollView.module.css');
	const fineBlocks = blocks(css, FINE);

	it('draws every answer as a 40px squared box, written before the touch block so touch keeps 44px', () => {
		const box = rule(css, '\\.voteButton,\\s+\\.optionText,\\s+\\.result');
		expect(box).toContain('min-height: 2.5rem;');
		expect(box).toContain('border-radius: var(--radius-lg);');
		expect(box).toContain('border: 0.0625rem solid var(--background-modifier-accent);');
		expect(box).toContain('background: var(--background-textarea);');
		expect(css).not.toMatch(/[^-]height:/);
		expect(css).not.toContain('--radius-full');
		// Same specificity: the later rule wins, so the 40px box must come before the touch block's 44px.
		expect(css.indexOf('min-height: 2.5rem')).toBeLessThan(css.indexOf(TOUCH));
		expect(rule(block(css, TOUCH), '\\.voteButton')).toContain('min-height: 2.75rem;');
	});

	it('fills a result from its start edge behind the text, without animation', () => {
		// After a blank line: the rule of its own, not the shared box list that also ends in `.result`.
		const result = rule(css, '\\n\\.result');
		expect(result).toContain('position: relative;');
		expect(result).toContain('overflow: hidden;');
		const bar = rule(css, '\\.bar');
		expect(bar).toContain('position: absolute;');
		expect(bar).toContain('inset-block: 0;');
		expect(bar).toContain('inset-inline-start: 0;');
		expect(bar).toContain('background: var(--control-button-active-bg);');
		// A virtualised row mounts again on every scroll back, so an animated fill would replay: only the press moves.
		expect(css).not.toMatch(/animation|transition: (?!transform|none)/);
		expect(rule(css, '\\.resultLine')).toContain('position: relative;');
		expect(css).not.toContain('.track');
		expect(css).not.toMatch(/\.mine \.bar/);
	});

	// The mobile layout (phones, tablets and the 640-768px hysteresis) keeps the 28rem cap; the desktop column lifts it.
	it('caps the poll at 28rem on the mobile layout and lifts the cap on the desktop layout only', () => {
		expect(rule(css, '\\.poll')).toContain('max-width: 28rem;');
		expect(rule(css, `${D}\\.poll`)).toContain('max-width: none;');
	});

	it('outlines your answer with the brand colour and keeps the counts readable on the fill', () => {
		expect(rule(css, '\\.mine')).toContain('border-color: var(--brand-primary);');
		expect(rule(css, '\\.count')).toContain('color: var(--text-secondary);');
		const share = rule(css, '\\.share');
		expect(share).toContain('color: var(--text-primary);');
		expect(share).toContain('font-weight: 600;');
	});

	it('hovers a vote button with a stronger border for a fine pointer only', () => {
		expect(rule(fineBlocks.join('\n'), '\\.voteButton:hover:not\\(:disabled\\)')).toContain(
			'border-color: var(--background-modifier-accent-focus);',
		);
		expect(without(css, fineBlocks)).not.toMatch(/\.voteButton:hover/);
	});

	// The vote box is as wide as the post text on the desktop layout: 0.99, like the link card.
	it('presses a vote button to 0.99, off under html.reduced-motion only', () => {
		expect(rule(css, '\\.voteButton:active')).toContain('transform: scale(0.99);');
		expect(css).toContain(':global(html.reduced-motion) .voteButton:active');
		expect(css).not.toContain(REDUCED);
	});
});

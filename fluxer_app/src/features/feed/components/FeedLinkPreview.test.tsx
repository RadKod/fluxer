// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import type {FeedLinkPreviewResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {MessageEmbedResponse} from '@fluxer/schema/src/domains/message/EmbedSchemas';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/channel/components/embeds/media/EmbedYouTube', () => ({
	EmbedYouTube: vi.fn(() => createElement('div', {'data-testid': 'youtube'})),
}));
vi.mock('@app/features/channel/components/InviteEmbed', () => ({
	InviteEmbed: vi.fn(() => createElement('div', {'data-testid': 'invite'})),
}));
vi.mock('@app/features/messaging/utils/ExternalLinkUtils', () => ({openExternalUrlWithWarning: vi.fn()}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {enabled: false}}));

const {EmbedYouTube} = await import('@app/features/channel/components/embeds/media/EmbedYouTube');
const {InviteEmbed} = await import('@app/features/channel/components/InviteEmbed');
const {openExternalUrlWithWarning} = await import('@app/features/messaging/utils/ExternalLinkUtils');
const {FeedLinkPreview} = await import('@app/features/feed/components/FeedLinkPreview');
const {default: MobileLayout} = await import('@app/features/ui/state/MobileLayout');

const RAW_IMAGE = 'https://static-cdn.example/raw-thumbnail.jpg';
const PROXIED_IMAGE = 'https://media.micup.test/external/abc/raw-thumbnail.jpg';

function media(url: string, proxyUrl: string | null) {
	return {url, proxy_url: proxyUrl, flags: 0};
}

function preview(overrides: Partial<FeedLinkPreviewResponse>, embed: Partial<MessageEmbedResponse> | null = {}) {
	return {
		kind: 'twitch',
		url: 'https://www.twitch.tv/somechannel',
		invite_code: null,
		embed: embed && {type: 'link', url: 'https://unfurled.example/elsewhere', ...embed},
		...overrides,
	} as FeedLinkPreviewResponse;
}

describe('FeedLinkPreview', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		(MobileLayout as {enabled: boolean}).enabled = false;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = (value: FeedLinkPreviewResponse) =>
		act(() => root.render(createElement(FeedLinkPreview, {preview: value})));
	const card = () => container.querySelector<HTMLButtonElement>('button');
	const byFlx = (flx: string) => container.querySelector<HTMLElement>(`[data-flx="${flx}"]`);

	it('renders EmbedYouTube for a playable YouTube card', () => {
		render(
			preview(
				{kind: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ'},
				{
					video: media('https://www.youtube.com/embed/dQw4w9WgXcQ', null),
					thumbnail: media(RAW_IMAGE, PROXIED_IMAGE),
					title: 'A video',
				},
			),
		);
		expect(container.querySelector('[data-testid="youtube"]')).not.toBeNull();
		const embed = (vi.mocked(EmbedYouTube).mock.lastCall![0] as {embed: MessageEmbedResponse}).embed;
		expect(embed.video?.url).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
		expect(embed.thumbnail?.proxy_url).toBe(PROXIED_IMAGE);
		// Its own "open in new tab" follows embed.url, so the post's own link goes there.
		expect(embed.url).toBe('https://youtu.be/dQw4w9WgXcQ');
		expect(card()).toBeNull();
	});

	it('shows a YouTube link without a playable video as a card, never a player', () => {
		render(preview({kind: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ'}, {title: 'A video'}));
		expect(EmbedYouTube).not.toHaveBeenCalled();
		expect(card()?.textContent).toContain('YouTube');
		expect(card()?.textContent).toContain('A video');
	});

	it("renders InviteEmbed with the server's invite code", () => {
		render(preview({kind: 'invite', url: 'https://micup.test/invite/Abc-123', invite_code: 'Abc-123'}, null));
		expect(container.querySelector('[data-testid="invite"]')).not.toBeNull();
		expect(vi.mocked(InviteEmbed).mock.lastCall![0]).toMatchObject({code: 'Abc-123'});
		expect(card()).toBeNull();
	});

	it('renders a Twitch or Kick card with the proxied thumbnail, never the raw image URL', () => {
		render(preview({kind: 'twitch'}, {title: 'Live now', thumbnail: media(RAW_IMAGE, PROXIED_IMAGE)}));
		expect(card()?.querySelector('img')?.getAttribute('src')).toBe(PROXIED_IMAGE);
		expect(card()?.textContent).toContain('Twitch');
		expect(card()?.textContent).toContain('Live now');
		expect(container.innerHTML).not.toContain(RAW_IMAGE);
		expect(container.querySelector('iframe')).toBeNull();

		render(preview({kind: 'kick', url: 'https://kick.com/somechannel'}, {image: media(RAW_IMAGE, PROXIED_IMAGE)}));
		expect(card()?.querySelector('img')?.getAttribute('src')).toBe(PROXIED_IMAGE);
		expect(card()?.textContent).toContain('Kick');
		expect(container.innerHTML).not.toContain(RAW_IMAGE);

		// Without a proxied image (Discover drops Twitch and Kick images while media is off) it is a text card.
		render(preview({kind: 'kick', url: 'https://kick.com/somechannel'}, {thumbnail: media(RAW_IMAGE, null)}));
		expect(card()?.querySelector('img')).toBeNull();
		expect(container.innerHTML).not.toContain(RAW_IMAGE);
		expect(card()?.textContent).toContain('kick.com/somechannel');
	});

	it("does not trust the server's provider name", () => {
		render(preview({kind: 'twitch'}, {provider: {name: 'Totally YouTube'}, title: 'Live now'}));
		expect(card()?.textContent).not.toContain('Totally YouTube');
		expect(card()?.textContent).toContain('Twitch');
	});

	it('shows the description under the title when the preview has one', () => {
		render(preview({kind: 'twitch'}, {title: 'Live now', description: 'Ranked games all night'}));
		const description = byFlx('feed.feed-link-preview.description');
		expect(description?.textContent).toBe('Ranked games all night');
		expect(byFlx('feed.feed-link-preview.title')?.nextElementSibling).toBe(description);
		expect(card()?.contains(description!)).toBe(true);
	});

	it('has no description line without one', () => {
		render(preview({kind: 'twitch'}, {title: 'Live now'}));
		expect(byFlx('feed.feed-link-preview.description')).toBeNull();
		render(preview({kind: 'kick', url: 'https://kick.com/somechannel'}, {title: 'Live now', description: ''}));
		expect(byFlx('feed.feed-link-preview.description')).toBeNull();
	});

	// The phone layout keeps its card as it was: the description line is the desktop layout's.
	it('has no description line on the phone layout', () => {
		(MobileLayout as {enabled: boolean}).enabled = true;
		render(preview({kind: 'twitch'}, {title: 'Live now', description: 'Ranked games all night'}));
		expect(byFlx('feed.feed-link-preview.title')?.textContent).toBe('Live now');
		expect(byFlx('feed.feed-link-preview.description')).toBeNull();
	});

	it('keeps YouTube and invite previews as Fluxer embeds', () => {
		render(
			preview(
				{kind: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ'},
				{
					video: media('https://www.youtube.com/embed/dQw4w9WgXcQ', null),
					thumbnail: media(RAW_IMAGE, PROXIED_IMAGE),
					title: 'A video',
					description: 'About the video',
				},
			),
		);
		expect(EmbedYouTube).toHaveBeenCalled();
		expect(card()).toBeNull();
		expect(byFlx('feed.feed-link-preview.description')).toBeNull();

		render(preview({kind: 'invite', url: 'https://micup.test/invite/Abc-123', invite_code: 'Abc-123'}, null));
		expect(InviteEmbed).toHaveBeenCalled();
		expect(card()).toBeNull();
	});

	it("clicking a preview card opens the post's own URL through the warning", () => {
		render(preview({kind: 'twitch', url: 'https://www.twitch.tv/somechannel'}, {title: 'Live now'}));
		act(() => card()!.click());
		expect(openExternalUrlWithWarning).toHaveBeenCalledTimes(1);
		expect(openExternalUrlWithWarning).toHaveBeenCalledWith('https://www.twitch.tv/somechannel');
		expect(openExternalUrlWithWarning).not.toHaveBeenCalledWith('https://unfurled.example/elsewhere');
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

describe('feed link card design', () => {
	const css = read('./FeedLinkPreview.module.css');
	const fineBlocks = blocks(css, FINE);

	it('draws the card flush on the card colour', () => {
		const card = rule(css, '\\.card');
		expect(card).toContain('padding: 0;');
		expect(card).toContain('align-items: stretch;');
		expect(card).toContain('overflow: hidden;');
		expect(card).toContain('background: var(--background-secondary-alt);');
		expect(card).toContain('border: 0.0625rem solid var(--background-modifier-accent);');
	});

	// The mobile layout (phones, tablets and the 640-768px hysteresis) keeps the 28rem cap; the desktop column lifts it.
	it('caps the card at 28rem on the mobile layout and lifts the cap on the desktop layout only', () => {
		expect(rule(css, '\\.card')).toContain('max-width: 28rem;');
		expect(rule(css, `${D}\\.card`)).toContain('max-width: none;');
	});

	// Size containment keeps the picture's own ratio out of the card height: a square thumbnail would make it 120px
	// (7.5rem wide) where the text needs 84px.
	it('sets the image flush against the edge, as tall as the text and at least 84px', () => {
		const image = rule(css, '\\.image');
		expect(image).toContain('width: 7.5rem;');
		expect(image).toContain('min-height: 5.25rem;');
		expect(image).toContain('border-radius: 0;');
		expect(image).toContain('align-self: stretch;');
		expect(image).toContain('contain: size;');
		expect(image).not.toContain('aspect-ratio: 16 / 9');
		expect(rule(css, '\\.text')).toContain('padding: 0.625rem 0.75rem;');
	});

	it('labels the provider in small capitals on the desktop layout only; the phone keeps its 12px label', () => {
		const provider = rule(css, '\\.provider');
		expect(provider).toContain('font-size: 0.75rem;');
		expect(provider).toContain('color: var(--text-primary-muted);');
		expect(provider).not.toMatch(/text-transform|letter-spacing/);
		const desktop = rule(css, `${D}\\.provider`);
		expect(desktop).toContain('font-size: 0.6875rem;');
		expect(desktop).toContain('text-transform: uppercase;');
		expect(desktop).toContain('letter-spacing: 0.06em;');
	});

	it('bolds the title and clamps the description to two muted lines', () => {
		expect(rule(css, '\\.title')).toContain('font-weight: 700;');
		const description = rule(css, '\\.description');
		expect(description).toContain('color: var(--text-primary-muted);');
		expect(description).toContain('font-size: 0.8125rem;');
		expect(description).toContain('-webkit-line-clamp: 2;');
		expect(description).toContain('overflow-wrap: anywhere;');
		expect(css).not.toMatch(/[^-]height:/);
	});

	it('hovers with control-button-hover-bg and lifts the muted text to text-secondary, for a fine pointer only', () => {
		const fine = fineBlocks.join('\n');
		expect(rule(fine, '\\.card:hover')).toContain('background: var(--control-button-hover-bg);');
		expect(rule(fine, '\\.card:hover \\.provider,\\s+\\.card:hover \\.description')).toContain(
			'color: var(--text-secondary);',
		);
		expect(without(css, fineBlocks)).not.toMatch(/\.card:hover/);
	});

	// The card is as wide as the post text: 0.97 would pull its edges in by about 17px, 0.99 by about 6.
	it('presses the full-width card to 0.99, off under html.reduced-motion only, and keeps 44px on touch', () => {
		expect(rule(css, '\\.card:active')).toContain('transform: scale(0.99);');
		expect(css).toContain(':global(html.reduced-motion) .card:active');
		expect(css).not.toContain(REDUCED);
		expect(rule(block(css, TOUCH), '\\.card')).toContain('min-height: 2.75rem;');
	});
});

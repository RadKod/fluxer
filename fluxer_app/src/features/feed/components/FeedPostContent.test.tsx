// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {i18n} from '@lingui/core';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The message markdown parser and libfluxcore are Rust compiled to WASM; their modules exist only after
// `wasm:codegen`, which `typecheck` runs before `test` on Linux (KL7). Without them (a Windows checkout) the parser
// keeps the whole content as one text node and libfluxcore is inert, so the render path below still runs for real.
const MARKDOWN_WASM = 'src/features/messaging/utils/markdown/parser/MarkdownParserWasmBytes.ts';
const LIBFLUXCORE_WASM = 'pkgs/libfluxcore/libfluxcore.js';
const HAS_MARKDOWN_WASM = existsSync(MARKDOWN_WASM);

vi.mock('@app/features/messaging/utils/markdown/parser/MarkdownParserWasm', async (importOriginal) => {
	if ((await import('node:fs')).existsSync(MARKDOWN_WASM)) return importOriginal();
	return {
		preloadMarkdownParserWasm: async () => {},
		parseMarkdownAstWithWasm: (input: string) => ({nodes: [{type: 'Text', content: input}]}),
	};
});
vi.mock('@app/features/platform/utils/LibFluxcore', async (importOriginal) => {
	if ((await import('node:fs')).existsSync(LIBFLUXCORE_WASM)) return importOriginal();
	return {isLibfluxcoreReady: () => false, ensureLibfluxcoreReady: async () => {}};
});
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	Trans: ({children}: {children: unknown}) => children,
	useLingui: () => ({i18n: {locale: 'en-US', _: (descriptor: {message: string}) => descriptor.message}}),
}));
const motion = vi.hoisted(() => ({animate: true}));
vi.mock('@app/features/app/hooks/useShouldAnimate', () => ({useShouldAnimate: () => motion.animate}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {
		getSnapshotOrNull: () => null,
		localInstanceDomain: 'micup.test',
		webAppEndpoint: 'https://micup.test',
		mediaEndpoint: 'https://media.micup.test',
		staticCdnEndpoint: 'https://static.micup.test',
		isSelfHosted: () => true,
		features: {},
	},
}));
// The locale loader imports compiled catalogs that only exist after i18n:compile.
vi.mock('@app/app/I18n', async () => ({
	default: (await import('@lingui/core')).i18n,
	normalizeLocale: () => 'en-US',
	loadLocaleCatalog: async () => 'en-US',
	applyLocaleChange: () => 'en-US',
	initI18n: async () => {},
}));
// The markdown renderers pull in stores that read the page bootstrap at import time.
(window as unknown as {__FLUXER_BOOTSTRAP__: unknown}).__FLUXER_BOOTSTRAP__ = {
	instance: {app_public: {branding: {product_name: 'sanalyer'}}},
	config: {releaseChannel: 'stable', bootstrapApiEndpoint: 'https://micup.test/api'},
	geoip: {
		countryCode: 'TR',
		regionCode: null,
		latitude: null,
		longitude: null,
		ageRestrictedGeos: [],
		ageBlockedGeos: [],
	},
};

// Idle and LocalPresence import each other. Loaded through LocalPresence first, Idle starts its idle timer while
// LocalPresence is still importing, and a slow import lets the timer call the missing store; Idle first avoids that.
await import('@app/features/ui/state/Idle');
const {AppI18nProvider} = await import('@app/features/i18n/components/AppI18nProvider');
const {FeedPostContent} = await import('@app/features/feed/components/FeedPostContent');

describe('FeedPostContent', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		i18n.loadAndActivate({locale: 'en-US', messages: {}});
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = (content: string, inlineGifs = false) =>
		act(() =>
			root.render(
				createElement(AppI18nProvider, {i18n}, createElement(FeedPostContent, {content, postId: '100', inlineGifs})),
			),
		);
	const GIF_URL = 'https://media.micup.test/external/AbC-_1/https/static.klipy.com/ii/c8/28/HkAKKCzZ.webp';

	it('shows HTML in a post as plain text instead of running it', () => {
		const payload = '<img src=x onerror="window.feedXssProbe=1"><script>window.feedXssProbe=2</script>';
		render(payload);

		expect(container.querySelector('img')).toBeNull();
		expect(container.querySelector('script')).toBeNull();
		expect(container.textContent).toContain('<img src=x onerror="window.feedXssProbe=1">');
		expect((window as {feedXssProbe?: number}).feedXssProbe).toBeUndefined();
	});

	it('draws a Klipy GIF from our media proxy and takes its link out of the text', () => {
		render(`haha\n${GIF_URL}`, true);

		const images = container.querySelectorAll('img');
		expect(images).toHaveLength(1);
		expect(images[0]!.getAttribute('src')).toBe(GIF_URL);
		expect(container.textContent).toContain('haha');
		expect(container.textContent).not.toContain('static.klipy.com');
	});

	// a post's GIF is an attachment (Keşfet's media gate sees it); a GIF link in a post body stays a link.
	it('keeps a GIF link in a post body as a link', () => {
		render(`haha\n${GIF_URL}`);
		expect(container.querySelector('img')).toBeNull();
		expect(container.textContent).toContain(GIF_URL);
	});

	it('keeps the GIF a link while GIFs do not play (autoplay off, reduced motion, data saver)', () => {
		motion.animate = false;
		render(`haha\n${GIF_URL}`, true);
		motion.animate = true;
		expect(container.querySelector('img')).toBeNull();
		expect(container.textContent).toContain(GIF_URL);
	});

	it('never draws any other image link inline', () => {
		for (const url of [
			'https://evil.test/pixel.gif',
			'https://static.klipy.com/ii/c8/28/HkAKKCzZ.webp',
			'https://media.micup.test/external/AbC/https/evil.test/pixel.gif',
		]) {
			render(`look ${url}`, true);
			expect(container.querySelector('img')).toBeNull();
			expect(container.textContent).toContain(url);
		}
	});

	it.skipIf(!HAS_MARKDOWN_WASM)('renders message markdown', () => {
		render('**kalın** ve *eğik*');

		expect(container.querySelector('strong')?.textContent).toBe('kalın');
		expect(container.querySelector('em')?.textContent).toBe('eğik');
	});

	it('no feed component writes raw HTML', () => {
		const directory = 'src/features/feed';
		const sources = readdirSync(directory, {recursive: true, encoding: 'utf8'})
			.filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
			.map((file) => readFileSync(join(directory, file), 'utf8'));
		expect(sources.length).toBeGreaterThan(0);
		for (const source of sources) {
			expect(source).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML/);
		}
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import postcss from 'postcss';
import {describe, expect, it} from 'vitest';
import {micupShrinkFontSize} from '../../scripts/build/postcss/micup-shrink-font-size.mjs';

async function run(css: string): Promise<string> {
	return (await postcss([micupShrinkFontSize()]).process(css, {from: undefined})).css;
}

describe('micup-shrink-font-size', () => {
	it('takes 1px off every UI text size, lengths and variables alike', async () => {
		expect(await run('.a{font-size:0.875rem}')).toBe('.a{font-size:calc(0.875rem - 0.0625rem)}');
		expect(await run('.b{font-size:12px !important}')).toBe('.b{font-size:calc(12px - 0.0625rem) !important}');
		expect(await run('.c{font-size:var(--message-timestamp-font-size)}')).toBe(
			'.c{font-size:calc(var(--message-timestamp-font-size) - 0.0625rem)}',
		);
		expect(await run('.x{font-size:var(--font-size-xs)}')).toBe('.x{font-size:calc(var(--font-size-xs) - 0.0625rem)}');
		expect(await run('@media (min-width: 1px){.d{font-size:1.25rem}}')).toBe(
			'@media (min-width: 1px){.d{font-size:calc(1.25rem - 0.0625rem)}}',
		);
	});

	it('leaves the rem base, the chat size, emoji and relative sizes alone', async () => {
		const unchanged = [
			'html{font-size:16px}',
			'html.platform-web{font-size:calc(16px * var(--custom-zoom, 100) / 100)}',
			':root{font-size:100%}',
			'.chat{font-size:var(--font-size, 1rem)}',
			'.input{font-size:var(--textarea-font-size)}',
			'.emoji{font-size:var(--emoji-size-emoji)}',
			'.e{font-size:0.875em}',
			'.f{font-size:80%}',
			'.g{font-size:inherit}',
			'.h{font-size:0}',
		];
		for (const css of unchanged) expect(await run(css)).toBe(css);
	});

	it('gives text that sets no size of its own a body size for the build to shrink', async () => {
		const globals = readFileSync(fileURLToPath(new URL('./globals.css', import.meta.url)), 'utf8');
		expect(globals).toMatch(/\nbody \{\n\tfont-size: 1rem;\n\}\n/);
		expect(await run('body{font-size:1rem}')).toBe('body{font-size:calc(1rem - 0.0625rem)}');
	});

	it('runs in the app build', () => {
		const config = readFileSync(fileURLToPath(new URL('../../postcss.config.js', import.meta.url)), 'utf8');
		expect(config).toContain("import {micupShrinkFontSize} from './scripts/build/postcss/micup-shrink-font-size.mjs';");
		expect(config).toContain('micupShrinkFontSize(),');
	});
});

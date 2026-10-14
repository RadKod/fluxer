// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// Micup: ANSI blink is user content inside message rows. An infinite blink per message keeps the channel producing
// frames for as long as the message is on screen, so the text stays static and fully visible. The override lives in
// one block at the end of the stylesheet, after MARKER, so upstream merges never touch these lines.
const CSS = readFileSync(fileURLToPath(new URL('./Markup.module.css', import.meta.url)), 'utf8');
const MARKER = '/* Micup: static ANSI blink */';

describe('message markup', () => {
	it('keeps ANSI blink text static and visible', () => {
		const parts = CSS.split(MARKER);
		expect(parts).toHaveLength(2);
		const block = (parts[1] ?? '')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/\s+/g, ' ')
			.trim();
		expect(block).toBe('.markup .ansiCode :global(.ansi-blink) { animation: none; }');
	});

	it('runs no other infinite animation in message markup', () => {
		const before = CSS.split(MARKER)[0] ?? '';
		const infinite = before.split('\n').filter((line) => /\binfinite\b/.test(line));
		expect(infinite).toEqual(['\tanimation: ansi-code-blink 1s step-end infinite;']);
	});
});

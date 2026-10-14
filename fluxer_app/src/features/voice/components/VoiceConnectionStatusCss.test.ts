// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// Micup: the voice panel's channel line (channel / server, or the DM name) is 10% larger than upstream's, line height
// scaled with it. Upstream's rule stays as is; the Micup block at the end of the file overrides it (MARKER). The build
// takes 1px off every font size (micup-shrink-font-size), so the line renders at 0.7625rem instead of 0.6875rem.
const CSS = readFileSync(fileURLToPath(new URL('./VoiceConnectionStatus.module.css', import.meta.url)), 'utf8');
const MARKER = '/* Micup: voice panel channel line 10% larger */';

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

function rule(css: string, selector: string): string {
	const match = css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')} \\{([^}]*)\\}`));
	expect(match, selector).not.toBeNull();
	return flat(match?.[1] ?? '');
}

it('shares the media row equally between the visible controls', () => {
	const section = rule(CSS, '.mediaSection');
	expect(section).toContain('grid-auto-flow: column;');
	expect(section).toContain('grid-auto-columns: 1fr;');
	expect(section).not.toContain('grid-template-columns:');
});

describe('voice panel channel line', () => {
	it('is 10% larger in a Micup block at the end of the file', () => {
		expect(CSS.split(MARKER)).toHaveLength(2);
		expect(flat(CSS.slice(CSS.indexOf(MARKER) + MARKER.length))).toBe(
			'.channelSourceLink { font-size: 0.825rem; line-height: 1.1rem; }',
		);
	});

	it('leaves the upstream rule and its ellipsis untouched', () => {
		const upstream = CSS.slice(0, CSS.indexOf(MARKER));
		const link = rule(upstream, '.channelSourceLink');
		expect(link).toContain('font-size: 0.75rem;');
		expect(link).toContain('line-height: 1rem;');
		expect(link).toContain('min-width: 0; max-width: 100%;');
		for (const selector of ['.channelSourceText', '.channelSourceChannel', '.channelSourceGuild']) {
			expect(rule(upstream, selector)).toMatch(/overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/);
		}
	});
});

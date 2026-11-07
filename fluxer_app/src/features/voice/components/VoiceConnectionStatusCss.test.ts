// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {expect, it} from 'vitest';

const CSS = readFileSync(fileURLToPath(new URL('./VoiceConnectionStatus.module.css', import.meta.url)), 'utf8');

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

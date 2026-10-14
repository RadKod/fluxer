// SPDX-License-Identifier: AGPL-3.0-or-later

import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// Micup: the coal theme is a near-black since its palette moved to 6-17%, so its tooltip no longer says pitch-black.
const SRC_ROOT = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const MESSAGE = 'Use coal theme (near-black surfaces)';
const LOCALES = `${SRC_ROOT}features/i18n/locales/`;

function translation(locale: string): string | undefined {
	const catalog = readFileSync(`${LOCALES}${locale}/messages.po`, 'utf8');
	return new RegExp(`msgid "${MESSAGE.replace(/[()]/g, '\\$&')}"\\nmsgstr "([^"]*)"`).exec(catalog)?.[1];
}

describe('coal theme tooltip', () => {
	it('describes near-black surfaces in the source and every catalog', () => {
		const source = readFileSync(
			`${SRC_ROOT}features/user/components/modals/tabs/appearance_tab/theme/ThemeTabContent.tsx`,
			'utf8',
		);
		expect(source).toContain(`message: '${MESSAGE}',`);
		expect(source).not.toContain('pitch-black');
		const locales = readdirSync(LOCALES, {withFileTypes: true}).filter((entry) => entry.isDirectory());
		for (const locale of locales) expect(translation(locale.name), locale.name).toBeTruthy();
		expect(translation('en-US')).toBe(MESSAGE);
		expect(translation('tr')).toBe('Kömür temasını kullan (siyaha yakın yüzeyler)');
	});
});

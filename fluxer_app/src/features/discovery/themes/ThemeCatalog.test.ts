// SPDX-License-Identifier: AGPL-3.0-or-later

import {isThemeCatalogId, THEME_CATALOG} from '@app/features/discovery/themes/ThemeCatalog';
import {describe, expect, it} from 'vitest';

describe('theme catalog', () => {
	it('ships five named palettes with distinct catalog ids', () => {
		expect(THEME_CATALOG).toHaveLength(5);
		const ids = new Set(THEME_CATALOG.map((entry) => entry.id));
		expect(ids.size).toBe(5);
		for (const entry of THEME_CATALOG) {
			expect(isThemeCatalogId(entry.id)).toBe(true);
			expect(entry.name).not.toBe(entry.slug);
			expect(entry.description.length).toBeGreaterThan(0);
			expect(entry.tags.length).toBeGreaterThan(0);
		}
	});

	it('reads the preview swatches from the palette itself', () => {
		for (const entry of THEME_CATALOG) {
			for (const colour of Object.values(entry.swatches)) {
				expect(colour).toMatch(/^#[0-9a-f]{6}$/);
			}
			expect(entry.css).toContain(':root[class]');
		}
	});
});

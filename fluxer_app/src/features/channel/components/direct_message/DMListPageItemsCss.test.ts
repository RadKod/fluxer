// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// The accent sits on rows the sidebar keeps on screen: it is drawn once and never moves. Only the wash's opacity
// changes on hover, with a short transition; the ring and the wash are layers behind the content, so the row keeps the
// DM list row's box.
describe('DMListPageItems accent stylesheet', () => {
	const css = readFileSync(fileURLToPath(new URL('./DMListPageItems.module.css', import.meta.url)), 'utf8');
	const rule = (selector: string) =>
		css.match(new RegExp(`\\n${selector.replace(/[.:[\]()]/g, '\\$&')} \\{([^}]*)\\}`))?.[1];

	it('takes its colours from the premium palette', () => {
		expect(rule('.accent')).toContain(
			"composes: tokens from '@app/features/premium/components/PremiumSurface.module.css';",
		);
		expect(rule('.accent::before')).toMatch(/linear-gradient\([^;]*var\(--premium-violet\)/);
		expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
	});

	// One accent hue: the violet family of the premium palette, no second colour beside it.
	it('keeps to the violet family', () => {
		expect(css).not.toMatch(/--premium-(rose|blush|gold|mint|sky|ice)/);
	});

	// The current page reads like every other current row: the row's own selected chip and text; only the ring and
	// the wash stay.
	it('dresses the chip and the label only while the row is not the current page', () => {
		expect(rule(".accent:not([aria-current='page']) .accentIcon")).toContain('background-image: linear-gradient(');
		expect(rule(".accent:not([aria-current='page']) .accentIcon > svg")).toContain('color: white;');
		expect(rule(".accent:not([aria-current='page']) .accentLabel")).toContain('color: var(--text-primary);');
		expect(css).not.toMatch(/\n\.accent(Icon|Label)\b/);
	});

	it('draws the ring by a mask on a layer behind the content, not by a border that would resize the row', () => {
		expect(rule('.accent')).toMatch(/position: relative;[^}]*isolation: isolate;/);
		for (const layer of ['.accent::before', '.accent::after']) {
			expect(rule(layer)).toMatch(/position: absolute;[^}]*inset: 0;[^}]*z-index: -1;/);
			expect(rule(layer)).toContain('pointer-events: none;');
		}
		expect(rule('.accent::before')).toContain('mask-composite: exclude;');
		expect(css).not.toMatch(/(^|[^-])border(-width)?:/m);
		expect(rule('.accent')).not.toMatch(/\b(height|padding|margin|width)\s*:/);
	});

	it('has no animation and only a short hover transition', () => {
		expect(css).not.toMatch(/@keyframes|animation/);
		expect(rule('.accent::after')).toContain('transition: opacity var(--transition-fast);');
	});
});

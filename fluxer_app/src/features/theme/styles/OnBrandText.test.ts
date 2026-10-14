// SPDX-License-Identifier: AGPL-3.0-or-later

import {readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// Micup: the coal and dark accent is white (MicupV1Palette.test.ts), so text and icons drawn on it take
// --text-on-brand-primary instead of a fixed white; light keeps its upstream look because the token stays white there.
// Media overlays (a dark scrim over images and video) keep a fixed white, since the token turns near-black.
const SRC = fileURLToPath(new URL('../../../', import.meta.url));
const BRAND_FILL =
	/^var\(--(brand-primary|brand-secondary|brand-primary-light|accent-primary|plutonium|plutonium-hover)\)$/;
const FIXED_LIGHT = /^(white|#fff|#ffffff|hsl\(0,\s*0%,\s*(98|100)%\)|var\(--text-(primary|secondary|chat)\))$/i;
const DARK_SCRIM = /^rgba\(0,\s*0,\s*0,\s*0?\.[5-9]\d*\)$/;

interface ColoredRule {
	where: string;
	background: string;
	color: string;
}

function stylesheets(dir: string): Array<string> {
	return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === 'generated' ? [] : stylesheets(path);
		return entry.name.endsWith('.css') ? [path] : [];
	});
}

// Innermost `selector { declarations }` blocks, so rules nested in @media are read too.
function coloredRules(): Array<ColoredRule> {
	const found: Array<ColoredRule> = [];
	for (const file of stylesheets(SRC)) {
		const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
		for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
			const values = new Map(
				[...(match[2] ?? '').matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1] ?? '', (d[2] ?? '').trim()]),
			);
			const color = values.get('color') ?? values.get('fill') ?? '';
			if (!color) continue;
			const line = css.slice(0, match.index).split('\n').length;
			const selector = (match[1] ?? '').trim().replace(/\s+/g, ' ');
			const where = `${relative(SRC, file).replaceAll('\\', '/')}:${line} ${selector}`;
			found.push({where, background: values.get('background-color') ?? values.get('background') ?? '', color});
		}
	}
	return found;
}

describe('text on the accent', () => {
	const rules = coloredRules();

	it('reads the stylesheets', () => {
		expect(rules.length).toBeGreaterThan(1000);
	});

	it('never paints a fixed light color on a solid accent background', () => {
		const offenders = rules.filter((r) => BRAND_FILL.test(r.background) && FIXED_LIGHT.test(r.color));
		expect(offenders.map((r) => r.where)).toEqual([]);
	});

	it('does not put the accent text token on a dark media scrim', () => {
		const offenders = rules.filter((r) => DARK_SCRIM.test(r.background) && r.color.includes('--text-on-brand-primary'));
		expect(offenders.map((r) => r.where)).toEqual([]);
	});

	it.each([
		['features/app/components/layout/AuthLayout.module.css', '.container'],
		['features/invite/components/modals/InviteAcceptModal.module.css', '.background'],
		['features/invite/components/modals/InvitePagePreviewModal.module.css', '.previewContent'],
	])('keeps the accent-colored splash in %s dark in the coal and dark themes', (file, className) => {
		const css = readFileSync(`${SRC}${file}`, 'utf8').replace(/\s+/g, ' ');
		expect(css).toContain(`:global(html:is(.theme-coal, .theme-dark)) ${className}`);
		expect(css).toMatch(/background(-color)?: var\(--background-secondary-lighter\); \}/);
	});
});

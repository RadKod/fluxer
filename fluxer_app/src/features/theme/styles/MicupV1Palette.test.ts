// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeAll, describe, expect, it, vi} from 'vitest';

// Micup: the coal and dark themes share the v1 palette (near-black surfaces, a white accent with near-black text on it);
// light and dark_legacy keep upstream. The generator is run in memory and its CSS is read back, so this checks the
// shipped tokens rather than the generator's source text.
const written = vi.hoisted(() => ({css: ''}));
vi.mock('node:fs', async (importOriginal) => {
	const fs = await importOriginal<typeof import('node:fs')>();
	return {
		...fs,
		mkdirSync: vi.fn(),
		writeFileSync: vi.fn((_path: unknown, data: unknown) => {
			written.css = String(data);
		}),
	};
});

type Tokens = Map<string, string>;

function block(css: string, selector: string): Tokens {
	const start = css.indexOf(`\n${selector} {\n`);
	expect(start, selector).toBeGreaterThan(-1);
	const body = css.slice(start + selector.length + 4, css.indexOf('\n}', start));
	return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()]));
}

// Replaces var(--x) with the token's value; variables set outside the color system (--saturation-factor) stay as-is.
function resolve(tokens: Tokens, name: string, depth = 0): string {
	const value = tokens.get(name);
	expect(value, name).toBeDefined();
	if (depth > 20) throw new Error(`var() cycle at ${name}`);
	return (value ?? '').replace(/var\((--[\w-]+)\)/g, (match, ref: string) =>
		tokens.has(ref) ? resolve(tokens, ref, depth + 1) : match,
	);
}

// A saturation-aware tone at the default --saturation-factor (1) as hex, so it compares with the v1 hex values.
function toHex(value: string): string {
	const m = /^hsl\((\d+(?:\.\d+)?), calc\((\d+(?:\.\d+)?)% \* var\(--saturation-factor\)\), (\d+(?:\.\d+)?)%\)$/.exec(
		value,
	);
	if (!m) return value;
	const [h, s, l] = [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
	const f = (n: number) => {
		const k = (n + h / 30) % 12;
		const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
		return Math.round(c * 255)
			.toString(16)
			.padStart(2, '0');
	};
	return `#${f(0)}${f(8)}${f(4)}`;
}

function theme(css: string, selector: string | null): Tokens {
	const root = block(css, ':root');
	return selector ? new Map([...root, ...block(css, selector)]) : root;
}

function hexHsl(hex: string): [number, number] {
	const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	if (d === 0) return [0, 0];
	const l = (max + min) / 2;
	const s = d / (1 - Math.abs(2 * l - 1));
	const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return [(h * 60 + 360) % 360, s * 100];
}

// Violet/indigo hues with visible saturation: upstream's brand (242), everyone mention (250), accent purple (278).
function purples(value: string): Array<string> {
	const hits: Array<string> = [];
	for (const m of value.matchAll(/hsla?\((\d+(?:\.\d+)?),\s*(?:calc\()?(\d+(?:\.\d+)?)%/g)) {
		if (Number(m[1]) >= 230 && Number(m[1]) <= 300 && Number(m[2]) > 20) hits.push(m[0]);
	}
	for (const m of value.matchAll(/#[0-9a-f]{6}\b/gi)) {
		const [h, s] = hexHsl(m[0]);
		if (h >= 230 && h <= 300 && s > 20) hits.push(m[0]);
	}
	return hits;
}

describe('sanalyer v1 palette in the coal and dark themes', () => {
	let css = '';
	beforeAll(async () => {
		await import('@app_scripts/GenerateColorSystem');
		css = written.css;
		expect(css).toContain(':root {');
	});

	it('renders one block for coal and dark, so the two themes are identical', () => {
		expect(css).toContain('\n.theme-coal, .theme-dark {\n');
		expect(css).not.toMatch(/\n\.theme-coal \{/);
	});

	it('paints the v1 surfaces, text and status colors', () => {
		const coal = theme(css, '.theme-coal, .theme-dark');
		const expected: Record<string, string> = {
			'--background-secondary': '#060608',
			'--background-secondary-lighter': '#0c0c0f',
			'--background-channel-header': '#0c0c0f',
			'--side-panel-background': '#0e0e12',
			'--guild-list-foreground': '#191a1e',
			'--background-primary': '#141519',
			'--background-secondary-alt': '#141519',
			'--background-textarea': '#16161a',
			'--background-tertiary': '#16171b',
			'--background-header-secondary': '#292930',
			'--background-header-primary': '#292930',
			'--background-header-primary-hover': '#3f3f49',
			'--control-button-hover-bg': '#191a1e',
			'--control-button-active-bg': '#1e1e25',
			'--border-color': '#232329',
			'--text-primary': '#f2f2f4',
			'--text-chat': '#dedee4',
			'--text-secondary': '#c4c4cc',
			'--text-primary-muted': '#9a9aa4',
			'--status-online': '#3ecf8e',
			'--status-idle': '#e8a33d',
			'--status-dnd': '#ff6b6b',
			'--status-offline': '#74747f',
			'--status-danger': '#ff6b6b',
			'--focus-primary': '#3ecf8e',
		};
		for (const [name, value] of Object.entries(expected)) expect(toHex(resolve(coal, name)), name).toBe(value);
	});

	it('keeps the saturated v1 colors under the accessibility saturation setting', () => {
		const coal = theme(css, '.theme-coal, .theme-dark');
		for (const name of ['--status-online', '--status-idle', '--status-dnd', '--status-danger', '--focus-primary']) {
			expect(resolve(coal, name), name).toContain('calc(');
			expect(resolve(coal, name), name).toContain('% * var(--saturation-factor))');
		}
	});

	it('turns the accent white with near-black text on it', () => {
		const coal = theme(css, '.theme-coal, .theme-dark');
		for (const name of ['--brand-primary', '--accent-primary', '--plutonium']) {
			expect(resolve(coal, name), name).toBe('#f4f4f6');
		}
		for (const name of ['--brand-secondary', '--brand-primary-light', '--plutonium-hover']) {
			expect(resolve(coal, name), name).toBe('#ffffff');
		}
		for (const name of ['--text-on-brand-primary', '--brand-primary-fill', '--plutonium-text']) {
			expect(resolve(coal, name), name).toBe('#0a0a0c');
		}
	});

	it('leaves no violet in the coal and dark tokens', () => {
		const coal = theme(css, '.theme-coal, .theme-dark');
		const found = [...coal.keys()].flatMap((name) => purples(resolve(coal, name)).map((hit) => `${name}: ${hit}`));
		expect(found).toEqual([]);
	});

	it('keeps the light theme accent and surfaces upstream', () => {
		const light = theme(css, '.theme-light');
		expect(resolve(light, '--brand-primary')).toBe('hsl(242, calc(70% * var(--saturation-factor)), 55%)');
		expect(resolve(light, '--text-on-brand-primary')).toBe('hsl(0, 0%, 98%)');
		expect(resolve(light, '--brand-primary-fill')).toBe('hsl(0, 0%, 100%)');
		expect(resolve(light, '--background-primary')).toBe('hsl(220, calc(10% * var(--saturation-factor)), 98.5%)');
		expect(resolve(light, '--text-primary')).toBe('hsl(220, calc(10% * var(--saturation-factor)), 15%)');
		expect(light.has('--side-panel-background')).toBe(false);
	});

	// Colors picked in TypeScript (the streamer nagbar, group DM avatars) read these with the upstream color as the
	// fallback, so only coal and dark define them.
	it('gives the streamer mode accent and the group DM tones no violet in coal and dark only', () => {
		const coal = theme(css, '.theme-coal, .theme-dark');
		expect(resolve(coal, '--streamer-mode-accent')).toBe('#f4f4f6');
		expect(resolve(coal, '--streamer-mode-accent-text')).toBe('#0a0a0c');
		expect(resolve(coal, '--group-dm-accent-violet')).toBe('#4d4d58');
		expect(resolve(coal, '--group-dm-accent-fuchsia')).toBe('#3f3f49');
		for (const selector of [null, '.theme-light', '.theme-dark_legacy']) {
			const other = selector ? block(css, selector) : theme(css, null);
			for (const name of [
				'--streamer-mode-accent',
				'--streamer-mode-accent-text',
				'--group-dm-accent-violet',
				'--group-dm-accent-fuchsia',
			]) {
				expect(other.has(name), `${selector ?? ':root'} ${name}`).toBe(false);
			}
		}
	});
});

// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ThemeTypes} from '@fluxer/constants/src/UserConstants';
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));

// Micup: a visitor or account without a stored theme sees Coal; stored themes stay as they are.
async function loadHydratedTheme() {
	vi.resetModules();
	const theme = (await import('@app/features/theme/state/Theme')).default;
	const accountTheme = (await import('@app/features/theme/state/AccountTheme')).default;
	(await import('@app/features/theme/state/ThemeProfile')).default.markReady();
	return {
		get effectiveTheme() {
			return theme.effectiveTheme;
		},
		set systemPrefersDark(value: boolean) {
			theme.systemPrefersDark = value;
		},
		updateServerTheme: (value: string) => accountTheme.updateServerTheme(value),
	};
}

describe('sanalyer default theme', () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	it('shows Coal when nothing is stored', async () => {
		const theme = await loadHydratedTheme();
		expect(theme.effectiveTheme).toBe(ThemeTypes.COAL);
	});

	it('falls back to Coal for an unknown server theme and keeps a stored Dark', async () => {
		const theme = await loadHydratedTheme();
		theme.updateServerTheme('not-a-theme');
		expect(theme.effectiveTheme).toBe(ThemeTypes.COAL);
		theme.updateServerTheme(ThemeTypes.DARK);
		expect(theme.effectiveTheme).toBe(ThemeTypes.DARK);
	});

	it('paints Coal before the app loads when nothing is stored (index.html boot script)', () => {
		const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../index.html'), 'utf8');
		const script = /<script[^>]*>(\(function\(\)\{try\{var t=localStorage\.getItem\('theme'\)[^<]*)<\/script>/.exec(
			html,
		)?.[1];
		expect(script).toBeDefined();
		document.documentElement.className = '';
		new Function(script ?? '')();
		expect(document.documentElement.classList.contains('theme-coal')).toBe(true);
		document.documentElement.className = '';
		window.localStorage.setItem('theme', ThemeTypes.DARK);
		new Function(script ?? '')();
		expect(document.documentElement.classList.contains('theme-dark')).toBe(true);
	});

	it('follows the system as upstream Dark in dark mode and Light in light mode', async () => {
		const theme = await loadHydratedTheme();
		theme.updateServerTheme(ThemeTypes.SYSTEM);
		theme.systemPrefersDark = true;
		expect(theme.effectiveTheme).toBe(ThemeTypes.DARK);
		theme.systemPrefersDark = false;
		expect(theme.effectiveTheme).toBe(ThemeTypes.LIGHT);
	});
});

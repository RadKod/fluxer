// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {getDefaultPickerHex} from '@app/features/app/components/floating/ColorPickerMath';
import {NAGBAR_TONES, NagbarToneKind} from '@app/features/app/components/layout/NagbarTones';
import {getGroupDMAccentColor} from '@app/features/channel/utils/GroupDMColorUtils';
import {ThemeTypes} from '@fluxer/constants/src/UserConstants';
import {describe, expect, it} from 'vitest';

// Micup: the second v1 palette pass for the coal and dark themes. Windows take the v1 box color, menus hover with the
// v1 row color, the danger button is the v1 dark-red one, the selected white rail tile loses its dashed ring, and the
// violet leftovers turn neutral or white. Every rule is scoped to coal and dark; light and dark_legacy stay upstream.
const SRC = fileURLToPath(new URL('../../../', import.meta.url));
const COAL = ':global(html:is(.theme-coal, .theme-dark))';
const read = (file: string) => readFileSync(`${SRC}${file}`, 'utf8').replace(/\r\n/g, '\n');

// Collapses whitespace, including the line breaks the formatter puts inside long :global(...) selectors.
const squash = (text: string) => text.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');

// Declarations of the rule whose selector is exactly `selector` (whitespace-insensitive).
function rule(css: string, selector: string): Map<string, string> {
	const flat = squash(css.replace(/\/\*[\s\S]*?\*\//g, ''));
	const escaped = squash(selector).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const body = new RegExp(`(?:^|[}\\s])${escaped} \\{([^}]*)\\}`).exec(flat)?.[1];
	expect(body, selector).toBeDefined();
	return new Map([...(body ?? '').matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()]));
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

const VIOLET_HEX = /#(?:7c3aed|c026d3|5865f2|4641d9|a99adf|9ba4dd|cd9ac9|a855f7)\b|rgb\(168, 85, 247\)/i;

describe('sanalyer v1 surfaces in the coal and dark themes', () => {
	it('paints windows with the v1 box color instead of the rail near-black', () => {
		const css = read('features/app/components/dialogs/Modal.module.css');
		const inside = rule(css, `${COAL} .root`);
		expect(inside.get('--background-secondary')).toBe('var(--background-primary)');
		// The palette makes --background-primary and --background-secondary-alt the same color, so once the window surface
		// is that color too, raised boxes and hovers on --background-secondary-alt (Add server tiles, sudo boxes) need a step up.
		expect(inside.get('--background-secondary-alt')).toBe('var(--control-button-hover-bg)');
		// The rail token itself is untouched; the window re-scopes it for everything inside.
		expect(rule(css, '.root').get('background-color')).toBe('var(--background-secondary)');
	});

	it.each([
		['features/ui/action_menu/ContextMenu.module.css', '.contextMenu', 'background-color'],
		['features/ui/action_menu/ContextMenu.module.css', '.submenuPopover', 'background-color'],
		['features/ui/components/form/FormCombobox.module.css', '.popup', 'background-color'],
		['features/ui/popover/searchable_list_popout/SearchableListPopout.module.css', '.popout', 'background-color'],
	])('keeps %s %s on the summoned surface (--form-surface-background)', (file, selector, property) => {
		expect(rule(read(file), selector).get(property)).toBe('var(--form-surface-background)');
	});

	it.each([
		[
			'features/ui/action_menu/ContextMenu.module.css',
			`${COAL} :is(.contextMenu, .submenuPopover)`,
			'--surface-interactive-hover-bg',
		],
		[
			'features/guild/components/popouts/GuildHeaderPopout.module.css',
			`${COAL} .container`,
			'--surface-interactive-hover-bg',
		],
		['features/ui/components/form/FormCombobox.module.css', `${COAL} .popup`, '--background-modifier-hover'],
		[
			'features/ui/popover/searchable_list_popout/SearchableListPopout.module.css',
			`${COAL} .popout`,
			'--background-modifier-hover',
		],
	])('hovers menu rows in %s with the menu row color (--control-button-active-bg)', (file, selector, variable) => {
		expect(rule(read(file), selector).get(variable)).toBe('var(--control-button-active-bg)');
	});

	it('draws the v1 danger button without touching the danger fill token', () => {
		const css = read('features/ui/button/Button.module.css');
		const rest = rule(css, `${COAL} .button.danger`);
		expect(toHex(rest.get('background-color') ?? '')).toBe('#32191b');
		expect(toHex(rest.get('border-color') ?? '')).toBe('#56272b');
		expect(toHex(rest.get('color') ?? '')).toBe('#ff8b8b');
		const hover = rule(
			css,
			':global(html:is(.theme-coal, .theme-dark):where(.window-focused, .unfocused-fully-interactive):not(.window-focus-activation-guard)) .button.danger:hover:not(:disabled):not([data-disabled])',
		);
		expect(toHex(hover.get('background-color') ?? '')).toBe('#3d2124');
		expect(toHex(hover.get('border-color') ?? '')).toBe('#56272b');
		const active = rule(css, `${COAL} .button.danger:active:not(:disabled):not([data-disabled])`);
		expect(toHex(active.get('background-color') ?? '')).toBe('#32191b');
		for (const value of [...rest.values(), ...hover.values(), ...active.values()]) {
			expect(value).toContain('var(--saturation-factor)');
		}
		expect(rule(css, '.button.danger').get('background-color')).toContain('var(--button-danger-fill)');
	});

	it('drops the dashed ring around a selected white rail tile', () => {
		const css = read('features/app/components/layout/GuildsLayout.module.css');
		// .createGuildButton in front outranks the upstream hover rule (0,4,0), so the ring stays gone under the pointer.
		expect(
			rule(css, `${COAL} .createGuildButton [aria-current='page'] > .createGuildButtonIcon`).get('border-color'),
		).toBe('transparent');
		const skeleton = read('features/app/components/skeleton/GuildRailSkeleton.module.css');
		expect(rule(skeleton, `${COAL} .item[data-selected='true'] .actionIcon`).get('border-color')).toBe('transparent');
		expect(rule(css, '.createGuildButtonIcon').get('border')).toContain('dashed');
		for (const file of ['DiscoveryButton.tsx', 'FeedButton.tsx']) {
			const source = read(`features/app/components/layout/sidebar_nav/${file}`).replace(/\s+/g, ' ');
			// The tile is the button's only child, so the selector above reaches it while the page is current.
			expect(source, file).toMatch(
				/aria-current=\{isSelected \? 'page' : undefined\}[^>]*> <motion\.div ref=\{iconRef\} className=\{[^}]*guildStyles\.createGuildButtonIcon ?\}/,
			);
		}
	});

	it.each([
		['features/auth/flow/AuthPageStyles.module.css', `${COAL} .giftIconContainer`, 'background'],
		['features/user/components/modals/tabs/GiftInventoryTab.module.css', `${COAL} .giftIconActive`, 'background'],
		['features/streamer_mode/components/StreamerModeGate.module.css', `${COAL} .privacyMark`, 'background'],
	])('paints the %s mark with the white accent instead of violet', (file, selector, property) => {
		const decls = rule(read(file), selector);
		expect(decls.get(property)).toBe('var(--brand-primary)');
		expect(decls.get('color')).toBe('var(--text-on-brand-primary)');
		expect([...decls.values()].join(' ')).not.toMatch(VIOLET_HEX);
	});

	it('keeps the gift icons readable on the white mark', () => {
		const css = read('features/auth/flow/AuthPageStyles.module.css');
		expect(rule(css, `${COAL} .giftIcon`).get('color')).toBe('var(--text-on-brand-primary)');
		// Upstream colors the glyph itself white (.giftIconActive .giftIconImage), so the container color alone is not enough.
		const inventory = read('features/user/components/modals/tabs/GiftInventoryTab.module.css');
		expect(rule(inventory, '.giftIconActive .giftIconImage').get('color')).toBe('white');
		expect(rule(inventory, `${COAL} .giftIconActive .giftIconImage`).get('color')).toBe('var(--text-on-brand-primary)');
	});

	// Nagbar buttons are "inverted": a --button-inverted-fill pill with the bar color as text. On a white bar (brand,
	// streamer) the white pill with white text vanished, so in coal and dark the pill takes the bar's text color.
	it('keeps nagbar buttons readable on a white bar', () => {
		const nagbar = read('features/app/components/layout/Nagbar.tsx');
		expect(nagbar).toContain("'--nagbar-background-color': backgroundColor,");
		expect(nagbar).toContain("'--nagbar-text-color': textColor,");
		const css = read('features/app/components/layout/NagbarButton.module.css');
		expect(rule(css, '.button').get('--button-inverted-text')).toBe('var(--nagbar-background-color, inherit)');
		expect(rule(css, `${COAL} .button`).get('--button-inverted-fill')).toBe(
			'var(--nagbar-text-color, hsl(0, 0%, 100%))',
		);
		for (const kind of [NagbarToneKind.BRAND, NagbarToneKind.STREAMER]) {
			const tone = NAGBAR_TONES[kind];
			expect(tone.textColor, kind).not.toBe(tone.backgroundColor);
		}
	});

	it('turns the violet discovery placeholder tints neutral grey', () => {
		const css = read('features/discovery/discovery/DiscoveryGuildCard.module.css');
		const greys: Record<string, string> = {
			'.bannerTintViolet': '#9a9aa4',
			'.bannerTintIndigo': '#8e8e98',
			'.bannerTintMagenta': '#c4c4cc',
		};
		for (const [selector, grey] of Object.entries(greys)) {
			expect(rule(css, `${COAL} ${selector}`).get('background-color'), selector).toBe(grey);
		}
	});

	it('reads the streamer nagbar and group DM tones from coal/dark tokens with the upstream color as fallback', () => {
		const streamer = NAGBAR_TONES[NagbarToneKind.STREAMER];
		expect(streamer.backgroundColor).toBe('var(--streamer-mode-accent, #5865f2)');
		expect(streamer.textColor).toBe('var(--streamer-mode-accent-text, #ffffff)');
		const tones = new Set(Array.from({length: 400}, (_, i) => getGroupDMAccentColor(String(1e17 + i * 7919))));
		expect(tones).toContain('var(--group-dm-accent-violet, #7C3AED)');
		expect(tones).toContain('var(--group-dm-accent-fuchsia, #C026D3)');
		for (const tone of tones) {
			if (VIOLET_HEX.test(tone)) expect(tone, tone).toMatch(/^var\(--group-dm-accent-[a-z]+, #[0-9A-F]{6}\)$/);
		}
	});

	it('starts the color picker on the accent: v1 white in coal and dark, upstream violet elsewhere', () => {
		expect(getDefaultPickerHex(ThemeTypes.COAL)).toBe('#F4F4F6');
		expect(getDefaultPickerHex(ThemeTypes.DARK)).toBe('#F4F4F6');
		expect(getDefaultPickerHex(ThemeTypes.LIGHT)).toBe('#4641D9');
		expect(getDefaultPickerHex(ThemeTypes.DARK_LEGACY)).toBe('#4641D9');
		const popover = read('features/app/components/floating/ColorPickerPopover.tsx');
		expect(popover).not.toContain("'#4641D9'");
		const accent = read('features/user/components/modals/tabs/my_profile_tab/AccentColorPicker.tsx');
		expect(accent).not.toContain('0x4641d9');
		expect(accent).toContain('getDefaultPickerHex(Theme.effectiveTheme)');
	});

	// The feed logo is drawn by blending (see FeedButton.module.css). Coal and dark: white mark on the gray tile, dark
	// mark on the white selected tile. Light has a light gray tile, and light and dark_legacy keep a violet selected
	// tile, so the mark flips there to stay readable like the home glyph.
	it.each([
		['features/app/components/layout/sidebar_nav/FeedButton.module.css', '.logo', '.logoHighlighted'],
		[
			'features/app/components/skeleton/GuildRailSkeleton.module.css',
			'.feedLogo',
			".item[data-selected='true'] .feedLogo",
		],
	])('keeps the feed logo readable on light and violet tiles in %s', (file, rest, highlighted) => {
		const css = read(file);
		const light = rule(css, `:global(html.theme-light) ${rest}`);
		expect(light.get('filter')).toBe('invert(1) brightness(1.1)');
		expect(light.get('mix-blend-mode')).toBe('darken');
		const violet = rule(css, `:global(html:is(.theme-light, .theme-dark_legacy)) ${highlighted}`);
		expect(violet.get('filter')).toBe('none');
		expect(violet.get('mix-blend-mode')).toBe('lighten');
		// Same specificity as the light rule on the highlighted logo, so it has to come after it.
		const flat = squash(css);
		expect(flat.indexOf(':global(html:is(.theme-light, .theme-dark_legacy))')).toBeGreaterThan(
			flat.indexOf(':global(html.theme-light)'),
		);
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parse} from '@babel/parser';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const native = vi.hoisted(() => ({
	platform: 'windows' as 'windows' | 'macos' | 'linux' | 'unknown',
	electron: null as {setGameOverlayLayout?: () => void} | null,
}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({Trans: ({children}: {children: unknown}) => children}));
// SettingsConstants' own imports, stubbed: the real ones pull in most of the app.
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {isSelfHosted: () => false, giftCodesEnabled: false, getSnapshotOrNull: () => null},
}));
vi.mock('@app/features/app/config/I18nDisplayConstants', () => ({PREMIUM_PRODUCT_FULL_NAME: 'sanalyer Plus'}));
vi.mock('@app/features/ui/utils/NativeUtils', () => ({
	getElectronAPI: () => native.electron,
	guessPlatform: () => native.platform,
	isDesktop: () => native.electron != null,
	isNativeWindows: () => native.platform === 'windows',
}));
vi.mock('@app/features/user/components/modals/tabs/advanced_settings_tab/AdvancedSettingsCategories', () => ({
	ADVANCED_SETTINGS_TAG_LABELS: {},
	isAdvancedSettingsCategorySectionId: () => false,
}));
vi.mock('@app/features/user/components/settings_utils/SettingsNavigationGroups', () => ({
	ACCOUNT_NESTED_TAB_TYPES: [],
}));
vi.mock('@app/features/user/components/settings_utils/SettingsSectionRegistry', () => ({
	getAllSectionDefinitions: () => [],
	getSectionDefinition: () => undefined,
	getSectionIdsForTab: () => [],
	getSectionsForTab: () => [],
	getVisibleSectionsForTab: () => [],
	tabHasMultipleLinkableSections: () => false,
	tabHasSections: () => false,
}));
vi.mock('@app/features/user/state/Users', () => ({default: {getCurrentUser: () => null}}));

const {getSettingsTabs} = await import('@app/features/user/components/settings_utils/SettingsConstants');
const {gameOverlayIndex} = await import('@app/features/user/components/settings_utils/search_index/GameOverlayIndex');

const i18n = {
	_: (descriptor: {message: string} | string) => (typeof descriptor === 'string' ? descriptor : descriptor.message),
};
const tabTypes = () => getSettingsTabs(i18n as never).map((tab) => tab.type);
const bridge = {setGameOverlayLayout: () => undefined};

// The search index, the deep links and the tab components import most of the app, so their registration lines are
// read from the source instead of imported.
const SETTINGS_UTILS = fileURLToPath(new URL('../user/components/settings_utils/', import.meta.url));

function matchesInDeclaration(file: string, declaration: string, pattern: RegExp): Array<string> {
	const source = readFileSync(`${SETTINGS_UTILS}${file}`, 'utf8');
	const declarator = parse(source, {sourceType: 'module', plugins: ['typescript']})
		.program.body.flatMap((statement) => (statement.type === 'VariableDeclaration' ? statement.declarations : []))
		.find((node) => node.id.type === 'Identifier' && node.id.name === declaration);
	const init = declarator?.init;
	if (!init) return [];
	return [...source.slice(init.start ?? 0, init.end ?? 0).matchAll(pattern)].map((match) => match[1] ?? '');
}

describe('game overlay settings entry', () => {
	beforeEach(() => {
		native.platform = 'windows';
		native.electron = bridge;
	});

	it('is a top-level tab right below voice & video on the Windows desktop app', () => {
		const tabs = tabTypes();
		expect(tabs).toContain('game_overlay');
		expect(tabs[tabs.indexOf('voice_video') + 1]).toBe('game_overlay');
		expect(gameOverlayIndex.every((item) => item.isVisible?.() === true)).toBe(true);
	});

	it.each([
		['web on Windows', 'windows', null],
		['the macOS app', 'macos', bridge],
		['the Linux app', 'linux', bridge],
		['a Windows app without the overlay bridge', 'windows', {}],
	] as const)('has no tab and no search result on %s', (_name, platform, electron) => {
		native.platform = platform;
		native.electron = electron;
		expect(tabTypes()).not.toContain('game_overlay');
		expect(gameOverlayIndex.length).toBeGreaterThan(0);
		expect(gameOverlayIndex.some((item) => item.isVisible?.() !== false)).toBe(false);
	});

	it('draws the tab, is part of the settings search and has a deep link', () => {
		expect(
			matchesInDeclaration('DesktopSettingsTabs.ts', 'DESKTOP_TAB_COMPONENTS', /(\w+): GameOverlaySettingsTab\b/g),
		).toEqual(['game_overlay']);
		expect(matchesInDeclaration('SettingsSearchIndex.ts', 'ADDITIONAL_SEARCHABLE_ITEMS', /\.\.\.(\w+)/g)).toContain(
			'gameOverlayIndex',
		);
		expect(matchesInDeclaration('UserSettingsDeepLinks.ts', 'USER_SETTINGS_TAB_TYPES', /'(\w+)'/g)).toContain(
			'game_overlay',
		);
	});
});

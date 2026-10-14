// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parse} from '@babel/parser';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const runtime = vi.hoisted(() => ({selfHosted: true, giftCodes: true}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({Trans: ({children}: {children: unknown}) => children}));
// SettingsConstants' own imports, stubbed: the real ones pull in most of the app.
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {
		isSelfHosted: () => runtime.selfHosted,
		get giftCodesEnabled() {
			return runtime.giftCodes;
		},
	},
}));
vi.mock('@app/features/app/config/I18nDisplayConstants', () => ({PREMIUM_PRODUCT_FULL_NAME: 'sanalyer Plus'}));
vi.mock('@app/features/premium/utils/PremiumUtils', () => ({
	shouldShowPremiumFeatures: () => true,
	getPremiumProductFullName: () => 'sanalyer Plus',
	getPremiumProductName: () => 'sanalyer Plus',
}));
vi.mock('@app/features/ui/utils/NativeUtils', () => ({
	getElectronAPI: () => null,
	guessPlatform: () => 'unknown',
	isDesktop: () => false,
	isNativeWindows: () => false,
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

const i18n = {
	_: (descriptor: {message: string} | string) => (typeof descriptor === 'string' ? descriptor : descriptor.message),
};
const tabTypes = () => getSettingsTabs(i18n as never).map((tab) => tab.type);

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

// Micup: premium and the shop are pages beside the DM list; the settings keep neither tab (the shop's old id still
// parses, so an old link reaches the settings modal, which opens the page instead).
describe('shop settings entry', () => {
	beforeEach(() => {
		runtime.selfHosted = true;
		runtime.giftCodes = true;
	});

	it('is gone from the settings, and premium with it on a self-hosted instance', () => {
		expect(tabTypes()).not.toContain('shop');
		expect(tabTypes()).not.toContain('plutonium');
		runtime.selfHosted = false;
		expect(tabTypes()).not.toContain('shop');
		expect(tabTypes()).toContain('plutonium');
	});

	it('draws no shop tab and is not part of the settings search', () => {
		expect(matchesInDeclaration('DesktopSettingsTabs.ts', 'DESKTOP_TAB_COMPONENTS', /(\w+): ShopTab\b/g)).toEqual([]);
		expect(matchesInDeclaration('SettingsSearchIndex.ts', 'ADDITIONAL_SEARCHABLE_ITEMS', /\.\.\.(\w+)/g)).not.toContain(
			'shopIndex',
		);
	});

	it('still parses the old shop and premium links, so they can open the pages', () => {
		const tabs = matchesInDeclaration('UserSettingsDeepLinks.ts', 'USER_SETTINGS_TAB_TYPES', /'(\w+)'/g);
		expect(tabs).toContain('shop');
		expect(tabs).toContain('plutonium');
	});
});

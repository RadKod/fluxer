// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {observable, runInAction} from 'mobx';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/user/state/SyncedField', () => ({makeSyncedField: vi.fn(async () => {})}));

interface FakeUserSettings {
	hydrated: boolean;
	accessibility: {fontSize?: number} | undefined;
}

const MIGRATED_KEY = 'Accessibility:fontSizeDefault15MigratedV1';

async function loadAccessibility(synced: {fontSize?: number} | undefined) {
	const userSettings = observable<FakeUserSettings>({hydrated: true, accessibility: synced});
	vi.resetModules();
	const module = await import('@app/features/accessibility/state/Accessibility');
	module.setAccessibilityUserSettings({
		isHydrated: () => userSettings.hydrated,
		getSubPreference: () => userSettings.accessibility,
	});
	const accessibility = module.default;
	await vi.waitFor(() => expect(accessibility.isHydrated).toBe(true));
	return {accessibility, userSettings};
}

// The synced accessibility preferences reach the store after hydration; this stands in for that remote apply.
function applySyncedFontSize(accessibility: {fontSize: number}, fontSize: number): void {
	runInAction(() => {
		accessibility.fontSize = fontSize;
	});
}

describe('Micup chat text default (15px)', () => {
	beforeEach(() => {
		window.localStorage.clear();
	});

	afterEach(() => {
		window.localStorage.clear();
	});

	it('starts a device with nothing synced at 15px and marks it migrated', async () => {
		const {accessibility} = await loadAccessibility(undefined);
		expect(accessibility.fontSize).toBe(15);
		await vi.waitFor(() => expect(window.localStorage.getItem(MIGRATED_KEY)).toBe('true'));
	});

	it('moves a synced 16px to 15px once the synced value reaches the store', async () => {
		const {accessibility} = await loadAccessibility({fontSize: 16});
		expect(window.localStorage.getItem(MIGRATED_KEY)).toBeNull();
		applySyncedFontSize(accessibility, 16);
		await vi.waitFor(() => expect(accessibility.fontSize).toBe(15));
		expect(window.localStorage.getItem(MIGRATED_KEY)).toBe('true');
		accessibility.updateSettings({fontSize: 16});
		expect(accessibility.fontSize).toBe(16);
	});

	it('keeps any other synced size', async () => {
		const {accessibility} = await loadAccessibility({fontSize: 18});
		applySyncedFontSize(accessibility, 18);
		await vi.waitFor(() => expect(window.localStorage.getItem(MIGRATED_KEY)).toBe('true'));
		expect(accessibility.fontSize).toBe(18);
	});

	it('does not move 16px again on a device that already migrated', async () => {
		window.localStorage.setItem(MIGRATED_KEY, 'true');
		const {accessibility} = await loadAccessibility({fontSize: 16});
		applySyncedFontSize(accessibility, 16);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(accessibility.fontSize).toBe(16);
	});

	it('does not move a 16px chosen after the move again once a storage reset cleared the device', async () => {
		const first = await loadAccessibility({fontSize: 16});
		applySyncedFontSize(first.accessibility, 16);
		await vi.waitFor(() => expect(first.accessibility.fontSize).toBe(15));
		first.accessibility.updateSettings({fontSize: 16});
		const {resetAppStorage, PRESERVED_RESET_STORAGE_KEYS} = await import(
			'@app/features/platform/state/PersistentStorage'
		);
		await resetAppStorage(PRESERVED_RESET_STORAGE_KEYS);

		const {accessibility} = await loadAccessibility({fontSize: 16});
		applySyncedFontSize(accessibility, 16);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(accessibility.fontSize).toBe(16);
	});

	it('never loads UserSettings itself; UserSettings hands itself over', async () => {
		const userSettingsLoaded = vi.fn();
		vi.doMock('@app/features/user/state/UserSettings', () => {
			userSettingsLoaded();
			return {default: {isHydrated: () => false, getSubPreference: () => undefined}};
		});
		vi.resetModules();
		const accessibility = (await import('@app/features/accessibility/state/Accessibility')).default;
		await vi.waitFor(() => expect(accessibility.isHydrated).toBe(true));
		await new Promise((resolve) => setTimeout(resolve, 20));
		vi.doUnmock('@app/features/user/state/UserSettings');
		expect(userSettingsLoaded).not.toHaveBeenCalled();

		const here = dirname(fileURLToPath(import.meta.url));
		const userSettings = readFileSync(join(here, '../../user/state/UserSettings.ts'), 'utf8');
		expect(userSettings).toContain('setAccessibilityUserSettings(UserSettings);');
	});

	it('resets the chat font size setting to 15px', () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const scaling = readFileSync(join(here, '../../user/components/modals/tabs/appearance_tab/ScalingTab.tsx'), 'utf8');
		expect(scaling).toContain('const DEFAULT_FONT_SIZE = 15;');
		expect(scaling).toContain('const FONT_SIZE_OPTIONS = [12, 14, 15, 16, 18, 20, 24] as const;');
	});
});

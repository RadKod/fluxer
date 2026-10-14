// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {setupI18n} from '@lingui/core';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const runtime = vi.hoisted(() => ({
	selfHosted: true,
	premiumTrialDays: 0,
	giftCodesEnabled: false,
	getSnapshotOrNull: () => null,
	isSelfHosted(): boolean {
		return this.selfHosted;
	},
}));
const i18n = setupI18n({locale: 'en', messages: {en: {}}});

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n}),
	Trans: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: runtime}));
vi.mock('@app/features/user/state/Users', () => ({default: {getCurrentUser: () => ({isClaimed: () => true})}}));
// Stripe checkout, pricing, invoices and payment methods all live under PlutoniumContent.
vi.mock('@app/features/app/components/dialogs/components/PlutoniumContent', () => ({
	PlutoniumContent: () => (
		<div data-testid="stripe-plutonium" data-flx="user.plutonium-tab-test.plutonium-content.stripe-plutonium" />
	),
}));

// Idle and LocalPresence import each other; loading Idle first keeps its timer from calling a half-loaded store.
await import('@app/features/ui/state/Idle');
const {shouldShowPremiumFeatures} = await import('@app/features/premium/utils/PremiumUtils');
const {getSettingsTabs} = await import('@app/features/user/components/settings_utils/SettingsConstants');
const {default: PlutoniumTab} = await import('@app/features/user/components/modals/tabs/PlutoniumTab');

function configure(selfHosted: boolean, premiumTrialDays: number, giftCodesEnabled: boolean): void {
	Object.assign(runtime, {selfHosted, premiumTrialDays, giftCodesEnabled});
}

describe('premium visibility on a self-hosted instance', () => {
	it('stays hidden when the instance offers neither the trial nor keys', () => {
		configure(true, 0, false);
		expect(shouldShowPremiumFeatures()).toBe(false);
		expect(getSettingsTabs(i18n).map((tab) => tab.type)).not.toContain('plutonium');
	});

	it('shows for a trial or for keys, and always off self-hosted', () => {
		configure(true, 7, false);
		expect(shouldShowPremiumFeatures()).toBe(true);
		configure(true, 0, true);
		expect(shouldShowPremiumFeatures()).toBe(true);
		configure(false, 0, false);
		expect(shouldShowPremiumFeatures()).toBe(true);
	});

	// Micup: self-hosted premium is its own page beside the DM list (Routes.PREMIUM), not a settings tab.
	it('lists neither the premium tab nor the Stripe gift inventory on a self-hosted instance, even with keys', () => {
		configure(true, 7, true);
		const tabs = getSettingsTabs(i18n).map((tab) => tab.type);
		expect(tabs).not.toContain('plutonium');
		expect(tabs).not.toContain('gift_inventory');
		configure(false, 0, false);
		expect(getSettingsTabs(i18n).map((tab) => tab.type)).toContain('plutonium');
	});
});

describe('PlutoniumTab', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it('hosted still draws PlutoniumContent', () => {
		configure(false, 0, false);
		act(() => root.render(createElement(PlutoniumTab)));
		expect(container.querySelector('[data-testid="stripe-plutonium"]')).not.toBeNull();
	});
});

// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Micup: the purchase date only showed in the premium badge row tooltip, which the crown next to the
// name replaced. Its switch no longer changes anything anyone sees, so the settings stop offering it.

const i18n = {_: (descriptor: {message: string}) => descriptor.message};

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n})}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {getSnapshotOrNull: () => null, localInstanceDomain: 'micup.test'},
}));
vi.mock('@app/features/ui/components/form/FormSwitch', () => ({
	Switch: ({label}: {label: ReactNode}) => createElement('div', {role: 'switch'}, label),
}));

const {PremiumBadgeSettings} = await import(
	'@app/features/user/components/modals/tabs/my_profile_tab/PremiumBadgeSettings'
);

describe('PremiumBadgeSettings', () => {
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

	const render = (hasLifetimePremium: boolean) =>
		act(() =>
			root.render(
				createElement(PremiumBadgeSettings, {
					premiumBadgeHidden: false,
					premiumBadgeMasked: false,
					premiumBadgeSequenceHidden: false,
					onToggle: vi.fn(),
					hasLifetimePremium,
					premiumLifetimeSequence: 7,
				}),
			),
		);
	const switchLabels = () => Array.from(container.querySelectorAll('[role="switch"]'), (node) => node.textContent);

	it('offers a lifetime account the badge and Visionary switches but no purchase date switch', () => {
		render(true);

		expect(switchLabels()).toEqual([
			'Hide {premiumProductName} badge entirely',
			'Mask Visionary as subscription',
			'Hide Visionary ID badge ({premiumLifetimeSequenceLabel})',
		]);
	});

	it('offers a subscriber only the switch that hides the badge', () => {
		render(false);

		expect(switchLabels()).toEqual(['Hide {premiumProductName} badge entirely']);
	});
});

// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {setupI18n} from '@lingui/core';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const i18n = setupI18n({locale: 'en', messages: {en: {}}});

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n}),
	Trans: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/user/utils/LocaleUtils', () => ({getCurrentLocale: () => 'en'}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick, disabled}: {children: ReactNode; onClick?: () => void; disabled?: boolean}) => (
		<button type="button" onClick={onClick} disabled={disabled} data-flx="app.pricing-card-test.button.click">
			{children}
		</button>
	),
}));

const {PricingCard} = await import('@app/features/app/components/dialogs/components/PricingCard');

type PricingCardProps = Parameters<typeof PricingCard>[0];

describe('PricingCard', () => {
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

	const render = (props: PricingCardProps) => act(() => root.render(createElement(PricingCard, props)));

	it('renders exactly as before without the new props', () => {
		render({title: 'Monthly', price: '$4.99', period: 'per month', badge: 'Save 17%', onSelect: () => {}});
		expect(container.innerHTML).toMatchInlineSnapshot(
			`"<div class="_cardDefault_2f5522" aria-busy="false" data-flx="app.pricing-card.card-popular"><div class="_popularBadgeSpace_2f5522" data-flx="app.pricing-card.popular-badge-space"></div><div class="_contentContainer_2f5522" data-flx="app.pricing-card.content-container"><h3 class="_cardTitleDefault_2f5522" data-flx="app.pricing-card.card-title">Monthly</h3><p class="_cardPriceDefault_2f5522" data-flx="app.pricing-card.card-price">$4.99</p><p class="_cardPeriodDefault_2f5522" data-flx="app.pricing-card.card-period">per month</p><div class="_badgeSpace_2f5522" data-flx="app.pricing-card.badge-space"><span class="_badge_2f5522" data-flx="app.pricing-card.badge">Save 17%</span></div></div><button type="button" data-flx="app.pricing-card-test.button.click">Select</button></div>"`,
		);

		render({title: 'Yearly', price: '$49.99', isPopular: true, buttonText: 'Upgrade now', onSelect: () => {}});
		expect(container.innerHTML).toMatchInlineSnapshot(
			`"<div class="_cardPopular_2f5522" aria-busy="false" data-flx="app.pricing-card.card-popular"><div class="_popularBadgeSpace_2f5522" data-flx="app.pricing-card.popular-badge-space"><div class="_popularBadge_2f5522" data-flx="app.pricing-card.popular-badge">Most popular</div></div><div class="_contentContainer_2f5522" data-flx="app.pricing-card.content-container"><h3 class="_cardTitlePopular_2f5522" data-flx="app.pricing-card.card-title">Yearly</h3><p class="_cardPricePopular_2f5522" data-flx="app.pricing-card.card-price">$49.99</p><div class="_badgeSpace_2f5522" data-flx="app.pricing-card.badge-space"><span class="_badgePlaceholder_2f5522" data-flx="app.pricing-card.badge-placeholder" aria-hidden="true">.</span></div></div><button type="button" data-flx="app.pricing-card-test.button.click">Upgrade now</button></div>"`,
		);
	});

	it('shows the struck original price, the highlight label and the footer when given', () => {
		render({
			title: '12 months',
			price: '$40.00',
			originalPrice: '$50.00',
			isPopular: true,
			highlightLabel: 'Best value',
			footer: <span data-testid="footer" data-flx="app.pricing-card-test.footer" />,
			onSelect: () => {},
		});

		expect(container.textContent).toContain('Best value');
		expect(container.textContent).not.toContain('Most popular');
		const struck = container.querySelector('s');
		expect(struck?.textContent).toContain('$50.00');
		expect(struck?.textContent).toContain('Was $50.00');
		expect(container.querySelector('[data-testid="footer"]')).not.toBeNull();
	});
});

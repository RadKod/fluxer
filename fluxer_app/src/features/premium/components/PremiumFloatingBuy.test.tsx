// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type React from 'react';
import {act, createElement, createRef} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const catalog = vi.hoisted(() => ({packageEntries: [{sku: 'premium:1'}, {sku: 'premium:3'}] as Array<{sku: string}>}));

vi.mock('@app/features/shop/state/ShopCatalog', () => ({default: catalog}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick}: {children: React.ReactNode; onClick?: () => void}) =>
		createElement('button', {type: 'button', onClick}, children),
}));

const {PremiumFloatingBuy} = await import('@app/features/premium/components/PremiumFloatingBuy');

// A stand-in IntersectionObserver the test drives by hand.
class FakeObserver {
	static all: Array<FakeObserver> = [];
	targets: Array<Element> = [];
	constructor(
		readonly callback: IntersectionObserverCallback,
		readonly options?: IntersectionObserverInit,
	) {
		FakeObserver.all.push(this);
	}
	observe(target: Element) {
		this.targets.push(target);
	}
	unobserve() {}
	disconnect() {
		this.targets = [];
	}
	fire(target: Element, isIntersecting: boolean) {
		this.callback([{target, isIntersecting} as IntersectionObserverEntry], this as unknown as IntersectionObserver);
	}
}

describe('PremiumFloatingBuy', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const heroRef = createRef<HTMLDivElement>();
	const plansRef = createRef<HTMLDivElement>();
	const onClick = vi.fn();

	// The page around the capsule: the hero's buy button and one button per plan.
	const render = (plans: Array<string>) =>
		act(() =>
			root.render(
				createElement(
					'div',
					null,
					createElement('div', {ref: heroRef}, createElement('button', {type: 'button'}, 'Buy')),
					createElement(
						'div',
						{ref: plansRef},
						plans.map((plan) => createElement('button', {key: plan, type: 'button'}, plan)),
					),
					createElement(PremiumFloatingBuy, {heroRef, plansRef, label: 'Buy Plus', onClick}),
				),
			),
		);

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		FakeObserver.all = [];
		onClick.mockClear();
		catalog.packageEntries = [{sku: 'premium:1'}, {sku: 'premium:3'}];
		vi.stubGlobal('IntersectionObserver', FakeObserver);
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
		render(['1 month', '3 months']);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	const capsule = () => container.querySelector<HTMLElement>('[data-flx="premium.premium-floating-buy.capsule"]')!;
	const heroObserver = () => FakeObserver.all.find((observer) => observer.targets.includes(heroRef.current!))!;
	const plansObserver = () =>
		FakeObserver.all.findLast((observer) => observer.options?.rootMargin && observer.targets.length > 0)!;

	it('watches the hero buttons, and the plan buttons only below the top third', () => {
		expect(heroObserver()).toBeDefined();
		expect([...plansObserver().targets].map((button) => button.textContent)).toEqual(['1 month', '3 months']);
		expect(plansObserver().options?.rootMargin).toBe('-35% 0px 0px 0px');
	});

	it('hides while the hero buttons show, appears once they leave, hides again at the plans', () => {
		act(() => heroObserver().fire(heroRef.current!, true));
		expect(capsule().getAttribute('data-visible')).toBe('false');

		act(() => heroObserver().fire(heroRef.current!, false));
		expect(capsule().getAttribute('data-visible')).toBe('true');

		const firstPlan = plansObserver().targets[0]!;
		act(() => plansObserver().fire(firstPlan, true));
		expect(capsule().getAttribute('data-visible')).toBe('false');

		act(() => plansObserver().fire(firstPlan, false));
		expect(capsule().getAttribute('data-visible')).toBe('true');
	});

	it('watches the plan buttons a catalog refresh draws anew', () => {
		catalog.packageEntries = [{sku: 'premium:1'}, {sku: 'premium:3'}, {sku: 'premium:12'}];
		render(['1 month', '3 months', '12 months']);
		expect([...plansObserver().targets].map((button) => button.textContent)).toEqual([
			'1 month',
			'3 months',
			'12 months',
		]);
	});

	it('keeps a hidden capsule out of the tab order and out of the accessibility tree', () => {
		act(() => heroObserver().fire(heroRef.current!, true));
		expect(capsule().hasAttribute('inert')).toBe(true);
		expect(capsule().getAttribute('aria-hidden')).toBe('true');
	});

	it('leads to the plans on click', () => {
		act(() => heroObserver().fire(heroRef.current!, false));
		act(() => capsule().querySelector('button')!.click());
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});

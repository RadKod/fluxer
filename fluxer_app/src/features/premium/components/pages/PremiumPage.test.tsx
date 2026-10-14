// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {setupI18n} from '@lingui/core';
import type React from 'react';
import {act, createElement, forwardRef, useImperativeHandle, useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const i18n = setupI18n({locale: 'en', messages: {en: {}}});
const runtime = vi.hoisted(() => ({giftCodesEnabled: true, isSelfHosted: () => true}));
const catalog = vi.hoisted(() => ({
	status: 'ready' as 'idle' | 'loading' | 'ready' | 'failed',
	settings: null as {premium_sales_open: boolean} | null,
	packageEntries: [] as Array<unknown>,
	load: vi.fn(async () => {}),
}));
const users = vi.hoisted(() => ({currentUser: null as {premiumType: number | null; isPremium: () => boolean} | null}));
const trial = vi.hoisted(() => ({offer: null as {days: number; claiming: boolean; start: () => Promise<void>} | null}));
const motion = vi.hoisted(() => ({allowed: false, calls: [] as Array<Record<string, unknown>>}));
// The page scroller's handle: reveals record the node and keep the callback until the test lands the scroll.
const scroller = vi.hoisted(() => ({
	reveal: vi.fn() as (options: {node: HTMLElement; alignment?: string; callback?: () => void}) => void,
	viewport: null as HTMLElement | null,
}));

const passThrough = ({children}: {children?: React.ReactNode}) => children ?? null;
const stub = (testId: string) => () => createElement('div', {'data-testid': testId});

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n})}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: runtime}));
vi.mock('@app/features/shop/state/ShopCatalog', () => ({default: catalog}));
vi.mock('@app/features/user/state/Users', () => ({default: users}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({
	default: {useReducedMotion: false, useSmoothScrolling: false},
}));
vi.mock('@app/features/app/hooks/useShouldAnimate', () => ({
	useShouldAnimate: (options: Record<string, unknown>) => {
		motion.calls.push(options);
		return motion.allowed;
	},
}));
vi.mock('@app/features/app/config/I18nDisplayConstants', () => ({
	PREMIUM_PRODUCT_NAME: 'Plus',
	PREMIUM_PRODUCT_FULL_NAME: 'Micup Plus',
}));
vi.mock('@app/features/channel/components/ChannelHeader', () => ({
	ChannelHeader: ({leftContent}: {leftContent: React.ReactNode}) => createElement('header', null, leftContent),
}));
vi.mock('@app/features/ui/components/Scroller', () => ({
	Scroller: forwardRef<unknown, {children: React.ReactNode}>(({children}, ref) => {
		const viewport = useRef<HTMLDivElement>(null);
		useImperativeHandle(ref, () => ({
			getViewportElement: () => viewport.current,
			revealElement: (options: {node: HTMLElement; callback?: () => void}) => scroller.reveal(options),
		}));
		return createElement('div', {ref: viewport}, children);
	}),
}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: passThrough}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {enabled: false}}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick}: {children: React.ReactNode; onClick?: () => void}) =>
		createElement('button', {type: 'button', onClick}, children),
}));
vi.mock('@app/features/app/components/dialogs/components/FeatureComparisonTable', () => ({
	formatPerkValue: () => '500 MB',
}));
vi.mock('@app/features/premium/hooks/usePremiumTrial', () => ({usePremiumTrial: () => trial.offer}));
vi.mock('@app/features/premium/utils/PremiumBadgeAsset', () => ({premiumBadgeUrl: () => 'https://cdn.test/badge.svg'}));
// Each piece has its own test; here they only show where the page puts them and what it hands them.
vi.mock('@app/features/premium/components/PremiumStatusCard', () => ({
	PremiumStatusCard: ({onAddTime}: {onAddTime: (() => void) | null}) =>
		users.currentUser?.isPremium()
			? createElement(
					'div',
					{'data-testid': 'status'},
					onAddTime && createElement('button', {type: 'button', onClick: onAddTime}, 'Add time'),
				)
			: null,
}));
vi.mock('@app/features/premium/components/PremiumPerkTiles', () => ({PremiumPerkTiles: stub('perk-tiles')}));
vi.mock('@app/features/premium/components/PremiumCompareTable', () => ({PremiumCompareTable: stub('comparison')}));
vi.mock('@app/features/premium/components/PremiumPackages', () => ({
	PremiumPackages: ({sectionRef, codeInputId}: {sectionRef?: React.Ref<HTMLDivElement>; codeInputId: string}) =>
		createElement(
			'div',
			{ref: sectionRef, 'data-testid': 'packages', 'data-code-input': codeInputId},
			createElement('button', {type: 'button'}, '1 month'),
			createElement('button', {type: 'button'}, '3 months'),
		),
}));
vi.mock('@app/features/premium/components/PremiumFloatingBuy', () => ({
	PremiumFloatingBuy: ({label, onClick}: {label: string; onClick: () => void}) =>
		createElement('button', {type: 'button', 'data-testid': 'capsule', onClick}, label),
}));
vi.mock('@app/features/shop/components/ShopRedeemField', () => ({
	ShopRedeemField: ({variant, inputId}: {variant: string; inputId: string}) =>
		createElement('div', {'data-testid': 'code-card', 'data-variant': variant}, createElement('input', {id: inputId})),
	ShopRedeemJumpButton: ({inputId}: {inputId: string}) =>
		createElement('button', {type: 'button', 'data-testid': 'jump', 'data-input': inputId}, 'Redeem a code'),
}));

const {PremiumPage} = await import('@app/features/premium/components/pages/PremiumPage');

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
}
// Where the tests put the page's reading line, px under the top of the scroll area.
const LINE_PX = 120;

describe('PremiumPage', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let landScroll: (() => void) | undefined;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		runtime.giftCodesEnabled = true;
		Object.assign(catalog, {status: 'ready', settings: {premium_sales_open: true}, packageEntries: [{sku: 'p1'}]});
		catalog.load.mockClear();
		users.currentUser = {premiumType: 0, isPremium: () => false};
		trial.offer = null;
		motion.allowed = false;
		motion.calls = [];
		landScroll = undefined;
		scroller.reveal = vi.fn(({callback}) => {
			landScroll = callback;
		});
		FakeObserver.all = [];
		vi.stubGlobal('IntersectionObserver', FakeObserver);
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	// A new key per render: the page is a memoised observer and the fakes above are not observable.
	let renders = 0;
	const render = () => {
		act(() => root.render(createElement(PremiumPage, {key: ++renders})));
		scrolledTo('top');
	};
	const tabs = () => [...container.querySelectorAll<HTMLElement>('header button')].filter((b) => !b.dataset.testid);
	const tab = (label: string) => tabs().find((el) => el.textContent === label)!;
	const current = () => tabs().find((el) => el.getAttribute('aria-current') === 'true')?.textContent;
	const button = (label: string) =>
		[...container.querySelectorAll<HTMLElement>('button')].find((el) => el.textContent === label);
	const sections = () =>
		[...container.querySelectorAll<HTMLElement>('[data-section]')].map((el) => el.getAttribute('data-section'));
	const section = (key: string) => container.querySelector<HTMLElement>(`[data-section="${key}"]`)!;
	const hero = () => section('home');
	const viewport = () => section('home').parentElement!.parentElement!;
	const lineObserver = () =>
		FakeObserver.all.findLast((observer) => observer.targets.length > 0 && observer.options?.root === viewport());
	// A 2000 px page in an 800 px scroll area, at its top or at its end.
	const scrolledTo = (end: 'top' | 'end') => {
		for (const [name, value] of Object.entries({
			scrollHeight: 2000,
			offsetHeight: 800,
			scrollTop: end === 'end' ? 1200 : 0,
		})) {
			Object.defineProperty(viewport(), name, {value, configurable: true});
		}
	};
	// Puts each section's top this many px under the top of the scroll area, then scrolls: the line observer reports
	// which tops are above the line.
	const scrollTo = (tops: Record<string, number>) =>
		act(() => {
			for (const [key, top] of Object.entries(tops)) {
				section(key).getBoundingClientRect = () => ({top}) as DOMRect;
			}
			// A browser dispatches the scroll event first, then reports the observer's entries for that frame.
			viewport().dispatchEvent(new Event('scroll'));
			const observer = lineObserver();
			observer?.callback(
				Object.entries(tops).map(
					([key, top]) =>
						({target: section(key), isIntersecting: top <= LINE_PX}) as unknown as IntersectionObserverEntry,
				),
				observer as unknown as IntersectionObserver,
			);
		});

	it('titles the bar and offers Home, Plans and Compare as jump links, not tab panels', () => {
		render();
		expect(container.querySelector('header')?.textContent).toContain('Micup Plus');
		expect(tabs().map((el) => el.textContent)).toEqual(['Home', 'Plans', 'Compare']);
		expect(container.querySelector('[role="tab"], [role="tablist"], [role="tabpanel"]')).toBeNull();
		expect(current()).toBe('Home');
		expect(catalog.load).toHaveBeenCalled();
	});

	it('draws one long page: hero, perks, compare, plans, then the questions; no Visionary card', () => {
		render();
		expect(sections()).toEqual(['home', 'perks', 'compare', 'plans', 'faq']);
		expect(container.querySelector('[data-testid="visionary"]')).toBeNull();
		expect(section('perks').querySelector('[data-testid="perk-tiles"]')).not.toBeNull();
		expect(section('compare').querySelector('[data-testid="comparison"]')).not.toBeNull();
		expect(section('plans').querySelector('[data-testid="packages"]')).not.toBeNull();
		expect(section('faq').querySelectorAll('details')).toHaveLength(4);
	});

	it('the hero speaks in sentence case, reads live limits and buys through the halo', () => {
		render();
		expect(hero().querySelector('h1')?.textContent).toBe('Make your profile shine and your limits lift');
		expect(hero().textContent).toContain('500 MB');
		expect(hero().textContent).toContain('4K/60fps');
		expect(hero().textContent).toContain('One-time payment. It does not renew.');
		const buy = button('Buy Plus')!;
		expect(buy.closest('[data-flx="premium.premium-halo.halo"]')).not.toBeNull();
		// The Plus art behind the hero is decoration, loaded first.
		const art = hero().querySelector('[data-flx="premium.premium-page.hero-art"]');
		expect(art?.getAttribute('aria-hidden')).toBe('true');
		expect(art?.querySelector('img')?.getAttribute('fetchpriority')).toBe('high');
	});

	it('offers the free trial with its real length beside Buy', () => {
		const start = vi.fn(async () => {});
		trial.offer = {days: 7, claiming: false, start};
		render();
		act(() => button('Try free for 7 days')!.click());
		expect(start).toHaveBeenCalledTimes(1);
	});

	it('a tab reveals its section and keeps its mark until the scroll lands', () => {
		render();
		act(() => tab('Compare').click());
		expect(scroller.reveal).toHaveBeenCalledWith(
			expect.objectContaining({node: section('compare'), alignment: 'start'}),
		);
		expect(current()).toBe('Compare');

		// On the way the plans pass under the bar; the mark stays on the tab that was clicked.
		scrollTo({home: -900, compare: -300, plans: 40});
		expect(current()).toBe('Compare');

		act(() => landScroll?.());
		scrollTo({home: -900, compare: -300, plans: 40});
		expect(current()).toBe('Plans');
	});

	it('the mark follows the section under the bar as the page scrolls', () => {
		render();
		scrollTo({home: -600, compare: 20, plans: 900});
		expect(current()).toBe('Compare');
		scrollTo({home: 0, compare: 700, plans: 1600});
		expect(current()).toBe('Home');
	});

	it('the user taking over the scroll frees the mark from an unfinished reveal', () => {
		render();
		act(() => tab('Plans').click());
		act(() => {
			section('home').parentElement!.parentElement!.dispatchEvent(new Event('wheel'));
		});
		scrollTo({home: 0, compare: 700, plans: 1600});
		expect(current()).toBe('Home');
	});

	it('a tab whose section cannot reach the line keeps its mark at the end of the page until the user moves it', () => {
		render();
		act(() => tab('Plans').click());
		scrolledTo('end');
		act(() => landScroll?.());
		scrollTo({home: -1500, compare: -200, plans: 300});
		expect(current()).toBe('Plans');

		// A press on the scrollbar (or a middle-click autoscroll) is the user taking over too.
		act(() => {
			viewport().dispatchEvent(new Event('pointerdown'));
		});
		scrollTo({home: -1500, compare: -200, plans: 300});
		expect(current()).toBe('Compare');
	});

	it('follows the sections through an observer on the reading line, reading no layout while scrolling', () => {
		render();
		expect(lineObserver()?.targets).toEqual([section('home'), section('compare'), section('plans')]);
		expect(lineObserver()?.options?.rootMargin).toBe('100000px 0px -85% 0px');
		const measure = vi.spyOn(Element.prototype, 'getBoundingClientRect');
		act(() => {
			viewport().dispatchEvent(new Event('scroll'));
		});
		expect(measure).not.toHaveBeenCalled();
		measure.mockRestore();
	});

	it('"Buy Premium", "Add time" and the capsule reveal the plans and focus the first plan', () => {
		render();
		act(() => button('Buy Plus')!.click());
		expect(scroller.reveal).toHaveBeenLastCalledWith(expect.objectContaining({node: section('plans')}));
		expect(document.activeElement?.textContent).toBe('1 month');

		act(() => button('Buy Plus')!.blur());
		act(() => container.querySelector<HTMLElement>('[data-testid="capsule"]')!.click());
		expect(scroller.reveal).toHaveBeenCalledTimes(2);
		expect(document.activeElement?.textContent).toBe('1 month');

		users.currentUser = {premiumType: UserPremiumTypes.SUBSCRIPTION, isPremium: () => true};
		render();
		expect(button('Buy Plus')).toBeUndefined();
		expect(container.querySelector('[data-testid="capsule"]')?.textContent).toBe('Add time');
		act(() => button('Add time')!.click());
		expect(scroller.reveal).toHaveBeenLastCalledWith(expect.objectContaining({node: section('plans')}));
	});

	it('without anything to sell there is no Plans tab or section, no buy button and no capsule', () => {
		Object.assign(catalog, {settings: {premium_sales_open: false}, packageEntries: []});
		render();
		expect(tabs().map((el) => el.textContent)).toEqual(['Home', 'Compare']);
		expect(sections()).toEqual(['home', 'compare', 'faq']);
		expect(button('Buy Plus')).toBeUndefined();
		expect(container.querySelector('[data-testid="capsule"]')).toBeNull();
	});

	it('premium on sale with no package priced leaves out the empty Plans tab and section', () => {
		Object.assign(catalog, {settings: {premium_sales_open: true}, packageEntries: []});
		render();
		expect(tabs().map((el) => el.textContent)).toEqual(['Home', 'Compare']);
		expect(sections()).not.toContain('plans');
		expect(container.querySelector('[data-testid="capsule"]')).toBeNull();
	});

	it('a lifetime member gets no Plans tab and no capsule', () => {
		users.currentUser = {premiumType: UserPremiumTypes.LIFETIME, isPremium: () => true};
		render();
		expect(tabs().map((el) => el.textContent)).toEqual(['Home', 'Compare']);
		expect(sections()).not.toContain('plans');
		expect(container.querySelector('[data-testid="capsule"]')).toBeNull();
	});

	it.each([
		['loading', {status: 'loading', settings: null, packageEntries: []}],
		['failed', {status: 'failed', settings: null, packageEntries: []}],
		['empty', {status: 'ready', settings: {premium_sales_open: true}, packageEntries: []}],
		['sales closed', {status: 'ready', settings: {premium_sales_open: false}, packageEntries: []}],
	])('keeps the code card and its bar button while the catalog is %s', (_, state) => {
		Object.assign(catalog, state);
		render();
		const card = section('faq').querySelector<HTMLElement>('[data-testid="code-card"]');
		expect(card?.dataset.variant).toBe('card');
		const jump = container.querySelector<HTMLElement>('header [data-testid="jump"]');
		expect(jump?.dataset.input).toBe(card?.querySelector('input')?.id);
	});

	it('points the paused-sales notice of the plans at the code card, not at a second code field', () => {
		Object.assign(catalog, {status: 'ready', settings: {premium_sales_open: false}});
		render();
		const card = section('faq').querySelector<HTMLElement>('[data-testid="code-card"]');
		expect(section('plans').querySelector<HTMLElement>('[data-testid="packages"]')?.dataset.codeInput).toBe(
			card?.querySelector('input')?.id,
		);
	});

	it('shows neither the code card nor its bar button where codes are off', () => {
		runtime.giftCodesEnabled = false;
		render();
		expect(container.querySelector('[data-testid="code-card"]')).toBeNull();
		expect(container.querySelector('[data-testid="jump"]')).toBeNull();
		expect(section('faq').querySelectorAll('details')).toHaveLength(4);
	});

	it('moves the hero lights and buy halo only when Fluxer allows it, on hover or focus', () => {
		render();
		const halo = () => hero().querySelector('[data-flx="premium.premium-halo.halo"]');
		expect(motion.calls.at(-1)).toMatchObject({kind: 'avatar', isHovering: false, isFocused: false});
		expect(hero().getAttribute('data-animated')).toBe('false');
		expect(halo()?.getAttribute('data-animated')).toBe('false');

		motion.allowed = true;
		act(() => {
			hero().dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));
		});
		expect(motion.calls.at(-1)).toMatchObject({kind: 'avatar', isHovering: true});
		expect(hero().getAttribute('data-animated')).toBe('true');
		expect(halo()?.getAttribute('data-animated')).toBe('true');
	});
});

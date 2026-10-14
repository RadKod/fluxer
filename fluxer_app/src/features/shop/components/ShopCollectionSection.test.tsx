// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface Watched {
	element: Element;
	callback: (entry: IntersectionObserverEntry) => void;
	options: {root?: Element | null; threshold?: number | Array<number>};
	released: boolean;
}

const watched = vi.hoisted(() => [] as Array<Watched>);

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {useSmoothScrolling: false}}));
// The row's one observer comes from Fluxer's shared pool; here it only records what the row asked for.
vi.mock('@app/features/platform/utils/SharedIntersectionObserver', () => ({
	observeIntersection: (element: Element, callback: Watched['callback'], options: Watched['options']): (() => void) => {
		const entry: Watched = {element, callback, options, released: false};
		watched.push(entry);
		return () => {
			entry.released = true;
		};
	},
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({
		onClick,
		tabIndex,
		'aria-label': ariaLabel,
		'data-flx': flx,
	}: {
		onClick?: () => void;
		tabIndex?: number;
		'aria-label'?: string;
		'data-flx': string;
	}) => createElement('button', {type: 'button', onClick, tabIndex, 'aria-label': ariaLabel, 'data-flx': flx}),
}));

const {ShopCollectionSection} = await import('@app/features/shop/components/ShopCollectionSection');

describe('ShopCollectionSection', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		watched.length = 0;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = (cards: Array<string>, action?: React.ReactNode) =>
		act(() =>
			root.render(
				createElement(ShopCollectionSection, {
					title: 'Sonbahar',
					action,
					children: cards.map((id) => createElement('div', {key: id, 'data-card': id})),
				}),
			),
		);
	const row = () => container.querySelector<HTMLDivElement>('[role="list"]')!;
	const live = () => watched.filter((entry) => !entry.released);
	// The pool calls back with how much of a card the row shows.
	const show = (card: string, ratio: number) =>
		act(() => {
			for (const entry of live().filter(({element}) => element.getAttribute('data-card') === card)) {
				entry.callback({intersectionRatio: ratio, isIntersecting: ratio > 0} as IntersectionObserverEntry);
			}
		});
	const arrow = (side: 'previous' | 'next') =>
		container.querySelector<HTMLButtonElement>(`[data-flx="shop.shop-tab.row-${side}"]`);

	it('watches only the first and the last card, with the row as the root of one observer', () => {
		render(['a', 'b', 'c']);
		expect(live().map(({element}) => element.getAttribute('data-card'))).toEqual(['a', 'c']);
		for (const entry of live()) {
			expect(entry.options.root).toBe(row());
			expect(entry.options.threshold).toBe(0.99);
		}
	});

	it('shows no arrow while every card fits', () => {
		render(['a', 'b', 'c']);
		show('a', 1);
		show('c', 1);
		expect(arrow('previous')).toBeNull();
		expect(arrow('next')).toBeNull();
	});

	it('offers the next page while the last card is cut, and the previous one once the first is', () => {
		render(['a', 'b', 'c']);
		show('a', 1);
		show('c', 0.4);
		expect(arrow('previous')).toBeNull();
		expect(arrow('next')?.getAttribute('aria-label')).toBe('Next');

		show('a', 0.2);
		show('c', 1);
		expect(arrow('previous')?.getAttribute('aria-label')).toBe('Previous');
		expect(arrow('next')).toBeNull();
	});

	// Tab already walks the cards and scrolls each into view; an arrow leaves when its end is reached, so a focused one
	// would drop focus to the page.
	it('keeps the arrows out of the tab order', () => {
		render(['a', 'b', 'c']);
		show('a', 0.5);
		show('c', 0.5);
		expect(arrow('previous')?.getAttribute('tabindex')).toBe('-1');
		expect(arrow('next')?.getAttribute('tabindex')).toBe('-1');
	});

	it('pages the row by its width, backwards in a right-to-left layout', () => {
		render(['a', 'b', 'c']);
		const scrollBy = vi.fn();
		Object.defineProperty(row(), 'clientWidth', {configurable: true, value: 1000});
		row().scrollBy = scrollBy as unknown as HTMLElement['scrollBy'];
		show('a', 0.5);
		show('c', 0.5);

		act(() => arrow('next')!.click());
		expect(scrollBy).toHaveBeenLastCalledWith({left: 1000, behavior: 'auto'});
		act(() => arrow('previous')!.click());
		expect(scrollBy).toHaveBeenLastCalledWith({left: -1000, behavior: 'auto'});

		row().style.direction = 'rtl';
		act(() => arrow('next')!.click());
		expect(scrollBy).toHaveBeenLastCalledWith({left: -1000, behavior: 'auto'});
	});

	it('watches the new edge cards after the row changes', () => {
		render(['a', 'b', 'c']);
		render(['d', 'e']);
		expect(live().map(({element}) => element.getAttribute('data-card'))).toEqual(['d', 'e']);
	});

	it('puts the action beside the heading, outside it', () => {
		render(['a'], createElement('button', {type: 'button', 'data-action': true}));
		const heading = container.querySelector('h2');
		const action = container.querySelector('[data-action]');
		expect(heading?.textContent).toBe('Sonbahar');
		expect(action).not.toBeNull();
		expect(heading?.contains(action)).toBe(false);
		expect(action?.closest('[role="list"]')).toBeNull();
	});
});

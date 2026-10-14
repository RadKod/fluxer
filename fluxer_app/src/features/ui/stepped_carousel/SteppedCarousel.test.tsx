// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import Accessibility from '@app/features/accessibility/state/Accessibility';
import {SteppedCarousel} from '@app/features/ui/stepped_carousel/SteppedCarousel';
import {act, createElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/user/state/SyncedField', () => ({makeSyncedField: vi.fn(async () => {})}));

// The system asks for reduced motion (framer-motion reads "(prefers-reduced-motion)", the app the ": reduce" form).
vi.hoisted(() => {
	const matchMedia = window.matchMedia.bind(window);
	window.matchMedia = (query: string) =>
		query.includes('prefers-reduced-motion')
			? ({matches: true, media: query, addEventListener() {}, removeEventListener() {}} as unknown as MediaQueryList)
			: matchMedia(query);
});

// happy-dom cannot run the animations: the motion element only records the transition it was given.
vi.mock('framer-motion', async (importOriginal) => {
	const actual = await importOriginal<typeof import('framer-motion')>();
	const {createElement, forwardRef} = await import('react');
	const div = forwardRef<HTMLDivElement, Record<string, unknown>>(
		(
			{transition, variants: _variants, initial: _initial, animate: _animate, exit: _exit, custom: _custom, ...rest},
			ref,
		) => createElement('div', {...rest, ref, 'data-transition': JSON.stringify(transition ?? null)}),
	);
	return {...actual, motion: {div}, AnimatePresence: ({children}: {children: ReactNode}) => children};
});

let container: HTMLDivElement;
let root: Root;

function renderCarousel(): string | null {
	act(() => {
		root.render(createElement(SteppedCarousel<'one' | 'two'>, {step: 'one', steps: ['one', 'two'], children: 'Step'}));
	});
	return container.querySelector('[data-flx="ui.stepped-carousel.container"]')?.getAttribute('data-transition') ?? null;
}

describe('SteppedCarousel motion', () => {
	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		Accessibility.updateSettings({reducedMotionOverride: null});
	});

	it('animates the height when the system asks for reduced motion but the app setting is off', () => {
		expect(JSON.parse(renderCarousel() ?? 'null')).toMatchObject({type: 'spring'});
	});

	it('switches instantly when the app reduces motion', () => {
		Accessibility.updateSettings({reducedMotionOverride: true});

		expect(JSON.parse(renderCarousel() ?? 'null')).toEqual({duration: 0});
	});
});

// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CosmeticAssetDataResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

let rowHovered = false;
const accessibility = vi.hoisted(() => ({useReducedMotion: false}));

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {mediaEndpoint: 'https://media.micup.test'}}));
// The animation policy reads these stores; the real ones start preference sync and the locale loader.
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: accessibility}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {}}));
vi.mock('@app/features/app/hooks/useHover', () => ({useHover: () => [() => {}, rowHovered]}));

const {NameplateBackground} = await import('@app/features/cosmetics/components/NameplateBackground');

const PLATE: CosmeticAssetDataResponse = {asset: 'a_9a8b7c6d', item_id: '1300000000000000002'};
const BASE = 'https://media.micup.test/branding/cosmetic-nameplate-1300000000000000002';

describe('NameplateBackground', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		rowHovered = false;
		accessibility.useReducedMotion = false;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = (nameplate: CosmeticAssetDataResponse | null, animate?: boolean) =>
		act(() =>
			root.render(
				createElement(NameplateBackground, {nameplate, animate, children: createElement('span', null, 'row')}),
			),
		);

	it('leaves the row untouched when the user wears no nameplate', () => {
		render(null);
		expect(container.innerHTML).toBe('<span>row</span>');
	});

	it('draws the static nameplate behind the row content', () => {
		render(PLATE);
		const image = container.querySelector('img');
		expect(image?.getAttribute('src')).toBe(`${BASE}/9a8b7c6d.webp?size=240`);
		expect(image?.getAttribute('data-flx')).toBe('cosmetics.nameplate-background.image');
		const content = container.querySelector('[data-flx="cosmetics.nameplate-background.content"]');
		expect(content?.innerHTML).toBe('<span>row</span>');
	});

	it('plays the animated nameplate only while the row is hovered', () => {
		rowHovered = true;
		render(PLATE);
		expect(container.querySelector('img')?.getAttribute('src')).toBe(`${BASE}/a_9a8b7c6d.webp?size=240&animated=true`);
	});

	// The shop's preview row is inert, so no hover ever reaches it; it asks the nameplate to play on its own.
	it('plays the animated nameplate without a hover when the row asks it to', () => {
		render(PLATE, true);
		expect(container.querySelector('img')?.getAttribute('src')).toBe(`${BASE}/a_9a8b7c6d.webp?size=240&animated=true`);
	});

	it('keeps an asked-for nameplate still under reduced motion', () => {
		accessibility.useReducedMotion = true;
		render(PLATE, true);
		expect(container.querySelector('img')?.getAttribute('src')).toBe(`${BASE}/9a8b7c6d.webp?size=240`);
	});

	it('keeps the row content when the image fails to load', () => {
		render(PLATE);
		act(() => {
			container.querySelector('img')?.dispatchEvent(new Event('error'));
		});
		expect(container.querySelector('img')).toBeNull();
		expect(container.textContent).toBe('row');
	});
});

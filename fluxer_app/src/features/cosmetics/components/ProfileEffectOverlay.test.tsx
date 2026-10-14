// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CosmeticAssetDataResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

let profileAutoplay = false;

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {mediaEndpoint: 'https://media.micup.test'}}));
// The animation policy reads these stores; the real ones start preference sync and the locale loader.
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {useReducedMotion: false}}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {}}));
vi.mock('@app/features/user/hooks/useAutoplayExpandedProfileAnimations', () => ({
	useAutoplayExpandedProfileAnimations: () => profileAutoplay,
}));

const {ProfileEffectOverlay} = await import('@app/features/cosmetics/components/ProfileEffectOverlay');

const EFFECT: CosmeticAssetDataResponse = {asset: 'a_5e4d3c2b', item_id: '1300000000000000003'};
const BASE = 'https://media.micup.test/branding/cosmetic-profile_effect-1300000000000000003';

describe('ProfileEffectOverlay', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		profileAutoplay = false;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = (effect: CosmeticAssetDataResponse | null | undefined) =>
		act(() => root.render(createElement(ProfileEffectOverlay, {effect})));

	it('draws nothing when the profile has no effect', () => {
		render(null);
		render(undefined);
		expect(container.innerHTML).toBe('');
	});

	it('shows the static first frame when the open profile may not autoplay', () => {
		render(EFFECT);
		const image = container.querySelector('img');
		expect(image?.getAttribute('src')).toBe(`${BASE}/5e4d3c2b.webp?size=480`);
		expect(image?.getAttribute('data-flx')).toBe('cosmetics.profile-effect-overlay.image');
	});

	it('plays the effect when the open profile autoplays its animations', () => {
		profileAutoplay = true;
		render(EFFECT);
		expect(container.querySelector('img')?.getAttribute('src')).toBe(`${BASE}/a_5e4d3c2b.webp?size=480&animated=true`);
	});

	it('hides the effect when the image fails to load', () => {
		render(EFFECT);
		act(() => {
			container.querySelector('img')?.dispatchEvent(new Event('error'));
		});
		expect(container.querySelector('img')).toBeNull();
	});
});

// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import type {
	CosmeticAssetDataResponse,
	UltraFront,
	UltraLayout,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const accessibility = vi.hoisted(() => ({useReducedMotion: false}));
const layouts = vi.hoisted(() => new Map<string, UltraLayout>());
const fronts = vi.hoisted(() => new Map<string, UltraFront | null | undefined>());
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {mediaEndpoint: 'https://media.micup.test/'}}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: accessibility}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/cosmetics/state/UltraLayouts', () => ({
	default: {
		layoutFor: (itemId: string) => layouts.get(itemId) ?? null,
		// Default: read, no front — every existing case draws behind exactly as before.
		frontFor: (itemId: string) => (fronts.has(itemId) ? fronts.get(itemId) : null),
	},
}));
vi.mock('@app/features/cosmetics/components/AvatarUltraFront', () => ({
	AvatarUltraFront: ({itemId}: {itemId: string}) => createElement('i', {'data-front': itemId}),
}));
vi.mock('@app/features/cosmetics/utils/CosmeticAssetUtils', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@app/features/cosmetics/utils/CosmeticAssetUtils')>();
	return {...actual, getCosmeticAssetURL: vi.fn(actual.getCosmeticAssetURL)};
});

const {AvatarUltraLayer} = await import('@app/features/cosmetics/components/AvatarUltraLayer');
const {getCosmeticAssetURL} = await import('@app/features/cosmetics/utils/CosmeticAssetUtils');
const {default: styles} = await import('@app/features/cosmetics/components/AvatarUltraLayer.module.css');

type Surface = 'none' | 'compact' | 'voice' | 'profile';
const ULTRA: CosmeticAssetDataResponse = {asset: 'a_9a8b7c6d', item_id: '1300000000000000009'};
const BASE = 'https://media.micup.test/branding/cosmetic-avatar_ultra-1300000000000000009';

describe('AvatarUltraLayer', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		accessibility.useReducedMotion = false;
		layouts.clear();
		fronts.clear();
		act(() => root.unmount());
		container.remove();
	});

	const render = (
		ultra: CosmeticAssetDataResponse | null,
		{size = 40, animate = false, surface = 'compact'}: {size?: number; animate?: boolean; surface?: Surface} = {},
	) => act(() => root.render(createElement(AvatarUltraLayer, {ultra, size, animate, surface})));
	const source = () => container.querySelector('img')?.getAttribute('src') ?? null;

	it('draws nothing without an ultra decoration', () => {
		render(null);
		expect(container.innerHTML).toBe('');
	});

	it('draws no ultra decoration on a surface that has not opted in', () => {
		render(ULTRA, {size: 80, surface: 'none'});
		expect(container.innerHTML).toBe('');
	});

	it('draws no ultra decoration below a 32 px avatar', () => {
		render(ULTRA, {size: 24});
		expect(container.innerHTML).toBe('');
	});

	it('sizes it at 2.30 times a chat or member list avatar and shows the still first frame at rest', () => {
		render(ULTRA, {size: 40});
		expect(source()).toBe(`${BASE}/9a8b7c6d.webp?size=128`);
	});

	it('sizes it at 3.40 times a profile avatar', () => {
		render(ULTRA, {size: 80, surface: 'profile'});
		expect(source()).toBe(`${BASE}/9a8b7c6d.webp?size=300`);
	});

	it('sizes it at 3.20 times a voice tile avatar, between the chat and the profile scales', () => {
		render(ULTRA, {size: 48, surface: 'voice'});
		expect(source()).toBe(`${BASE}/9a8b7c6d.webp?size=160`);
		render(ULTRA, {size: 48, surface: 'profile'});
		expect(source()).toBe(`${BASE}/9a8b7c6d.webp?size=240`);
	});

	it('caps the image at the 480 px upload limit on a full-size voice tile', () => {
		render(ULTRA, {size: 192, surface: 'voice'});
		expect(source()).toBe(`${BASE}/9a8b7c6d.webp?size=480`);
	});

	it('caps the image at the 480 px upload limit on the large profile', () => {
		render(ULTRA, {size: 120, surface: 'profile'});
		expect(source()).toBe(`${BASE}/9a8b7c6d.webp?size=480`);
	});

	it('plays the animated decoration on interaction', () => {
		render(ULTRA, {animate: true});
		expect(source()).toBe(`${BASE}/a_9a8b7c6d.webp?size=128&animated=true`);
	});

	it('keeps it still under reduced motion, on interaction too', () => {
		accessibility.useReducedMotion = true;
		render(ULTRA, {animate: true});
		expect(source()).toBe(`${BASE}/9a8b7c6d.webp?size=128`);
	});

	it('hides it when the image fails to load', () => {
		render(ULTRA);
		act(() => {
			container.querySelector('img')?.dispatchEvent(new Event('error'));
		});
		expect(container.querySelector('img')).toBeNull();
	});

	it('marks it as decoration only', () => {
		render(ULTRA);
		const image = container.querySelector('img');
		expect(image?.getAttribute('aria-hidden')).toBe('true');
		expect(image?.getAttribute('alt')).toBe('');
		expect(image?.getAttribute('data-flx')).toBe('cosmetics.avatar-ultra-layer.image');
	});

	it('keeps a voice tile decoration within the tile height, centred on the avatar', () => {
		const css = readFileSync('src/features/cosmetics/components/AvatarUltraLayer.module.css', 'utf8');
		const start = css.indexOf('.ultraVoice {');
		const voice = css.slice(start, css.indexOf('}', start));
		expect(voice).toContain('width: min(calc(var(--ultra-scale) * 100%), 100cqh);');
		expect(voice).toContain('height: min(calc(var(--ultra-scale) * 100%), 100cqh);');
		expect(voice).toContain('transform: translate(-50%, -50%);');
	});

	it('renders no style attribute without a layout', () => {
		for (const surface of ['compact', 'voice', 'profile'] as const) {
			render(ULTRA, {size: 80, surface});
			const image = container.querySelector('img');
			expect(image?.hasAttribute('style')).toBe(false);
			expect(image?.classList.contains(styles.ultraCustom)).toBe(false);
		}
	});

	it('uses the admin size for the surface it draws on', () => {
		layouts.set(ULTRA.item_id, {
			compact: {width: 2.5, height: 2.4, offset_x: 0.05, offset_y: -0.1},
			voice: null,
			profile: null,
		});
		render(ULTRA, {size: 40});
		const image = container.querySelector('img');
		expect(image?.classList.contains(styles.ultraCustom)).toBe(true);
		expect(image?.style.getPropertyValue('--ultra-w')).toBe('2.5');
		expect(image?.style.getPropertyValue('--ultra-h')).toBe('2.4');
		expect(image?.style.getPropertyValue('--ultra-x')).toBe('0.05');
		expect(image?.style.getPropertyValue('--ultra-y')).toBe('-0.1');
		render(ULTRA, {size: 80, surface: 'profile'});
		expect(container.querySelector('img')?.hasAttribute('style')).toBe(false);
		expect(container.querySelector('img')?.classList.contains(styles.ultraCustom)).toBe(false);
	});

	it('asks for an image as large as the wider side', () => {
		layouts.set(ULTRA.item_id, {
			compact: null,
			voice: {width: 2.8, height: 3.6, offset_x: 0, offset_y: 0},
			profile: null,
		});
		render(ULTRA, {size: 48, surface: 'voice'});
		expect(getCosmeticAssetURL).toHaveBeenLastCalledWith(
			'avatar_ultra',
			ULTRA,
			expect.closeTo((48 * 3.6 * 648.4) / 635.6, 6),
			false,
		);
	});

	describe('in front', () => {
		const FRONT: UltraFront = {closed: 'c0', open: ['c0', 'f1'], idle: 'a_idle'};
		const place = (placement: 'behind' | 'front') =>
			act(() =>
				root.render(
					createElement(AvatarUltraLayer, {ultra: ULTRA, size: 40, animate: false, surface: 'compact', placement}),
				),
			);

		it('draws nothing before the item is read', () => {
			fronts.set(ULTRA.item_id, undefined);
			place('behind');
			expect(container.innerHTML).toBe('');
			place('front');
			expect(container.innerHTML).toBe('');
		});

		it('draws an in-front item only in front', () => {
			fronts.set(ULTRA.item_id, FRONT);
			place('behind');
			expect(container.innerHTML).toBe('');
			place('front');
			expect(container.querySelector('[data-front]')?.getAttribute('data-front')).toBe(ULTRA.item_id);
		});

		it('draws an item without a front only behind, as before', () => {
			place('front');
			expect(container.innerHTML).toBe('');
			place('behind');
			expect(source()).toBe(`${BASE}/9a8b7c6d.webp?size=128`);
		});

		it('falls back to behind when reading failed', () => {
			fronts.set(ULTRA.item_id, null);
			place('behind');
			expect(source()).toBe(`${BASE}/9a8b7c6d.webp?size=128`);
			place('front');
			expect(container.innerHTML).toBe('');
		});
	});
});

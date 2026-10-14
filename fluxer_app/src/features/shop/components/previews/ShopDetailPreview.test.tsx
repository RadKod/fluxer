// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {ULTRA_BOX_SCALE} from '@app/features/cosmetics/constants/AvatarDecorationGeometry';
import UltraLayouts from '@app/features/cosmetics/state/UltraLayouts';
import type {User} from '@app/features/user/models/User';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {getMessageGroupSpacingValue: () => 16}}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: ({message}: {message: string}) => message}})}));
vi.mock('@app/features/shop/components/ShopItemStage', () => ({
	ShopItemStage: () => createElement('span', {'data-drawn': 'profile'}),
}));
vi.mock('@app/features/shop/components/previews/ShopMemberRowPreview', () => ({
	ShopMemberRowPreview: () => createElement('span', {'data-drawn': 'member_list'}),
}));
vi.mock('@app/features/shop/components/previews/ShopMessagePreview', () => ({
	ShopMessagePreview: () => createElement('span', {'data-drawn': 'chat'}),
}));
vi.mock('@app/features/shop/utils/ShopPreviewUser', () => ({
	previewUserForSurface: (_user: User, _surface: string, items: Array<CosmeticItemResponse>) => ({
		id: 'me',
		avatarUltra: items.some((item) => item.type === 'avatar_ultra') ? {item_id: '1'} : null,
	}),
}));
vi.mock('@app/features/cosmetics/state/UltraLayouts', () => ({
	default: {frontFor: vi.fn(() => ({})), layoutFor: vi.fn(() => null)},
}));

const {ShopDetailPreview} = await import('@app/features/shop/components/previews/ShopDetailPreview');
const items: Array<CosmeticItemResponse> = [
	{id: '1', type: 'avatar_ultra', name: 'Wings', asset: 'wings', description: null, availability: 'owned'},
];

describe('ShopDetailPreview scheduling', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.mocked(UltraLayouts.frontFor).mockReturnValue({closed: 'closed', open: ['open'], idle: 'idle'});
		vi.mocked(UltraLayouts.layoutFor).mockReturnValue(null);
		vi.useFakeTimers();
		vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) =>
			window.setTimeout(() => callback(0), 16),
		);
		vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => window.clearTimeout(id));
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});
	const render = () => act(() => root.render(createElement(ShopDetailPreview, {items, user: {id: 'me'} as User})));
	const drawn = () => [...container.querySelectorAll('[data-drawn]')].map((node) => node.getAttribute('data-drawn'));

	it('paints the skeleton before drawing each supported surface', () => {
		render();
		expect(container.textContent).toContain('How it looks on you');
		expect(container.querySelectorAll('[data-surface]')).toHaveLength(3);
		expect(drawn()).toEqual([]);
		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
		act(() => vi.advanceTimersByTime(16));
		expect(drawn()).toEqual([]);
		act(() => vi.advanceTimersByTime(16));
		expect(drawn()).toEqual(['profile']);
		act(() => vi.advanceTimersByTime(32));
		expect(drawn()).toEqual(['profile', 'member_list']);
		act(() => vi.advanceTimersByTime(32));
		expect(drawn()).toEqual(['profile', 'member_list', 'chat']);
		expect(container.querySelector('[aria-busy="true"]')).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('reserves the real front-wing overhang around compact surfaces', () => {
		render();
		const member = container.querySelector<HTMLElement>('[data-surface="member_list"]');
		const chat = container.querySelector<HTMLElement>('[data-surface="chat"]');
		expect(member?.style.getPropertyValue('--preview-overhang-top')).toBe('0.2rem');
		expect(chat?.style.getPropertyValue('--preview-overhang-top')).toBe('0.25rem');
		expect(chat?.style.getPropertyValue('--preview-overhang-bottom')).toBe('0.25rem');
	});

	it('reserves profile header growth using the same decoration bounds as the profile', () => {
		render();
		const profile = container.querySelector<HTMLElement>('[data-surface="profile"]');
		expect(Number.parseFloat(profile?.style.getPropertyValue('--preview-profile-growth') ?? '') * 16).toBeCloseTo(
			80 * ULTRA_BOX_SCALE.profile - 140,
		);
	});

	it('ignores compact admin offsets like the avatar renderer, even with a front asset', () => {
		vi.mocked(UltraLayouts.layoutFor).mockReturnValue({
			compact: {width: 2, height: 4, offset_x: 0, offset_y: -3},
		} as ReturnType<typeof UltraLayouts.layoutFor>);
		render();
		const chat = container.querySelector<HTMLElement>('[data-surface="chat"]');
		expect(chat?.style.getPropertyValue('--preview-overhang-top')).toBe('0.25rem');
		expect(chat?.style.getPropertyValue('--preview-overhang-bottom')).toBe('0.25rem');
	});

	it('cancels pending work when the dialog closes', () => {
		render();
		expect(vi.getTimerCount()).toBe(1);
		act(() => root.unmount());
		expect(vi.getTimerCount()).toBe(0);
	});

	it('cancels work for removed surfaces and resumes for newly supported surfaces', () => {
		render();
		act(() => vi.advanceTimersByTime(32));
		act(() =>
			root.render(
				createElement(ShopDetailPreview, {
					items: [{...items[0], type: 'profile_effect'}],
					user: {id: 'me'} as User,
				}),
			),
		);
		expect(drawn()).toEqual(['profile']);
		expect(container.querySelector('[aria-busy="true"]')).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
		render();
		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
		act(() => vi.advanceTimersByTime(32));
		act(() => vi.advanceTimersByTime(32));
		expect(drawn()).toEqual(['profile', 'member_list', 'chat']);
		expect(vi.getTimerCount()).toBe(0);
	});
});

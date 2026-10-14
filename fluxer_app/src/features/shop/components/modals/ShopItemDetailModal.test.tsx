// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CosmeticType} from '@app/features/cosmetics/state/Cosmetics';
import type {ShopItemEntry} from '@app/features/shop/utils/ShopEntries';
import type {ModalRender} from '@app/features/ui/state/ModalRender';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const account = vi.hoisted(() => ({premium: false}));
const worn = vi.hoisted(() => ({}) as Partial<Record<string, string>>);
const modalCommands = vi.hoisted(() => ({
	push: vi.fn(),
	pop: vi.fn(),
	popAll: vi.fn(),
	modal: (render: () => unknown) => render,
}));

function interpolate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	return descriptor.message.replace(/{(\w+)}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: interpolate}})}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({
	default: {getMessageGroupSpacingValue: () => 16},
}));
vi.mock('@app/features/cosmetics/state/UltraLayouts', () => ({
	default: {layoutFor: () => null, frontFor: () => null},
}));
vi.mock('@app/features/ui/commands/ModalCommands', () => modalCommands);
vi.mock('@app/features/ui/commands/ToastCommands', () => ({createToast: vi.fn()}));
vi.mock('@app/features/app/config/I18nDisplayConstants', () => ({PREMIUM_PRODUCT_NAME: 'sanalyer Plus'}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {
		get currentUser() {
			return {id: 'me', isPremium: () => account.premium, isClaimed: () => true, verified: true};
		},
	},
}));
vi.mock('@app/features/cosmetics/state/Cosmetics', () => ({
	default: {
		getItem: () => null,
		equippedId: (type: string) => worn[type] ?? null,
		equip: vi.fn(),
	},
}));
// The admin sells only the 3 and 12 month packages here.
vi.mock('@app/features/shop/state/ShopCatalog', () => ({
	default: {
		settings: {item_sales_open: true, premium_sales_open: true},
		packageEntries: [
			{kind: 'package', sku: 'premium:3', months: 3},
			{kind: 'package', sku: 'premium:12', months: 12},
		],
	},
}));
vi.mock('@app/features/app/components/dialogs/Modal', () => ({
	Root: ({children, size}: {children: React.ReactNode; size: string}) =>
		createElement('div', {'data-modal-size': size}, children),
	Header: ({title}: {title: string}) => createElement('h1', null, title),
	Content: ({children}: {children: React.ReactNode}) => createElement('div', null, children),
	Footer: ({children}: {children: React.ReactNode}) => createElement('footer', null, children),
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick, disabled}: {children: React.ReactNode; onClick?: () => void; disabled?: boolean}) =>
		createElement('button', {type: 'button', onClick, disabled}, children),
}));
vi.mock('@app/features/premium/components/PremiumHalo', () => ({
	PremiumHalo: ({size, children}: {size: string; children: React.ReactNode}) =>
		createElement('span', {'data-halo': size}, children),
}));
vi.mock('@app/features/shop/components/PurchaseDisabledWrapper', () => ({
	PurchaseDisabledWrapper: ({children}: {children: React.ReactNode}) => children,
}));
// Each surface has its own test; here they only mark where they are drawn.
const marker = (name: string) => () => createElement('span', {'data-preview': name});
vi.mock('@app/features/shop/components/ShopItemStage', () => ({ShopItemStage: marker('profile')}));
vi.mock('@app/features/shop/components/ShopPriceLine', () => ({ShopPriceLine: marker('price')}));
vi.mock('@app/features/shop/components/previews/ShopMessagePreview', () => ({ShopMessagePreview: marker('chat')}));
vi.mock('@app/features/shop/components/previews/ShopMemberRowPreview', () => ({
	ShopMemberRowPreview: marker('member_list'),
}));
vi.mock('@app/features/shop/components/previews/ShopVoiceTilePreview', () => ({
	ShopVoiceTilePreview: marker('voice'),
}));
vi.mock('@app/features/shop/utils/ShopPreviewUser', () => ({
	previewUserFor: () => ({id: 'me'}),
	previewUserForSurface: () => ({id: 'me'}),
}));
// Only the pushed dialog's type is checked; the real buy dialog loads the app runtime.
vi.mock('@app/features/shop/components/modals/ShopCheckoutModal', () => ({ShopCheckoutModal: () => null}));

const {ShopItemDetailModal} = await import('@app/features/shop/components/modals/ShopItemDetailModal');
const {ShopCheckoutModal} = await import('@app/features/shop/components/modals/ShopCheckoutModal');
const {ModalStackContext, UNSTACKED_MODAL_CONTEXT} = await import('@app/features/ui/utils/ModalStackContext');

function entry(type: CosmeticType, availability: CosmeticItemResponse['availability'] = 'owned'): ShopItemEntry {
	const item: CosmeticItemResponse = {
		id: '1300000000000000009',
		type,
		name: 'Yitik Melek',
		description: null,
		asset: 'hash',
		availability,
	};
	const price = {
		base_try_minor: 500,
		campaign_percent: null,
		campaign_ends_at: null,
		sale_try_minor: 500,
		premium_try_minor: 350,
	};
	return {kind: 'item', sku: `cosmetic:${item.id}`, item, price: availability === 'owned' ? price : null};
}

describe('ShopItemDetailModal', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		vi.useFakeTimers();
		account.premium = false;
		for (const key of Object.keys(worn)) delete worn[key];
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.useRealTimers();
	});

	const render = (shopEntry: ShopItemEntry, isTopmost = true) => {
		act(() =>
			root.render(
				createElement(
					ModalStackContext.Provider,
					{value: {...UNSTACKED_MODAL_CONTEXT, isTopmost}},
					createElement(ShopItemDetailModal, {entry: shopEntry}),
				),
			),
		);
		for (let frame = 0; frame < 10 && container.querySelector('[aria-busy="true"]'); frame++) {
			act(() => vi.advanceTimersToNextFrame());
		}
	};
	const surfaces = () =>
		[...container.querySelectorAll('[data-surface]')].map((node) => node.getAttribute('data-surface'));
	const button = (label: string) =>
		[...container.querySelectorAll('button')].find((node) => node.textContent === label) ?? null;

	it('shows only the surfaces the type is drawn on', () => {
		const expected: Array<[CosmeticType, Array<string>, string]> = [
			['avatar_decoration', ['profile', 'member_list', 'chat'], 'large'],
			['avatar_ultra', ['profile', 'member_list', 'chat'], 'large'],
			['profile_effect', ['profile'], 'large'],
			['nameplate', ['member_list'], 'large'],
		];
		for (const [type, drawn, size] of expected) {
			render(entry(type));
			expect(surfaces()).toEqual(drawn);
			expect(
				[...container.querySelectorAll('[data-surface] [data-preview]')].map((node) =>
					node.getAttribute('data-preview'),
				),
			).toEqual(drawn);
			expect(container.querySelector('[data-modal-size]')?.getAttribute('data-modal-size')).toBe(size);
		}
	});

	it('keeps the product, price and purchase together beside the personal preview', () => {
		render(entry('avatar_ultra'));
		const product = container.querySelector('[data-flx="shop.shop-item-detail-modal.product"]');
		expect(product?.querySelector('[data-preview="price"]')).not.toBeNull();
		expect(product?.textContent).toContain('Purchase');
		expect(container.querySelector('[data-flx="shop.shop-detail-preview.panel"]')?.textContent).toContain(
			'How it looks on you',
		);
		expect(container.querySelector('footer [data-preview="price"]')).toBeNull();
	});
	it('glows around Purchase and keeps its checkout target while leaving other actions plain', () => {
		const selected = entry('avatar_ultra');
		render(selected);
		expect(button('Purchase')?.closest('[data-halo]')?.getAttribute('data-halo')).toBe('small');
		expect(button('Close')?.closest('[data-halo]')).toBeNull();
		act(() => button('Purchase')?.click());
		const pushed = (modalCommands.push.mock.calls[0][0] as ModalRender)();
		expect(pushed.type).toBe(ShopCheckoutModal);
		expect(pushed.props).toMatchObject({target: {kind: 'item', sku: selected.sku}});

		const premiumItem = entry('avatar_ultra', 'premium');
		render(premiumItem, false);
		expect(button('Get sanalyer Plus')?.closest('[data-halo]')).toBeNull();
		account.premium = true;
		render({...premiumItem}, false);
		expect(button('Equip')?.closest('[data-halo]')).toBeNull();
		worn.avatar_ultra = selected.item.id;
		render({...premiumItem}, false);
		expect(button('Equipped')?.closest('[data-halo]')).toBeNull();
		expect(container.querySelector('[data-halo]')).toBeNull();
	});

	it('notes that the preview replaces the worn item of the same type', () => {
		const note = 'The preview takes the place of the Ultra decoration you wear.';
		render(entry('avatar_ultra'));
		expect(container.textContent).not.toContain(note);
		worn.avatar_ultra = '1300000000000000001';
		render(entry('avatar_ultra'));
		expect(container.textContent).toContain(note);
		worn.avatar_ultra = '1300000000000000009';
		render(entry('avatar_ultra'));
		expect(container.textContent).not.toContain(note);
	});

	it('Get Premium opens the checkout on the first package on sale, on top, and Okay closes both but keeps settings open', () => {
		const premiumItem = entry('avatar_ultra', 'premium');
		render(premiumItem);
		act(() => button('Get sanalyer Plus')?.click());
		expect(modalCommands.push).toHaveBeenCalledTimes(1);
		const pushed = (modalCommands.push.mock.calls[0][0] as ModalRender)();
		expect(pushed.type).toBe(ShopCheckoutModal);
		expect(pushed.props).toMatchObject({target: {kind: 'premium', months: 3, fromItem: premiumItem.item}});
		// The checkout sits on top; it pays, and its Okay closes itself, which puts this dialog on top again.
		render(premiumItem, false);
		account.premium = true;
		render(premiumItem, true);
		expect(modalCommands.pop).toHaveBeenCalledTimes(1);
		expect(modalCommands.popAll).not.toHaveBeenCalled();
	});

	it('stays open when the checkout closes without a purchase', () => {
		const premiumItem = entry('avatar_ultra', 'premium');
		render(premiumItem);
		act(() => button('Get sanalyer Plus')?.click());
		render(premiumItem, false);
		render(premiumItem, true);
		expect(modalCommands.pop).not.toHaveBeenCalled();
	});
});

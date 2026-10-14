// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import type {ShopItemEntry} from '@app/features/shop/utils/ShopEntries';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {ShopPriceResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import type React from 'react';
import {act, createElement, type ReactElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

function interpolate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	return descriptor.message.replace(/{(\w+)}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

const state = vi.hoisted(() => ({
	owned: new Set<string>(),
	equipped: null as string | null,
	premium: false,
	claimed: true,
	verified: true as boolean | undefined,
	hovering: false,
}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {locale: 'en-US', _: interpolate}}),
	Trans: ({children}: {children: React.ReactNode}) => children,
}));
vi.mock('@app/features/app/config/I18nDisplayConstants', () => ({PREMIUM_PRODUCT_NAME: 'sanalyer Plus'}));
vi.mock('@app/features/user/utils/LocaleUtils', () => ({getCurrentLocale: () => 'en-US'}));
vi.mock('@app/features/user/utils/DateFormatting', () => ({getFormattedDateTime: (value: string) => value}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/shop/state/ShopCatalog', () => ({
	default: {
		settings: {
			premium_sales_open: true,
			item_sales_open: true,
			premium_discount_percent: 30,
			usd_to_azn_rate: '1.7000',
			usd_to_azn_rate_micro: 1700000,
			try_to_azn_rate_micro: null,
		},
		premiumDiscount: false,
		packageEntries: [{kind: 'package', sku: 'premium:1', months: 1}],
		now: () => Date.now(),
	},
}));
vi.mock('@app/features/cosmetics/state/Cosmetics', () => ({
	default: {
		getItem: (id: string | null) => (id && state.owned.has(id) ? {id, owned: true} : null),
		equippedId: (type: string) => (type === 'avatar_ultra' ? state.equipped : null),
		equip: vi.fn(async () => {}),
	},
}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {
		get currentUser() {
			return {
				id: 'me',
				isPremium: () => state.premium,
				isClaimed: () => state.claimed,
				verified: state.verified,
				withUpdates: (updates: object) => ({id: 'me', preview: updates}),
			};
		},
	},
}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({
	modal: (render: () => ReactElement) => render,
	push: vi.fn(),
	pushWithKey: vi.fn(),
}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({createToast: vi.fn()}));
vi.mock('@app/features/app/hooks/useHover', () => ({useHover: () => [() => {}, state.hovering]}));
// Geometry and viewport behavior belong to ShopItemStage tests; cards pass the preview contract.
const stages: Array<{items: ReadonlyArray<CosmeticItemResponse>; size: string; animateNameplate?: boolean}> = [];
vi.mock('@app/features/shop/components/ShopItemStage', () => ({
	ShopItemStage: (props: (typeof stages)[number]) => {
		stages.push(props);
		return createElement('div', {'data-stage': true, 'data-size': props.size});
	},
}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({
	default: ({children}: {children: React.ReactNode}) => children,
}));
vi.mock('@app/features/shop/components/PurchaseDisabledWrapper', () => ({
	PurchaseDisabledWrapper: ({
		disabled,
		tooltipText,
		children,
	}: {
		disabled: boolean;
		tooltipText: string;
		children: React.ReactNode;
	}) => createElement('div', {'data-tooltip': disabled ? tooltipText : undefined}, children),
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({
		children,
		onClick,
		disabled,
		submitting,
		'aria-label': ariaLabel,
		'data-flx': flx,
	}: {
		children: React.ReactNode;
		onClick?: () => void;
		disabled?: boolean;
		submitting?: boolean;
		'aria-label'?: string;
		'data-flx': string;
	}) =>
		createElement(
			'button',
			{type: 'button', onClick, disabled: disabled || submitting, 'aria-label': ariaLabel, 'data-flx': flx},
			children,
		),
}));
// The halo has its own look; here it only shows which buttons glow.
vi.mock('@app/features/premium/components/PremiumHalo', () => ({
	PremiumHalo: ({size, children}: {size: string; children: React.ReactNode}) =>
		createElement('span', {'data-halo': size}, children),
}));
// Only the pushed dialog's type is checked; the real dialogs load the app runtime.
vi.mock('@app/features/shop/components/modals/ShopCheckoutModal', () => ({ShopCheckoutModal: () => null}));
vi.mock('@app/features/shop/components/modals/ShopItemDetailModal', () => ({ShopItemDetailModal: () => null}));

const ModalCommands = await import('@app/features/ui/commands/ModalCommands');
const {default: Cosmetics} = await import('@app/features/cosmetics/state/Cosmetics');
const {ShopCheckoutModal} = await import('@app/features/shop/components/modals/ShopCheckoutModal');
const {ShopItemDetailModal} = await import('@app/features/shop/components/modals/ShopItemDetailModal');
const {ShopItemCard} = await import('@app/features/shop/components/ShopItemCard');

const PRICE: ShopPriceResponse = {
	base_usd_cents: 500,
	campaign_percent: null,
	campaign_ends_at: null,
	sale_usd_cents: 500,
	premium_usd_cents: 350,
};

function entry(availability: CosmeticItemResponse['availability'] = 'owned'): ShopItemEntry {
	return {
		kind: 'item',
		sku: 'cosmetic:11',
		item: {id: '11', type: 'avatar_ultra', name: 'Yitik Melek', description: null, asset: 'hash11', availability},
		price: availability === 'owned' ? PRICE : null,
	};
}

describe('ShopItemCard', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		vi.clearAllMocks();
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		Object.assign(state, {
			owned: new Set(),
			equipped: null,
			premium: false,
			claimed: true,
			verified: true,
			hovering: false,
		});
		stages.length = 0;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = (value: ShopItemEntry) => act(() => root.render(createElement(ShopItemCard, {entry: value})));
	const chip = () => container.querySelector('[data-flx="shop.shop-item-card.chip"]')?.textContent ?? null;
	const action = () => container.querySelector<HTMLButtonElement>('[data-flx^="shop.shop-item-card.button.action"]');
	const pushed = (): ReactElement<{target?: unknown; entry?: unknown}> =>
		(vi.mocked(ModalCommands.push).mock.calls.at(-1)![0] as unknown as () => ReactElement<{target?: unknown}>)();

	it('shows Sende for an owned item with Tak/Takılı', async () => {
		state.owned = new Set(['11']);
		render(entry());
		expect(chip()).toBe('Owned');
		expect(action()?.textContent).toBe('Equip');
		await act(async () => action()?.click());
		expect(Cosmetics.equip).toHaveBeenCalledWith({avatar_ultra: '11'});

		state.equipped = '11';
		render(entry());
		expect(action()?.textContent).toBe('Equipped');
		expect(action()?.disabled).toBe(true);
	});

	it('a worn item counts as owned before the owned list is read again', () => {
		// Paid after its dialog closed: USER_UPDATE already wears it, Cosmetics has not loaded since.
		state.equipped = '11';
		render(entry());
		expect(chip()).toBe('Owned');
		expect(action()?.textContent).toBe('Equipped');
		expect(container.querySelector('[data-flx="shop.shop-price-line.status"]')?.textContent).toBe('Owned');
		expect(container.querySelector('[data-flx="shop.shop-price-line.final"]')).toBeNull();

		// Wearing a premium-included item says nothing about owning it.
		render(entry('premium'));
		expect(chip()).toBe('Included in Plus');
	});

	it("Premium'a dahil chip and Get Premium for a non-premium account", () => {
		render(entry('premium'));
		expect(chip()).toBe('Included in Plus');
		expect(action()?.textContent).toBe('Get sanalyer Plus');
		act(() => action()?.click());
		const opened = pushed();
		expect(opened.type).toBe(ShopCheckoutModal);
		expect(opened.props.target).toEqual({kind: 'premium', months: 1, fromItem: entry('premium').item});
	});

	it('reads Owned and Included in Plus once: the stage chip stays out of the accessible name', () => {
		const chipNode = () => container.querySelector('[data-flx="shop.shop-item-card.chip"]');
		state.owned = new Set(['11']);
		render(entry());
		expect(chipNode()?.getAttribute('aria-hidden')).toBe('true');
		expect(container.querySelector('[data-flx="shop.shop-price-line.status"]')?.textContent).toBe('Owned');

		state.owned = new Set();
		render(entry('premium'));
		expect(chipNode()?.getAttribute('aria-hidden')).toBe('true');
		expect(container.querySelector('[data-flx="shop.shop-price-line.status"]')?.textContent).toBe('Included in Plus');
	});

	it('a premium member wears a premium-included item without buying it', () => {
		state.premium = true;
		render(entry('premium'));
		expect(chip()).toBe('Included in Plus');
		expect(action()?.textContent).toBe('Equip');
	});

	it('Satın al opens the checkout with only the sku', () => {
		render(entry());
		expect(chip()).toBeNull();
		expect(action()?.textContent).toBe('Buy for 8.50 AZN');
		act(() => action()?.click());
		const opened = pushed();
		expect(opened.type).toBe(ShopCheckoutModal);
		expect(opened.props.target).toEqual({kind: 'item', sku: 'cosmetic:11'});
	});

	it('an unverified account gets a disabled Satın al with the reason', () => {
		state.verified = false;
		render(entry());
		expect(action()?.disabled).toBe(true);
		expect(container.querySelector('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Verify your email to buy.');
	});

	it('the card opens the item dialog', () => {
		render(entry());
		act(() => container.querySelector<HTMLButtonElement>('[data-flx="shop.shop-item-card.card-button.open"]')?.click());
		const [render_, key] = vi.mocked(ModalCommands.pushWithKey).mock.calls[0];
		const opened = (render_ as unknown as () => ReactElement<{entry: unknown}>)();
		expect(opened.type).toBe(ShopItemDetailModal);
		expect(opened.props.entry).toEqual(entry());
		expect(key).toBe('shop-item-11');
	});

	it('passes the selected item to the grid stage outside the card button', () => {
		const selected = entry();
		render(selected);
		expect(stages.at(-1)).toMatchObject({items: [selected.item], size: 'grid', animateNameplate: false});
		expect(container.querySelector('[data-stage]')?.closest('button')).toBeNull();
	});

	it("the action button's label names the item", () => {
		render(entry());
		expect(action()?.getAttribute('aria-label')).toBe('Buy Yitik Melek');
		state.owned = new Set(['11']);
		render(entry());
		expect(action()?.getAttribute('aria-label')).toBe('Equip Yitik Melek');
	});

	it('glows around Purchase and Get sanalyer Plus while leaving equip actions plain', () => {
		const halo = () => action()?.closest('[data-halo]')?.getAttribute('data-halo') ?? null;
		render(entry());
		expect(halo()).toBe('small');

		render(entry('premium'));
		expect(action()?.textContent).toBe('Get sanalyer Plus');
		expect(halo()).toBe('small');

		state.premium = true;
		render(entry('premium'));
		expect(action()?.textContent).toBe('Equip');
		expect(halo()).toBeNull();

		state.premium = false;
		state.owned = new Set(['11']);
		state.equipped = '11';
		render(entry());
		expect(action()?.textContent).toBe('Equipped');
		expect(halo()).toBeNull();
	});

	it('an unverified account’s disabled Purchase does not glow', () => {
		state.verified = false;
		render(entry());
		expect(action()?.closest('[data-halo]')).toBeNull();
	});

	it('the price row sits under the name inside the card button', () => {
		render(entry());
		const button = container.querySelector('[data-flx="shop.shop-item-card.card-button.open"]');
		const name = button?.querySelector('[data-flx="shop.shop-item-card.name"]');
		expect(name?.nextElementSibling?.getAttribute('data-flx')).toBe('shop.shop-price-line.price-line');
		expect(container.querySelector('[data-flx="shop.shop-price-line.final"]')?.textContent).toBe('8.50 AZN');
		// The Plus price is in the dialog; the card keeps one price row.
		expect(container.querySelector('[data-flx="shop.shop-price-line.premium"]')).toBeNull();
	});

	// in the grid a nameplate plays only while its card is hovered.
	it("plays a nameplate card's nameplate only while the card is hovered", () => {
		const plate: ShopItemEntry = {
			kind: 'item',
			sku: 'cosmetic:12',
			item: {
				id: '12',
				type: 'nameplate',
				name: 'Kedi plakası',
				description: null,
				asset: 'a_hash12',
				availability: 'owned',
			},
			price: PRICE,
		};
		render(plate);
		expect(stages.at(-1)?.animateNameplate).toBe(false);

		// A new entry object: the card is a memoised observer and skips a render with the same props.
		state.hovering = true;
		render({...plate});
		expect(stages.at(-1)?.animateNameplate).toBe(true);
	});

	it('the action stays in the page, reachable by Tab, while the card is not hovered', async () => {
		const card = () => container.querySelector('[data-flx="shop.shop-item-card.card"]');
		render(entry());
		expect(action()?.textContent).toBe('Buy for 8.50 AZN');
		expect(action()?.getAttribute('tabindex')).toBeNull();
		expect(action()?.closest('[aria-hidden], [inert]')).toBeNull();
		expect(card()?.className).toMatch(/hasAction/);

		// Nothing to do on the card: the price row never gives way to an empty action.
		const {default: ShopCatalog} = await import('@app/features/shop/state/ShopCatalog');
		const settings = ShopCatalog.settings!;
		settings.item_sales_open = false;
		try {
			render({...entry()});
			expect(action()).toBeNull();
			expect(card()?.className).not.toMatch(/hasAction/);
		} finally {
			settings.item_sales_open = true;
		}
	});

	// Discord's shelf: the action takes the price row's place on hover or keyboard focus, and only fades, so it keeps
	// its place in the tab order and its name; without hover (touch) it always shows.
	it('fades the action in on hover and focus, never removes it, and always shows it without hover', () => {
		// A variable, not a literal: Vite rewrites new URL('literal', import.meta.url) into a served asset URL.
		const file = './ShopItemCard.module.css';
		const css = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
		const media = (query: string) => css.split(`@media ${query} {`)[1]?.split('\n}\n')[0] ?? '';
		const rule = (source: string, selector: string) => source.split(`${selector} {`)[1]?.split('}')[0] ?? '';
		const hover = media('(hover: hover) and (pointer: fine)');
		const noHover = media('not ((hover: hover) and (pointer: fine))');
		const base = css.replace(/@media[^{]*\{[\s\S]*?\n\}\n/g, '');

		expect(rule(hover, '\t.action')).toContain('opacity: 0;');
		expect(rule(hover, '\t.action')).toContain('pointer-events: none;');
		expect(rule(hover, '\t.hasAction:is(:hover, :focus-within) .action')).toContain('opacity: 1;');
		expect(rule(hover, '\t.hasAction:is(:hover, :focus-within) .action')).toContain('pointer-events: auto;');
		// Enters with a short rise on a strong ease-out, and leaves faster.
		expect(rule(hover, '\t.action')).toContain('transform: translateY(0.25rem);');
		expect(rule(hover, '\t.hasAction:is(:hover, :focus-within) .action')).toContain('transition-duration: 0.18s;');
		expect(noHover).toContain('.action {');
		expect(noHover).not.toContain('opacity');
		expect(rule(base, '\n.action')).not.toContain('opacity');
		expect(css).not.toMatch(/display: none|visibility: hidden/);
	});

	// The checkout and equipped dialogs draw the same stage with size="grid": they keep its 9:7 box and scale; only the
	// card lets the art grow to what its stage holds.
	it('the art fills the card; the stage keeps its 9:7 box and scale for the dialogs', () => {
		const css = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
		const stageCss = css('./ShopItemStage.module.css');
		expect(stageCss).toMatch(/\n\.stage \{[^}]*aspect-ratio: 9 \/ 7;/);
		expect(stageCss).toContain('calc(var(--stage-scale) * var(--stage-boost, 1))');
		const stage = css('./ShopItemCard.module.css').split("\n.card > [data-size='grid'] {")[1]?.split('}')[0] ?? '';
		expect(stage).toContain('--stage-boost: 2;');
		expect(stage).toContain('position: absolute;');
		expect(stage).toContain('inset: 0 0 auto;');
		expect(stage).toContain('height: 69%;');
		expect(stage).toContain('aspect-ratio: auto;');
	});
});

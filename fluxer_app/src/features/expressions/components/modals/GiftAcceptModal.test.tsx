// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {setupI18n} from '@lingui/core';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const http = vi.hoisted(() => ({get: vi.fn(), post: vi.fn()}));
const TARGET = {instanceKey: 'https://micup.test/api', apiEndpoint: 'https://micup.test/api', apiVersion: 1};
const runtime = vi.hoisted(() => ({selfHosted: true}));
const modalCommands = vi.hoisted(() => ({
	push: vi.fn(),
	pop: vi.fn(),
	pushWithKey: vi.fn(),
	modal: (render: () => unknown) => render,
}));
const toast = vi.hoisted(() => ({success: vi.fn()}));
const cosmetics = vi.hoisted(() => ({load: vi.fn(), getItem: vi.fn()}));
const shopCatalog = vi.hoisted(() => ({status: 'ready', load: vi.fn()}));
const i18n = setupI18n({locale: 'en', messages: {en: {}}});
const Passthrough = ({children}: {children?: ReactNode}) => children;

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n}), Trans: Passthrough}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http}));
vi.mock('@app/features/platform/transport/InstanceHTTP', async (importOriginal) => ({
	...(await importOriginal<typeof import('@app/features/platform/transport/InstanceHTTP')>()),
	instanceRequest: ({method, path}: {method: 'GET' | 'POST'; path: string}) =>
		method === 'GET' ? http.get(path) : http.post(path),
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {getSnapshotOrNull: () => null, isSelfHosted: () => runtime.selfHosted},
}));
vi.mock('@app/features/ui/commands/ModalCommands', () => modalCommands);
vi.mock('@app/features/ui/commands/ToastCommands', () => toast);
vi.mock('@app/features/cosmetics/state/Cosmetics', () => ({default: cosmetics}));
vi.mock('@app/features/shop/state/ShopCatalog', () => ({default: shopCatalog}));
vi.mock('@app/features/user/commands/UserProfileCommands', () => ({clearCurrentUserProfiles: vi.fn()}));
vi.mock('@app/features/app/components/alerts/GenericErrorModal', () => ({GenericErrorModal: () => null}));
vi.mock('@app/features/expressions/components/modals/GiftSendToFriendModal', () => ({
	GiftSendToFriendModal: () => null,
}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/auth/components/modals/ClaimAccountModal', () => ({openClaimAccountModal: vi.fn()}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {currentUser: {isClaimed: () => true}, getCurrentUser: () => null},
}));
vi.mock('@app/features/user/models/User', () => ({User: class {}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getDisplayName: () => 'Sender'}));
vi.mock('@app/features/ui/components/Spinner', () => ({Spinner: () => null}));
vi.mock('@app/features/app/components/dialogs/Modal', () => ({
	Root: Passthrough,
	Header: ({title}: {title: ReactNode}) => <h2 data-flx="expressions.gift-accept-modal-test.header.h2">{title}</h2>,
	Content: Passthrough,
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick, disabled}: {children: ReactNode; onClick?: () => void; disabled?: boolean}) => (
		<button type="button" onClick={onClick} disabled={disabled} data-flx="expressions.gift-accept-modal-test.button">
			{children}
		</button>
	),
}));
// C1 and C3 draw these; here they only have to receive the item.
vi.mock('@app/features/shop/components/ShopItemStage', () => ({
	ShopItemStage: ({items, size}: {items: Array<{id: string}>; size: string}) => (
		<div
			data-stage={items.map((item) => item.id).join(',')}
			data-size={size}
			data-flx="expressions.gift-accept-modal-test.stage"
		/>
	),
}));
vi.mock('@app/features/shop/components/ShopEquippedSuccess', () => ({
	ShopEquippedSuccess: ({result}: {result: {kind: string; item: {name: string}}}) => (
		<p data-equipped={result.kind} data-flx="expressions.gift-accept-modal-test.equipped">
			{result.item.name}
		</p>
	),
}));

const {GiftAcceptModal} = await import('@app/features/expressions/components/modals/GiftAcceptModal');

const WINGS = {
	id: '7',
	type: 'avatar_ultra',
	name: 'Yitik Melek',
	description: null,
	asset: 'a1b2',
	availability: 'owned',
} as const;

describe('GiftAcceptModal', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		runtime.selfHosted = true;
		for (const mock of [http.get, http.post, modalCommands.pop, toast.success, cosmetics.load, shopCatalog.load]) {
			mock.mockReset();
		}
		cosmetics.getItem.mockReset().mockReturnValue(null);
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const open = async (code: string, body: unknown) => {
		http.get.mockResolvedValueOnce({body});
		await act(async () => root.render(createElement(GiftAcceptModal, {code, target: TARGET})));
	};
	const itemCode = (code: string, redeemed = false) => ({
		code,
		redeemed,
		grant: {type: 'cosmetic', item: WINGS},
	});
	const buttons = () => [...container.querySelectorAll('button')].map((button) => button.textContent);
	const click = async (label: string) => {
		const button = [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;
		await act(async () => button.click());
	};

	it('an item code shows the item and Redeem and equip', async () => {
		await open('ItemModal0001', itemCode('ItemModal0001'));

		const stage = container.querySelector('[data-stage]');
		expect(stage?.getAttribute('data-stage')).toBe('7');
		expect(stage?.getAttribute('data-size')).toBe('grid');
		expect(container.textContent).toContain('Yitik Melek');
		expect(container.textContent).toContain('Ultra decoration');
		expect(container.textContent).toContain('This code gives you Yitik Melek.');
		expect(container.textContent).toContain('It is added to your collection and equipped.');
		expect(buttons()).toEqual(['Maybe later', 'Redeem and equip']);
	});

	it('an owned item shows the owned note without a redeem button', async () => {
		cosmetics.getItem.mockImplementation((id: string) => (id === '7' ? {...WINGS, owned: true} : null));

		await open('ItemModal0002', itemCode('ItemModal0002'));

		expect(container.textContent).toContain(
			'You already have this item. The code was not used, so you can give it to someone else.',
		);
		expect(container.textContent).not.toContain('This code gives you');
		expect(buttons()).toEqual(['Close']);
	});

	it('redeeming shows Takıldı and reloads cosmetics', async () => {
		await open('ItemModal0003', itemCode('ItemModal0003'));
		http.post.mockResolvedValueOnce({body: null});

		await click('Redeem and equip');

		expect(http.post).toHaveBeenCalledWith('/gifts/ItemModal0003/redeem');
		const equipped = container.querySelector('[data-equipped]');
		expect(equipped?.getAttribute('data-equipped')).toBe('item');
		expect(equipped?.textContent).toBe('Yitik Melek');
		expect(container.textContent).not.toContain('This gift has already been claimed.');
		expect(cosmetics.load).toHaveBeenCalledTimes(1);
		expect(shopCatalog.load).toHaveBeenCalledWith(true);
		expect(toast.success).not.toHaveBeenCalled();
		expect(modalCommands.pop).not.toHaveBeenCalled();
		expect(buttons()).toEqual(['Okay']);
	});

	it('a used item code says it was claimed', async () => {
		await open('ItemModal0004', itemCode('ItemModal0004', true));

		expect(container.textContent).toContain('Yitik Melek');
		expect(container.textContent).toContain('This gift has already been claimed.');
		expect(buttons()).toEqual(['Close']);
	});

	it('a premium code looks as before', async () => {
		runtime.selfHosted = false;

		await open('PremModal0001', {
			code: 'PremModal0001',
			duration_type: 'months',
			duration_quantity: 1,
			redeemed: false,
			created_by: null,
		});

		expect(http.get).toHaveBeenCalledWith('/gifts/PremModal0001');
		expect(container.querySelector('[data-stage]')).toBeNull();
		expect(buttons()).toEqual(['Maybe later', 'Claim gift']);
	});
});

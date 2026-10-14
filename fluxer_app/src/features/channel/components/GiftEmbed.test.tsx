// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {setupI18n} from '@lingui/core';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const http = vi.hoisted(() => ({get: vi.fn(), post: vi.fn()}));
const target = vi.hoisted(() => ({
	instanceKey: 'https://micup.test/api',
	apiEndpoint: 'https://micup.test/api',
	apiVersion: 1,
}));
const runtime = vi.hoisted(() => ({selfHosted: true}));
const modalCommands = vi.hoisted(() => ({
	push: vi.fn(),
	pop: vi.fn(),
	pushWithKey: vi.fn(),
	modal: (render: () => unknown) => render,
}));
const i18n = setupI18n({locale: 'en', messages: {en: {}}});
const Passthrough = ({children}: {children?: ReactNode}) => children;

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n}), Trans: Passthrough}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http}));
vi.mock('@app/features/app/state/InstanceSnapshotStore', () => ({default: {get: () => null}}));
vi.mock('@app/features/platform/transport/InstanceHTTP', () => ({
	currentInstanceTarget: () => target,
	instanceTargetIdentity: (value: typeof target) => JSON.stringify([value.instanceKey, value.apiVersion]),
	instanceRequest: ({
		method,
		path,
		target: requestTarget,
	}: {
		method: 'GET' | 'POST';
		path: string;
		target: typeof target;
	}) => {
		expect(requestTarget).toEqual(target);
		return method === 'GET' ? http.get(path) : http.post(path);
	},
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {
		isSelfHosted: () => runtime.selfHosted,
		getSnapshotOrNull: () => ({appPublic: {branding: {product_name: 'Micup', premium_product_name: 'Plus'}}}),
	},
}));
vi.mock('@app/features/ui/commands/ModalCommands', () => modalCommands);
vi.mock('@app/features/ui/commands/ToastCommands', () => ({success: vi.fn()}));
vi.mock('@app/features/cosmetics/state/Cosmetics', () => ({default: {load: vi.fn()}}));
vi.mock('@app/features/shop/state/ShopCatalog', () => ({default: {status: 'idle', load: vi.fn()}}));
vi.mock('@app/features/user/commands/UserProfileCommands', () => ({clearCurrentUserProfiles: vi.fn()}));
vi.mock('@app/features/app/components/alerts/GenericErrorModal', () => ({GenericErrorModal: () => null}));
vi.mock('@app/features/expressions/components/modals/GiftSendToFriendModal', () => ({
	GiftSendToFriendModal: () => null,
}));
vi.mock('@app/features/expressions/components/modals/GiftAcceptModal', () => ({GiftAcceptModal: () => null}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/auth/components/modals/ClaimAccountModal', () => ({openClaimAccountModal: vi.fn()}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {currentUser: {isClaimed: () => true}, getCurrentUser: () => null, getUser: () => null},
}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getDisplayName: () => 'Sender'}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick, disabled}: {children: ReactNode; onClick?: () => void; disabled?: boolean}) => (
		<button type="button" onClick={onClick} disabled={disabled} data-flx="channel.gift-embed-test.button">
			{children}
		</button>
	),
}));

const {GiftEmbed} = await import('@app/features/channel/components/GiftEmbed');

const WINGS = {
	id: '7',
	type: 'avatar_ultra',
	name: 'Yitik Melek',
	description: null,
	asset: 'a1b2',
	availability: 'owned',
} as const;

describe('GiftEmbed', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		runtime.selfHosted = true;
		for (const mock of [http.get, http.post, modalCommands.pushWithKey]) mock.mockReset();
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const show = async (code: string, body: unknown) => {
		http.get.mockResolvedValueOnce({body});
		await act(async () => root.render(createElement(GiftEmbed, {code})));
	};
	const itemCode = (code: string, redeemed = false) => ({code, redeemed, grant: {type: 'cosmetic', item: WINGS}});
	const button = () => container.querySelector('button')!;

	it('an item code shows the item, not an unknown gift', async () => {
		await show('ItemEmbed0001', itemCode('ItemEmbed0001'));

		expect(http.get).toHaveBeenCalledWith('/shop/codes/ItemEmbed0001');
		expect(container.textContent).not.toContain('Unknown gift');
		expect(container.textContent).toContain('Yitik Melek');
		expect(container.textContent).toContain('Ultra decoration');
		expect(container.textContent).toContain('Click to claim your gift!');
		expect(button().textContent).toBe('Claim gift');
		expect(button().disabled).toBe(false);
	});

	it('claiming an item code opens the gift dialog instead of redeeming unseen', async () => {
		await show('ItemEmbed0002', itemCode('ItemEmbed0002'));

		await act(async () => button().click());

		expect(modalCommands.pushWithKey).toHaveBeenCalledWith(expect.anything(), 'gift-accept-ItemEmbed0002');
		expect(http.post).not.toHaveBeenCalled();
	});

	it('a used item code says it was redeemed', async () => {
		await show('ItemEmbed0003', itemCode('ItemEmbed0003', true));

		expect(container.textContent).toContain('Yitik Melek');
		expect(container.textContent).toContain('Already redeemed');
		expect(button().textContent).toBe('Gift claimed');
		expect(button().disabled).toBe(true);
	});

	it('a premium code looks and redeems as before', async () => {
		await show('PremEmbed0001', {
			code: 'PremEmbed0001',
			redeemed: false,
			grant: {type: 'premium', duration_type: 'months', duration_quantity: 1},
		});
		http.post.mockResolvedValueOnce({body: null});

		expect(container.textContent).toContain('1 month of Micup Plus');
		expect(container.textContent).not.toContain('Ultra decoration');

		await act(async () => button().click());

		expect(http.post).toHaveBeenCalledWith('/gifts/PremEmbed0001/redeem');
		expect(modalCommands.pushWithKey).not.toHaveBeenCalled();
	});
});

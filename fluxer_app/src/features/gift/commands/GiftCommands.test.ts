// SPDX-License-Identifier: AGPL-3.0-or-later

import {HttpError} from '@app/features/platform/types/EndpointError';
import {setupI18n} from '@lingui/core';
import {beforeEach, describe, expect, it, vi} from 'vitest';

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
const toast = vi.hoisted(() => ({success: vi.fn()}));
const cosmetics = vi.hoisted(() => ({load: vi.fn()}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http}));
vi.mock('@app/features/app/state/InstanceSnapshotStore', () => ({default: {get: () => null}}));
vi.mock('@app/features/platform/transport/InstanceHTTP', () => ({
	currentInstanceTarget: () => target,
	instanceTargetIdentity: (value: typeof target) => JSON.stringify([value.instanceKey, value.apiVersion]),
	instanceRequest: ({method, path}: {method: 'GET' | 'POST'; path: string}) =>
		method === 'GET' ? http.get(path) : http.post(path),
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {isSelfHosted: () => runtime.selfHosted}}));
vi.mock('@app/features/ui/commands/ModalCommands', () => modalCommands);
vi.mock('@app/features/ui/commands/ToastCommands', () => toast);
vi.mock('@app/features/cosmetics/state/Cosmetics', () => ({default: cosmetics}));
vi.mock('@app/features/shop/state/ShopCatalog', () => ({default: {status: 'idle', load: vi.fn()}}));
vi.mock('@app/features/user/commands/UserProfileCommands', () => ({clearCurrentUserProfiles: vi.fn()}));
vi.mock('@app/features/app/components/alerts/GenericErrorModal', () => ({GenericErrorModal: () => null}));
vi.mock('@app/features/expressions/components/modals/GiftAcceptModal', () => ({GiftAcceptModal: () => null}));
vi.mock('@app/features/expressions/components/modals/GiftSendToFriendModal', () => ({
	GiftSendToFriendModal: () => null,
}));
vi.mock('@app/features/user/state/Users', () => ({default: {getCurrentUser: () => null}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));

const GiftCommands = await import('@app/features/gift/commands/GiftCommands');
const {default: Gifts} = await import('@app/features/gift/state/Gifts');

const i18n = setupI18n({locale: 'en', messages: {en: {}}});
const WINGS = {
	id: '7',
	type: 'avatar_ultra',
	name: 'Yitik Melek',
	description: null,
	asset: 'a1b2',
	availability: 'owned',
} as const;

describe('GiftCommands', () => {
	beforeEach(() => {
		runtime.selfHosted = true;
		Gifts.reset();
		for (const mock of [http.get, http.post, modalCommands.push, toast.success, cosmetics.load]) mock.mockReset();
	});

	it('self-hosted fetch reads /shop/codes and returns a cosmetic gift', async () => {
		http.get.mockResolvedValueOnce({
			body: {code: 'ItemCode0001', redeemed: false, grant: {type: 'cosmetic', item: WINGS}},
		});

		await expect(GiftCommands.fetch('https://micup.gg/gift/ItemCode0001')).resolves.toEqual({
			kind: 'cosmetic',
			code: 'ItemCode0001',
			redeemed: false,
			item: WINGS,
		});
		expect(http.get).toHaveBeenCalledTimes(1);
		expect(http.get).toHaveBeenCalledWith('/shop/codes/ItemCode0001');
	});

	it('self-hosted fetch turns a premium code into the premium gift every gift screen reads', async () => {
		http.get.mockResolvedValueOnce({
			body: {
				code: 'PremCode0001',
				redeemed: false,
				grant: {type: 'premium', duration_type: 'months', duration_quantity: 3},
			},
		});

		await GiftCommands.fetchWithCoalescing('PremCode0001');

		expect(http.get).toHaveBeenCalledWith('/shop/codes/PremCode0001');
		expect(Gifts.getGift('PremCode0001', target)?.data).toEqual({
			code: 'PremCode0001',
			redeemed: false,
			duration_type: 'months',
			duration_quantity: 3,
		});
	});

	// The chat embed and the signed-out gift pages read `data` as premium time; an item there would break them.
	it('keeps an item code out of the premium gift data other gift screens read', async () => {
		http.get.mockResolvedValueOnce({
			body: {code: 'ItemCode0002', redeemed: false, grant: {type: 'cosmetic', item: WINGS}},
		});

		await GiftCommands.fetchWithCoalescing('ItemCode0002');

		const state = Gifts.getGift('ItemCode0002', target);
		expect(state?.data).toBeNull();
		expect(state?.item).toEqual({kind: 'cosmetic', code: 'ItemCode0002', redeemed: false, item: WINGS});
	});

	it('hosted fetch still reads /gifts', async () => {
		runtime.selfHosted = false;
		const gift = {
			code: 'PremCode0002',
			duration_type: 'months',
			duration_quantity: 1,
			redeemed: false,
			created_by: null,
		};
		http.get.mockResolvedValueOnce({body: gift});

		await expect(GiftCommands.fetch('PremCode0002')).resolves.toEqual(gift);
		expect(http.get).toHaveBeenCalledTimes(1);
		expect(http.get).toHaveBeenCalledWith('/gifts/PremCode0002');
	});

	it('COSMETIC_ALREADY_OWNED shows the owned message and keeps the code', async () => {
		http.get.mockResolvedValueOnce({
			body: {code: 'ItemCode0003', redeemed: false, grant: {type: 'cosmetic', item: WINGS}},
		});
		await GiftCommands.fetchWithCoalescing('ItemCode0003');
		http.post.mockRejectedValueOnce(
			new HttpError({
				method: 'POST',
				path: '/gifts/ItemCode0003/redeem',
				status: 400,
				body: {code: 'COSMETIC_ALREADY_OWNED'},
			}),
		);

		await expect(GiftCommands.redeem(i18n, 'ItemCode0003')).rejects.toBeInstanceOf(HttpError);

		expect(modalCommands.push).toHaveBeenCalledTimes(1);
		const errorModal = modalCommands.push.mock.calls[0][0]() as {props: {title: string; message: string}};
		expect(errorModal.props.message).toBe(
			'You already have this item. The code was not used, so you can give it to someone else.',
		);
		const state = Gifts.getGift('ItemCode0003', target);
		expect(state?.item?.redeemed).toBe(false);
		expect(state?.invalid).toBeUndefined();
		// The server says the account owns the item, so the client's own list catches up.
		expect(cosmetics.load).toHaveBeenCalledTimes(1);
		expect(toast.success).not.toHaveBeenCalled();
	});
});

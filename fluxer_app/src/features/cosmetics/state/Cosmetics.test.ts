// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {UserPrivate} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/transport/RestTransport', () => ({
	http: {get: vi.fn(), put: vi.fn()},
}));
vi.mock('@app/features/user/commands/UserProfileCommands', () => ({clearCurrentUserProfiles: vi.fn()}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {userId: 'me', currentUserId: 'me'}}));
vi.mock('@app/features/platform/state/AuthSession', () => ({
	default: {currentAccountKey: 'micup-test-account', userId: 'me'},
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'micup.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => -1}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
// USER_UPDATE also reaches these stores; only the Users store matters here.
vi.mock('@app/features/messaging/state/MessagingMessages', () => ({default: {handleUserUpdate: vi.fn()}}));
vi.mock('@app/features/permissions/state/Permission', () => ({default: {handleUserUpdate: vi.fn()}}));
vi.mock('@app/features/search/state/QuickSwitcher', () => ({default: {recomputeIfOpen: vi.fn()}}));
vi.mock('@app/features/guild/state/GuildVerification', () => ({default: {handleUserUpdate: vi.fn()}}));

const {http} = await import('@app/features/platform/transport/RestTransport');
const UserProfileCommands = await import('@app/features/user/commands/UserProfileCommands');
const {default: Users} = await import('@app/features/user/state/Users');
const {handleUserUpdate} = await import('@app/features/user/events/UserUpdate');
const {
	default: Cosmetics,
	isCosmeticLocked,
	mergeCosmeticItems,
} = await import('@app/features/cosmetics/state/Cosmetics');

function item(
	id: string,
	type: CosmeticItemResponse['type'],
	availability: CosmeticItemResponse['availability'],
): CosmeticItemResponse {
	return {id, type, name: `item ${id}`, description: null, asset: `hash${id}`, availability};
}

const FREE_FRAME = item('11', 'avatar_decoration', 'free');
const PREMIUM_FRAME = item('12', 'avatar_decoration', 'premium');
const SHOP_FRAME = item('13', 'avatar_decoration', 'owned');
const FREE_PLATE = item('21', 'nameplate', 'free');
const EFFECT = item('31', 'profile_effect', 'free');
const RETIRED_EFFECT = item('32', 'profile_effect', 'owned');

function me(extra: Partial<UserPrivate> = {}): UserPrivate {
	return {
		id: 'me',
		username: 'ayse',
		discriminator: '0001',
		global_name: null,
		avatar: null,
		avatar_color: null,
		flags: 0,
		email: 'ayse@micup.test',
		...extra,
	} as UserPrivate;
}

function respond(catalog: Array<CosmeticItemResponse>, owned: Array<CosmeticItemResponse>, effectId: string | null) {
	vi.mocked(http.get).mockImplementation(async (url: unknown) => {
		if (url === '/cosmetics/catalog') return {body: catalog} as never;
		return {
			body: {owned, equipped: {avatar_decoration_id: null, profile_effect_id: effectId, nameplate_id: null}},
		} as never;
	});
}

const CONTEXT = {} as GatewayHandlerContext;

describe('mergeCosmeticItems', () => {
	it('lists the catalog first, marks what the account owns and keeps owned items the catalog dropped', () => {
		const items = mergeCosmeticItems([FREE_FRAME, SHOP_FRAME, EFFECT], [SHOP_FRAME, RETIRED_EFFECT]);
		expect(items.map((entry) => [entry.id, entry.owned])).toEqual([
			['11', false],
			['13', true],
			['31', false],
			['32', true],
		]);
	});

	it('leaves out items only an owner can wear until they are owned', () => {
		expect(mergeCosmeticItems([FREE_FRAME, SHOP_FRAME], []).map((entry) => entry.id)).toEqual(['11']);
	});
});

describe('isCosmeticLocked', () => {
	const [free, premium] = mergeCosmeticItems([FREE_FRAME, PREMIUM_FRAME], []);
	const [ownedPremium] = mergeCosmeticItems([PREMIUM_FRAME], [PREMIUM_FRAME]);

	it('locks premium items for accounts without premium', () => {
		expect(isCosmeticLocked(premium!, false)).toBe(true);
		expect(isCosmeticLocked(premium!, true)).toBe(false);
	});

	it('never locks free items or premium items the account owns', () => {
		expect(isCosmeticLocked(free!, false)).toBe(false);
		expect(isCosmeticLocked(ownedPremium!, false)).toBe(false);
	});
});

describe('Cosmetics', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		Users.handleGatewayReady('micup-test-account', me());
	});

	it('loads the whole catalog in one request and merges it with the owned items', async () => {
		respond([FREE_FRAME, PREMIUM_FRAME, FREE_PLATE], [RETIRED_EFFECT], '32');
		await Cosmetics.load();
		expect(http.get).toHaveBeenCalledWith('/cosmetics/catalog');
		expect(http.get).toHaveBeenCalledWith('/users/@me/cosmetics');
		expect(Cosmetics.ready).toBe(true);
		expect(Cosmetics.itemsOfType('avatar_decoration').map((entry) => entry.id)).toEqual(['11', '12']);
		expect(Cosmetics.itemsOfType('profile_effect').map((entry) => entry.id)).toEqual(['32']);
		expect(Cosmetics.equippedId('profile_effect')).toBe('32');
	});

	it('reports a failed load', async () => {
		vi.mocked(http.get).mockRejectedValue(new Error('offline'));
		await Cosmetics.load();
		expect(Cosmetics.failed).toBe(true);
	});

	it('sends only the changed slot and waits for USER_UPDATE instead of trusting the response', async () => {
		vi.mocked(http.put).mockResolvedValue({
			body: {avatar_decoration_id: '11', profile_effect_id: null, nameplate_id: null},
		} as never);
		await Cosmetics.equip({avatar_decoration: '11'});
		expect(http.put).toHaveBeenCalledWith('/users/@me/cosmetics/equipped', {body: {avatar_decoration_id: '11'}});
		expect(Cosmetics.equippedId('avatar_decoration')).toBeNull();

		handleUserUpdate(me({avatar_decoration_data: {asset: 'hash11', item_id: '11'}}), CONTEXT);
		expect(Cosmetics.equippedId('avatar_decoration')).toBe('11');
		expect(UserProfileCommands.clearCurrentUserProfiles).not.toHaveBeenCalled();
	});

	it('wears an ultra decoration in its own slot and reads it back from USER_UPDATE', async () => {
		vi.mocked(http.put).mockResolvedValue({
			body: {avatar_decoration_id: null, avatar_ultra_id: '41', profile_effect_id: null, nameplate_id: null},
		} as never);
		await Cosmetics.equip({avatar_ultra: '41'});
		expect(http.put).toHaveBeenCalledWith('/users/@me/cosmetics/equipped', {body: {avatar_ultra_id: '41'}});
		handleUserUpdate(me({avatar_ultra_data: {asset: 'hash41', item_id: '41'}}), CONTEXT);
		expect(Cosmetics.equippedId('avatar_ultra')).toBe('41');
	});

	it('takes a nameplate off with null and sees it gone once USER_UPDATE arrives', async () => {
		Users.handleGatewayReady('micup-test-account', me({nameplate_data: {asset: 'hash21', item_id: '21'}}));
		vi.mocked(http.put).mockResolvedValue({
			body: {avatar_decoration_id: null, profile_effect_id: null, nameplate_id: null},
		} as never);
		await Cosmetics.equip({nameplate: null});
		expect(http.put).toHaveBeenCalledWith('/users/@me/cosmetics/equipped', {body: {nameplate_id: null}});
		expect(Cosmetics.equippedId('nameplate')).toBe('21');

		handleUserUpdate(me({nameplate_data: null}), CONTEXT);
		expect(Cosmetics.equippedId('nameplate')).toBeNull();
	});

	it('takes the worn profile effect from the response, since no gateway event carries it, and refreshes profiles', async () => {
		respond([EFFECT], [], null);
		await Cosmetics.load();
		vi.mocked(http.put).mockResolvedValue({
			body: {avatar_decoration_id: null, profile_effect_id: '31', nameplate_id: null},
		} as never);
		await Cosmetics.equip({profile_effect: '31'});
		expect(http.put).toHaveBeenCalledWith('/users/@me/cosmetics/equipped', {body: {profile_effect_id: '31'}});
		expect(Cosmetics.equippedId('profile_effect')).toBe('31');
		expect(UserProfileCommands.clearCurrentUserProfiles).toHaveBeenCalledTimes(1);
	});
});

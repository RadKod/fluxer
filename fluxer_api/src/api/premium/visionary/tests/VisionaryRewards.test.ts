// SPDX-License-Identifier: AGPL-3.0-or-later

import type {TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {CosmeticService} from '@app/api/cosmetics/CosmeticService';
import {CosmeticItems} from '@app/api/cosmetics/CosmeticTables';
import {deleteOneOrMany, upsertOne} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {Logger} from '@app/api/Logger';
import {
	getCosmeticRepository,
	getCosmeticService,
	getPremiumLedgerService,
	getVisionaryService,
} from '@app/api/middleware/ServiceSingletons';
import {readUser, setRewardItems, slotRows} from '@app/api/premium/visionary/tests/VisionaryTestUtils';
import {createShopAdmin} from '@app/api/shop/tests/ShopTestUtils';
import {Users} from '@app/api/Tables';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import type {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {PremiumFlags, UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const GONE_MESSAGE = 'Visionary reward item is gone; skipped';

describe('Visionary reward items', () => {
	let harness: ApiTestHarness;
	let admin: TestAccount;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		admin = await createShopAdmin(harness);
		await getVisionaryService().setTotal(3);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	const visionary = () => getVisionaryService();

	async function account(): Promise<UserID> {
		return createUserID(BigInt((await createTestAccount(harness)).userId));
	}

	function owns(userId: UserID, itemId: string): Promise<boolean> {
		return getCosmeticService().isOwned(userId, BigInt(itemId));
	}

	it('delivers and wears the reward items once per number', async () => {
		const [decoration, plate] = await setRewardItems(harness, admin, ['avatar_decoration', 'nameplate']);
		const buyer = await account();
		await visionary().holdForOrder(buyer, 1n);
		const grantOwned = vi.spyOn(CosmeticService.prototype, 'grantOwned');

		expect(await visionary().deliverForOrder(buyer, 1n)).toEqual({slot: 1, outcome: 'granted', overCap: false});

		expect(grantOwned).toHaveBeenCalledTimes(2);
		expect(await owns(buyer, decoration!.id)).toBe(true);
		expect(await owns(buyer, plate!.id)).toBe(true);
		const worn = await readUser(buyer);
		expect([worn.avatarDecorationId, worn.nameplateId]).toEqual([BigInt(decoration!.id), BigInt(plate!.id)]);
		expect(
			(await getCosmeticRepository().listGrants(buyer)).map((grant) => [grant.grant_key, grant.state]).sort(),
		).toEqual(
			[
				[`visionary:1:${decoration!.id}`, 'delivered'],
				[`visionary:1:${plate!.id}`, 'delivered'],
			].sort(),
		);

		expect(await visionary().deliverForOrder(buyer, 1n)).toEqual({
			slot: 1,
			outcome: 'already_granted',
			overCap: false,
		});
		expect(grantOwned).toHaveBeenCalledTimes(2);
	});

	it('a delivery that stopped before its rewards gives them on the next try', async () => {
		const [decoration] = await setRewardItems(harness, admin, ['avatar_decoration']);
		const buyer = await account();
		await visionary().holdForOrder(buyer, 2n);
		vi.spyOn(CosmeticService.prototype, 'deliverOwned').mockRejectedValueOnce(new Error('crashed'));

		await expect(visionary().deliverForOrder(buyer, 2n)).rejects.toThrow('crashed');
		expect(await owns(buyer, decoration!.id)).toBe(false);

		expect(await visionary().deliverForOrder(buyer, 2n)).toMatchObject({slot: 1, outcome: 'already_granted'});
		expect(await owns(buyer, decoration!.id)).toBe(true);
		expect((await readUser(buyer)).avatarDecorationId).toBe(BigInt(decoration!.id));
	});

	it('revoke takes the reward items back and retires the number', async () => {
		const [decoration] = await setRewardItems(harness, admin, ['avatar_decoration']);
		const member = await account();
		expect(await visionary().adminGrant(member)).toEqual({slot: 1, changed: true, rewardCount: 1});
		expect(await owns(member, decoration!.id)).toBe(true);

		expect(await visionary().adminRevoke(member)).toEqual({slot: 1, changed: true, rewardsTakenBack: 1});

		const revoked = await readUser(member);
		expect([revoked.premiumType, revoked.premiumLifetimeSequence, revoked.avatarDecorationId]).toEqual([
			null,
			null,
			null,
		]);
		expect(await owns(member, decoration!.id)).toBe(false);
		expect((await slotRows()).map((row) => [row.slot_index, row.user_id ?? null])).toEqual([
			[1, member],
			[2, null],
			[3, null],
		]);
		expect(await visionary().getStock()).toMatchObject({total: 3, sold: 1, remaining: 2});
		expect(await visionary().adminRevoke(member)).toEqual({slot: null, changed: false, rewardsTakenBack: 0});

		expect(await visionary().adminGrant(member)).toEqual({slot: 2, changed: true, rewardCount: 1});
		const again = await readUser(member);
		expect([again.premiumType, again.premiumLifetimeSequence, again.avatarDecorationId]).toEqual([
			UserPremiumTypes.LIFETIME,
			2,
			BigInt(decoration!.id),
		]);
	});

	it('an admin grant that failed after its account write gives the rewards on the repeat', async () => {
		const [decoration] = await setRewardItems(harness, admin, ['avatar_decoration']);
		const member = await account();
		vi.spyOn(NoopGatewayService.prototype, 'dispatchPresence').mockRejectedValueOnce(new Error('gateway is down'));

		await expect(visionary().adminGrant(member)).rejects.toThrow('gateway is down');
		expect((await readUser(member)).premiumType).toBe(UserPremiumTypes.LIFETIME);
		expect(await owns(member, decoration!.id)).toBe(false);

		expect(await visionary().adminGrant(member)).toEqual({slot: 1, changed: false, rewardCount: 1});
		expect(await owns(member, decoration!.id)).toBe(true);
		expect(await visionary().adminGrant(member)).toEqual({slot: 1, changed: false, rewardCount: 0});
	});

	it('a take-back that failed after its account write takes the rewards back on the repeat', async () => {
		const [decoration] = await setRewardItems(harness, admin, ['avatar_decoration']);
		const member = await account();
		await visionary().adminGrant(member);
		vi.spyOn(NoopGatewayService.prototype, 'dispatchPresence').mockRejectedValueOnce(new Error('gateway is down'));

		await expect(visionary().adminRevoke(member)).rejects.toThrow('gateway is down');
		expect((await readUser(member)).premiumType).toBeNull();
		expect(await owns(member, decoration!.id)).toBe(true);

		expect(await visionary().adminRevoke(member)).toEqual({slot: null, changed: false, rewardsTakenBack: 1});
		expect(await owns(member, decoration!.id)).toBe(false);
		expect((await readUser(member)).avatarDecorationId).toBeNull();
		expect(await visionary().adminRevoke(member)).toEqual({slot: null, changed: false, rewardsTakenBack: 0});
	});

	it('revoke leaves a reward item the account owned before it became a Visionary', async () => {
		const [decoration] = await setRewardItems(harness, admin, ['avatar_decoration']);
		const member = await account();
		await getCosmeticService().adminGrant(member, BigInt(decoration!.id));
		expect(await visionary().adminGrant(member)).toEqual({slot: 1, changed: true, rewardCount: 0});

		expect(await visionary().adminRevoke(member)).toEqual({slot: 1, changed: true, rewardsTakenBack: 0});

		expect(await owns(member, decoration!.id)).toBe(true);
	});

	it('revoke keeps ledger time the account paid for', async () => {
		const member = await account();
		const {paidUntil} = await getPremiumLedgerService().grant({
			userId: member,
			grantKey: 'order-1',
			duration: {unit: 'months', quantity: 1},
			source: 'payriff',
		});
		await visionary().adminGrant(member);
		expect((await readUser(member)).premiumType).toBe(UserPremiumTypes.LIFETIME);

		await visionary().adminRevoke(member);

		const after = await readUser(member);
		expect(after.premiumType).toBe(UserPremiumTypes.SUBSCRIPTION);
		expect(after.premiumLifetimeSequence).toBeNull();
		expect(after.premiumGraceEndsAt).toEqual(paidUntil);
		expect(after.premiumGiftExtensionEndsAt).toEqual(paidUntil);
	});

	it('revoke of a #0000 Visionary marks the tag for reset', async () => {
		const zero = await account();
		const other = await account();
		await visionary().adminGrant(zero);
		await visionary().adminGrant(other);
		// Micup: seed a historical identity directly; current profile writers reject human zero tags.
		await upsertOne(Users.patchByPk({user_id: zero}, {discriminator: Db.set(0)}));

		await visionary().adminRevoke(zero);
		await visionary().adminRevoke(other);

		expect((await readUser(zero)).premiumFlags & PremiumFlags.DISCRIMINATOR).toBe(PremiumFlags.DISCRIMINATOR);
		expect((await readUser(other)).premiumFlags & PremiumFlags.DISCRIMINATOR).toBe(0);
	});

	it('a reward item deleted later is skipped with a warning', async () => {
		const [gone, plate] = await setRewardItems(harness, admin, ['avatar_decoration', 'nameplate']);
		await deleteOneOrMany(CosmeticItems.deleteByPk({item_id: BigInt(gone!.id)}));
		const warn = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'warn');
		Logger.warn({probe: true}, 'probe');
		expect(warn).toHaveBeenCalledWith({probe: true}, 'probe');
		warn.mockClear();
		const member = await account();

		expect(await visionary().adminGrant(member)).toEqual({slot: 1, changed: true, rewardCount: 1});

		expect(await owns(member, plate!.id)).toBe(true);
		expect((await readUser(member)).nameplateId).toBe(BigInt(plate!.id));
		const skipped = (warn.mock.calls as Array<Array<unknown>>).filter(([, message]) => message === GONE_MESSAGE);
		expect(skipped).toEqual([[{slot: 1, itemId: gone!.id}, GONE_MESSAGE]]);
		expect(await visionary().adminRevoke(member)).toEqual({slot: 1, changed: true, rewardsTakenBack: 1});
	});
});

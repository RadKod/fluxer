// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {Logger} from '@app/api/Logger';
import {
	getUserRepository,
	getVisionaryService,
	getVisionarySlotRepository,
} from '@app/api/middleware/ServiceSingletons';
import {lifetimeUser, readUser, slotRows} from '@app/api/premium/visionary/tests/VisionaryTestUtils';
import {StripePremiumService} from '@app/api/stripe/services/StripePremiumService';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import type {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {BaseUserUpdatePropagator} from '@app/api/user/services/BaseUserUpdatePropagator';
import {UserFlags, UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';
import {ShopItemUnavailableError} from '@fluxer/errors/src/domains/payment/ShopItemUnavailableError';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import {ms} from 'itty-time';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const OVER_CAP_MESSAGE = 'Visionary number given above the admin total: the payment arrived after its hold ended';

function range(from: number, to: number): Array<number> {
	return Array.from({length: to - from + 1}, (_, i) => from + i);
}

function byNumber(a: number, b: number): number {
	return a - b;
}

describe('Visionary numbers', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	const visionary = () => getVisionaryService();

	async function accounts(count: number): Promise<Array<UserID>> {
		const ids: Array<UserID> = [];
		for (let i = 0; i < count; i++) {
			ids.push(createUserID(BigInt((await createTestAccount(harness)).userId)));
		}
		return ids;
	}

	function atTime(at: number): void {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(at);
	}

	it('grows the total with empty numbered slots and reports the stock', async () => {
		const {totalBefore, stock} = await visionary().setTotal(3);

		expect(totalBefore).toBe(0);
		expect(stock).toEqual({total: 3, sold: 0, held: 0, remaining: 3, overCapGrants: 0});
		expect(
			(await slotRows()).map((row) => [
				row.slot_index,
				row.user_id ?? null,
				row.version,
				row.order_id ?? null,
				row.held_until ?? null,
			]),
		).toEqual([
			[1, null, 1, null, null],
			[2, null, 1, null, null],
			[3, null, 1, null, null],
		]);
	});

	it('twenty concurrent holds for twenty slots give twenty different numbers', async () => {
		await visionary().setTotal(20);
		const buyer = createUserID(1n);

		const numbers = await Promise.all(range(1, 20).map((i) => visionary().holdForOrder(buyer, BigInt(1000 + i))));

		expect([...numbers].sort(byNumber)).toEqual(range(1, 20));
		const rows = await slotRows();
		expect(new Set(rows.map((row) => row.order_id)).size).toBe(20);
		expect(await visionary().getStock()).toMatchObject({total: 20, held: 20, remaining: 0});
	});

	it('the last slot is held by one of two orders; the other gets SHOP_ITEM_UNAVAILABLE', async () => {
		await visionary().setTotal(1);
		const buyer = createUserID(1n);

		const results = await Promise.allSettled([
			visionary().holdForOrder(buyer, 1n),
			visionary().holdForOrder(buyer, 2n),
		]);

		const held = results.filter((result) => result.status === 'fulfilled');
		const refused = results.filter((result) => result.status === 'rejected');
		expect(held).toEqual([{status: 'fulfilled', value: 1}]);
		expect(refused).toHaveLength(1);
		expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(ShopItemUnavailableError);
		expect(await visionary().getStock()).toMatchObject({total: 1, held: 1, remaining: 0});
	});

	it('twenty concurrent deliveries give twenty different numbers, one owner per slot', async () => {
		await visionary().setTotal(20);
		const buyers = await accounts(20);
		// Half the buyers hold their number first; the other half race each other for the free ones at delivery.
		await Promise.all(
			buyers.map((buyer, i) => (i % 2 === 0 ? visionary().holdForOrder(buyer, BigInt(5000 + i)) : null)),
		);

		const deliveries = await Promise.all(
			buyers.map((buyer, i) => visionary().deliverForOrder(buyer, BigInt(5000 + i))),
		);

		expect(deliveries.every((delivery) => delivery.outcome === 'granted' && !delivery.overCap)).toBe(true);
		expect(deliveries.map((delivery) => delivery.slot!).sort(byNumber)).toEqual(range(1, 20));
		const rows = await slotRows();
		expect(rows).toHaveLength(20);
		expect(new Set(rows.map((row) => row.user_id)).size).toBe(20);
		for (const buyer of buyers) {
			const user = await readUser(buyer);
			expect(user.premiumType).toBe(UserPremiumTypes.LIFETIME);
			expect(rows.find((row) => row.slot_index === user.premiumLifetimeSequence)?.user_id).toBe(buyer);
		}
	});

	it('a payment after the hold ended still gets a number: the next free one, else one above the total, logged and counted', async () => {
		await visionary().setTotal(2);
		const [early, taker, late] = await accounts(3);
		atTime(NOW.getTime());
		expect(await visionary().holdForOrder(early!, 1n)).toBe(1);
		expect(await visionary().holdForOrder(late!, 3n)).toBe(2);
		atTime(NOW.getTime() + ms('20 minutes'));
		expect(await visionary().holdForOrder(taker!, 2n)).toBe(1);

		expect(await visionary().deliverForOrder(early!, 1n)).toEqual({slot: 2, outcome: 'granted', overCap: false});
		expect(await visionary().deliverForOrder(late!, 3n)).toEqual({slot: 3, outcome: 'granted', overCap: true});

		expect((await readUser(late!)).premiumLifetimeSequence).toBe(3);
		expect(await visionary().getStock()).toEqual({total: 3, sold: 2, held: 1, remaining: 0, overCapGrants: 1});
	});

	it('the over-cap warning carries the order and the number and nothing else', async () => {
		const warn = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'warn');
		Logger.warn({probe: true}, 'probe');
		expect(warn).toHaveBeenCalledWith({probe: true}, 'probe');
		warn.mockClear();
		await visionary().setTotal(1);
		const [late, taker] = await accounts(2);
		atTime(NOW.getTime());
		await visionary().holdForOrder(late!, 11n);
		atTime(NOW.getTime() + ms('20 minutes'));
		await visionary().holdForOrder(taker!, 12n);
		await visionary().deliverForOrder(taker!, 12n);

		await visionary().deliverForOrder(late!, 11n);

		const overCap = (warn.mock.calls as Array<Array<unknown>>).filter(([, message]) => message === OVER_CAP_MESSAGE);
		expect(overCap).toEqual([[{orderId: '11', slot: 2}, OVER_CAP_MESSAGE]]);
	});

	it('delivering the same order again gives the same number and writes the user once', async () => {
		await visionary().setTotal(2);
		const [buyer] = await accounts(1);
		await visionary().holdForOrder(buyer!, 21n);
		const dispatch = vi.spyOn(BaseUserUpdatePropagator.prototype, 'dispatchUserUpdate');

		expect(await visionary().deliverForOrder(buyer!, 21n)).toEqual({slot: 1, outcome: 'granted', overCap: false});
		expect(await visionary().deliverForOrder(buyer!, 21n)).toEqual({
			slot: 1,
			outcome: 'already_granted',
			overCap: false,
		});

		expect(dispatch).toHaveBeenCalledTimes(1);
		expect((await readUser(buyer!)).premiumLifetimeSequence).toBe(1);
		expect(await visionary().getStock()).toMatchObject({sold: 1, held: 0, remaining: 1});
	});

	it('an account that already is a Visionary gets no second number', async () => {
		await visionary().setTotal(2);
		const {userId} = await lifetimeUser(harness, {sequence: 7});
		await visionary().holdForOrder(userId, 31n);

		expect(await visionary().deliverForOrder(userId, 31n)).toEqual({
			slot: null,
			outcome: 'already_visionary',
			overCap: false,
		});

		expect((await readUser(userId)).premiumLifetimeSequence).toBe(7);
		expect(await visionary().getStock()).toEqual({total: 2, sold: 0, held: 0, remaining: 2, overCapGrants: 0});
	});

	it('an order whose number was taken before the account became a Visionary another way keeps that other number', async () => {
		await visionary().setTotal(3);
		const [buyer] = await accounts(1);
		await visionary().holdForOrder(buyer!, 81n);
		await visionary().holdForOrder(buyer!, 82n);
		// The first order's delivery stopped after taking its number; the second order was delivered in full meanwhile.
		expect(await visionary().takeSlot(buyer!, {orderId: 81n, allowOverCap: true})).toEqual({slot: 1, overCap: false});
		expect(await visionary().deliverForOrder(buyer!, 82n)).toEqual({slot: 2, outcome: 'granted', overCap: false});
		const dispatch = vi.spyOn(BaseUserUpdatePropagator.prototype, 'dispatchUserUpdate');

		expect(await visionary().deliverForOrder(buyer!, 81n)).toEqual({
			slot: null,
			outcome: 'already_visionary',
			overCap: false,
		});

		expect(dispatch).not.toHaveBeenCalled();
		expect((await readUser(buyer!)).premiumLifetimeSequence).toBe(2);
	});

	it('two orders of one account delivered at once give one number and free the other hold', async () => {
		await visionary().setTotal(3);
		const [buyer] = await accounts(1);
		await visionary().holdForOrder(buyer!, 91n);
		await visionary().holdForOrder(buyer!, 92n);

		const settled = await Promise.allSettled([91n, 92n].map((order) => visionary().deliverForOrder(buyer!, order)));
		const outcomes: Array<string> = [];
		for (const [i, result] of settled.entries()) {
			if (result.status === 'fulfilled') {
				outcomes.push(result.value.outcome);
				continue;
			}
			// The account's premium lock was busy: the shop defers the delivery and tries again.
			expect(result.reason).toBeInstanceOf(ResourceLockedError);
			outcomes.push((await visionary().deliverForOrder(buyer!, BigInt(91 + i))).outcome);
		}

		expect(outcomes.sort()).toEqual(['already_visionary', 'granted']);
		expect((await slotRows()).filter((row) => row.user_id === buyer)).toHaveLength(1);
		expect(await visionary().getStock()).toMatchObject({sold: 1, held: 0, remaining: 2});
	});

	it('a delivery that stopped after taking its number finishes on the next try', async () => {
		await visionary().setTotal(2);
		const [buyer] = await accounts(1);
		await visionary().holdForOrder(buyer!, 95n);
		await visionary().takeSlot(buyer!, {orderId: 95n, allowOverCap: true});

		expect(await visionary().deliverForOrder(buyer!, 95n)).toEqual({slot: 1, outcome: 'granted', overCap: false});

		expect((await readUser(buyer!)).premiumLifetimeSequence).toBe(1);
	});

	it('a delivery tried again after an admin took the Visionary back does not give it back', async () => {
		await visionary().setTotal(2);
		const [buyer] = await accounts(1);
		await visionary().holdForOrder(buyer!, 101n);
		expect(await visionary().deliverForOrder(buyer!, 101n)).toMatchObject({slot: 1, outcome: 'granted'});
		await visionary().adminRevoke(buyer!);

		expect(await visionary().deliverForOrder(buyer!, 101n)).toEqual({slot: 1, outcome: 'revoked', overCap: false});

		const user = await readUser(buyer!);
		expect([user.premiumType, user.premiumLifetimeSequence]).toEqual([null, null]);
		expect((await slotRows()).map((row) => row.user_id ?? null)).toEqual([buyer, null]);
	});

	it('a deleted account gets no number', async () => {
		await visionary().setTotal(1);
		const [buyer] = await accounts(1);
		await visionary().holdForOrder(buyer!, 41n);
		const user = await readUser(buyer!);
		await getUserRepository().patchUpsert(buyer!, {flags: user.flags | UserFlags.DELETED}, user.toRow());

		await expect(visionary().deliverForOrder(buyer!, 41n)).rejects.toBeInstanceOf(UnknownUserError);

		expect((await readUser(buyer!)).premiumType).not.toBe(UserPremiumTypes.LIFETIME);
		expect(await visionary().getStock()).toMatchObject({sold: 0});
	});

	it('releasing a hold frees the number at once', async () => {
		await visionary().setTotal(1);
		const buyer = createUserID(1n);
		expect(await visionary().holdForOrder(buyer, 51n)).toBe(1);
		await expect(visionary().holdForOrder(buyer, 52n)).rejects.toBeInstanceOf(ShopItemUnavailableError);

		await visionary().releaseHold(51n);

		expect(await visionary().holdForOrder(buyer, 52n)).toBe(1);
	});

	it('a slot without a version is never handed out', async () => {
		await getVisionarySlotRepository().expandVisionarySlots(1);
		const buyer = createUserID(1n);

		await expect(visionary().holdForOrder(buyer, 61n)).rejects.toBeInstanceOf(ShopItemUnavailableError);
		expect(await visionary().takeSlot(buyer, {orderId: null, allowOverCap: false})).toBeNull();
		expect(await visionary().getStock()).toMatchObject({total: 1, sold: 0, held: 0, remaining: 0});
	});

	it('grants Visionary with no community configured', async () => {
		const community = vi.spyOn(
			StripePremiumService.prototype as unknown as {addToVisionariesGuild: () => Promise<void>},
			'addToVisionariesGuild',
		);
		await visionary().setTotal(1);
		const [buyer] = await accounts(1);
		await visionary().holdForOrder(buyer!, 71n);

		expect(await visionary().deliverForOrder(buyer!, 71n)).toEqual({slot: 1, outcome: 'granted', overCap: false});

		const user = await readUser(buyer!);
		expect([user.premiumType, user.premiumLifetimeSequence]).toEqual([UserPremiumTypes.LIFETIME, 1]);
		expect(community).not.toHaveBeenCalled();
	});
});

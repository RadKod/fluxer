// SPDX-License-Identifier: AGPL-3.0-or-later

import {AdminCodeGenerationService} from '@app/api/admin/services/AdminCodeGenerationService';
import {createUserID} from '@app/api/BrandedTypes';
import {SYSTEM_USER_ID} from '@app/api/constants/Core';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

const BUYER_ID = createUserID(424242424242424242n);
const BOUGHT_CODE = 'B0ughtC0deB0ughtC0deB0ughtC0deB0';

describe('gift codes by creator', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	afterAll(async () => {
		await harness.shutdown();
	});
	beforeEach(async () => {
		await harness.resetData();
	});

	it('leaves codes the admin issues out of the creator index, so sold keys never pile into one partition', async () => {
		const repository = new UserRepository();

		const codes = await new AdminCodeGenerationService(repository).generateGiftCodes({
			count: 3,
			durationType: 'months',
			durationQuantity: 1,
		});

		expect(await repository.findGiftCodesByCreator(SYSTEM_USER_ID)).toEqual([]);
		for (const code of codes) {
			expect((await repository.findGiftCode(code))?.createdByUserId).toBe(SYSTEM_USER_ID);
		}
	});

	it('still lists a gift a user bought under that user', async () => {
		const repository = new UserRepository();

		await repository.createGiftCode({
			code: BOUGHT_CODE,
			duration_months: null,
			duration_type: 'months',
			duration_quantity: 1,
			created_at: new Date(),
			created_by_user_id: BUYER_ID,
			redeemed_at: null,
			redeemed_by_user_id: null,
			stripe_payment_intent_id: null,
			visionary_sequence_number: null,
			checkout_session_id: null,
			version: 1,
		});

		expect((await repository.findGiftCodesByCreator(BUYER_ID)).map((gift) => gift.code)).toEqual([BOUGHT_CODE]);
	});
});

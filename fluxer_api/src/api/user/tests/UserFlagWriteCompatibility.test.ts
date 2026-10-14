// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {fetchOne, upsertOne} from '@app/api/database/CassandraQueryExecution';
import {EMPTY_USER_ROW, type UserRow} from '@app/api/database/types/UserTypes';
import {getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {Users} from '@app/api/Tables';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {isAccountLimitExempt} from '@app/api/user/AccountLimit';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

// Numeric masks deliberately stand in for the previous application: it knows neither the new constant nor LIMIT_EXEMPT.
const OLD_BITS = (1n << 35n) | (1n << 61n) | (1n << 62n);
const ID = createUserID(1174109840998400001n);

describe('old row → new account write → old flag reader', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		await upsertOne(
			Users.upsertAll({...EMPTY_USER_ROW, user_id: ID, username: 'legacy_flags', flags: OLD_BITS, version: 1}),
		);
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	it.each(['upsert', 'patch', 'compare-and-set', 'update-flags'])(
		'keeps the previous meanings through %s',
		async (write) => {
			const repository = getUserRepository();
			const previous = (await repository.findUnique(ID))!;
			expect(previous.flags & OLD_BITS).toBe(OLD_BITS);
			if (write === 'upsert') await repository.upsert({...previous.toRow(), bio: 'new bio'}, previous.toRow());
			else if (write === 'patch')
				await repository.patchUpsert(ID, {flags: previous.flags, bio: 'new bio'}, previous.toRow());
			else if (write === 'compare-and-set')
				await repository.compareAndSetFlags(previous, previous.flags | UserFlags.REPORT_BANNED);
			else await repository.updateFlags(ID, (flags) => flags | UserFlags.REPORT_BANNED);
			const stored = await fetchOne<Pick<UserRow, 'flags'>>(
				Users.selectCql({columns: ['flags'], where: Users.where.eq('user_id')}),
				{user_id: ID},
			);
			for (const bit of [35n, 61n, 62n]) expect(stored!.flags! & (1n << bit)).toBe(1n << bit);
		},
	);

	it('does not reinterpret the old NOT_SUSPICIOUS bit as a limitation exemption', async () => {
		const previous = (await getUserRepository().findUnique(ID))!;
		expect(isAccountLimitExempt(previous)).toBe(false);
		const updated = await getUserRepository().updateFlags(ID, (flags) => flags | UserFlags.LIMIT_EXEMPT);
		expect(updated!.flags & OLD_BITS).toBe(OLD_BITS);
		expect(isAccountLimitExempt(updated!)).toBe(true);
		// 62fa835a7's writer masks: its reader keeps raw flags; neither mask consumes the new bit 59.
		const oldDeadMask = [52n, 54n, 55n, 56n, 58n].reduce((mask, bit) => mask | (1n << bit), 0n);
		const oldPremiumMask = [37n, 40n, 41n, 42n, 43n, 44n, 45n, 46n].reduce((mask, bit) => mask | (1n << bit), 0n);
		const oldWriterFlags = updated!.toRow().flags! & ~oldDeadMask & ~oldPremiumMask;
		expect(oldWriterFlags & (1n << 59n)).toBe(1n << 59n);
		expect(oldWriterFlags & OLD_BITS).toBe(OLD_BITS);
	});
});

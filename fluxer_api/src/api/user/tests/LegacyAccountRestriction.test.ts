// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {fetchOne, upsertOne} from '@app/api/database/CassandraQueryExecution';
import {EMPTY_USER_ROW, USER_COLUMNS, type UserRow} from '@app/api/database/types/UserTypes';
import {getFollowRepository, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {User} from '@app/api/models/User';
import {Users} from '@app/api/Tables';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {assertAccountNotLimited, isAccountLimited} from '@app/api/user/AccountLimit';
import {mapUserToPrivateResponse} from '@app/api/user/UserMappers';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {AccountLimitedError} from '@fluxer/errors/src/domains/user/AccountLimitedError';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

type LegacyUserRow = UserRow & {suspicious_activity_flags: number; has_verified_phone: boolean};
const ID = createUserID(1174109840998400002n);

function legacyRow(overrides: Partial<LegacyUserRow> = {}): LegacyUserRow {
	return {
		...EMPTY_USER_ROW,
		user_id: ID,
		username: 'legacy_restricted',
		email: 'legacy-restricted@example.com',
		email_verified: true,
		flags: 0n,
		bot: false,
		system: false,
		suspicious_activity_flags: 4,
		has_verified_phone: false,
		version: 1,
		...overrides,
	};
}

describe('legacy persisted account restriction', () => {
	it('blocks an unmet persisted phone restriction and permits a verified phone', () => {
		expect(() => assertAccountNotLimited(new User(legacyRow()))).toThrow(AccountLimitedError);
		expect(() => assertAccountNotLimited(new User(legacyRow({has_verified_phone: true})))).not.toThrow();
	});
	it.each([2, 4, 8, 128, 256])('blocks outstanding persisted requirements %s', (suspiciousFlags) => {
		expect(() => assertAccountNotLimited(new User(legacyRow({suspicious_activity_flags: suspiciousFlags})))).toThrow(
			AccountLimitedError,
		);
	});
	it.each([
		{flags: UserFlags.STAFF},
		{flags: UserFlags.LIMIT_EXEMPT},
		{flags: UserFlags.NOT_SUSPICIOUS},
		{bot: true},
		{system: true},
	])('does not apply an upstream exemption to a legacy restriction: case %#', (overrides) => {
		expect(() => assertAccountNotLimited(new User(legacyRow(overrides)))).toThrow(AccountLimitedError);
	});

	it('preserves upstream limitation and exemption meanings when legacy flags are zero', () => {
		const limited = new User(legacyRow({suspicious_activity_flags: 0, flags: UserFlags.ACCOUNT_LIMITED}));
		expect(isAccountLimited(limited)).toBe(true);
		expect(() => assertAccountNotLimited(limited)).toThrow(AccountLimitedError);
		for (const overrides of [{flags: UserFlags.STAFF}, {flags: UserFlags.LIMIT_EXEMPT}, {bot: true}, {system: true}]) {
			const exempt = new User(
				legacyRow({
					...overrides,
					suspicious_activity_flags: 0,
					flags: UserFlags.ACCOUNT_LIMITED | (overrides.flags ?? 0n),
				}),
			);
			expect(isAccountLimited(exempt)).toBe(false);
			expect(() => assertAccountNotLimited(exempt)).not.toThrow();
		}
		expect(() => assertAccountNotLimited(new User(legacyRow({suspicious_activity_flags: 0})))).not.toThrow();
		expect(() => assertAccountNotLimited(new User({...EMPTY_USER_ROW, user_id: ID}))).not.toThrow();
	});

	it('roundtrips legacy security fields through the real User model and selected columns', () => {
		const stored = new User(legacyRow({has_verified_phone: true})).toRow() as LegacyUserRow;
		expect(stored.suspicious_activity_flags).toBe(4);
		expect(stored.has_verified_phone).toBe(true);
		expect(USER_COLUMNS).toContain('suspicious_activity_flags');
		expect(USER_COLUMNS).toContain('has_verified_phone');
		expect(() => assertAccountNotLimited(new User(stored))).not.toThrow();
	});
});

describe('legacy restriction repository persistence', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		await upsertOne(Users.upsertAll(legacyRow()));
	});
	afterAll(async () => {
		await harness?.shutdown();
	});
	it.each([false, true])('reports the real legacy limitation to the owner with verified phone %s', (verified) => {
		expect(mapUserToPrivateResponse(new User(legacyRow({has_verified_phone: verified}))).account_limited).toBe(
			!verified,
		);
	});

	it.each([false])('denies an authenticated follow write with verified phone %s without mutation', async (verified) => {
		const caller = await createTestAccount(harness);
		const target = await createTestAccount(harness);
		const repository = getUserRepository();
		const user = (await repository.findUnique(createUserID(BigInt(caller.userId))))!;
		await repository.upsert(
			{...user.toRow(), suspicious_activity_flags: 4, has_verified_phone: verified} as LegacyUserRow,
			user.toRow(),
		);
		await createBuilder(harness, caller.token)
			.put(`/users/${target.userId}/follow`)
			.body({})
			.expect(403, 'ACCOUNT_LIMITED')
			.execute();
		expect(await getFollowRepository().getFollow(user.id, createUserID(BigInt(target.userId)))).toBeNull();
		await createBuilder(harness, caller.token).get('/feed/notifications').expect(403, 'ACCOUNT_LIMITED').execute();
		const me = await createBuilder<{account_limited: boolean}>(harness, caller.token)
			.get('/users/@me')
			.expect(200)
			.execute();
		expect(me.account_limited).toBe(true);
		await createBuilder(harness, caller.token).get('/auth/sessions').expect(200).execute();
		await createBuilder(harness, caller.token).post('/auth/logout').expect(204).execute();
		await createBuilder(harness, caller.token).get('/users/@me').expect(401, 'UNAUTHORIZED').execute();
	});

	it.each([
		{path: '/users/@me', method: 'get' as const, status: 200},
		{path: '/auth/sessions', method: 'get' as const, status: 200},
		{path: '/auth/logout', method: 'post' as const, status: 204},
	])('keeps the historical recovery exception $method $path usable', async ({path, method, status}) => {
		const caller = await createTestAccount(harness);
		const repository = getUserRepository();
		const user = (await repository.findUnique(createUserID(BigInt(caller.userId))))!;
		await repository.upsert({...user.toRow(), suspicious_activity_flags: 4}, user.toRow());
		await createBuilder(harness, caller.token)[method](path).expect(status).execute();
	});

	it.each(['upsert', 'patch', 'compare-and-set', 'update-flags'])(
		'keeps a legacy restriction through %s',
		async (write) => {
			const repository = getUserRepository();
			const previous = (await repository.findUnique(ID))!;
			expect(() => assertAccountNotLimited(previous)).toThrow(AccountLimitedError);
			if (write === 'upsert') await repository.upsert({...previous.toRow(), bio: 'new bio'}, previous.toRow());
			else if (write === 'patch') await repository.patchUpsert(ID, {bio: 'new bio'}, previous.toRow());
			else if (write === 'compare-and-set')
				await repository.compareAndSetFlags(previous, previous.flags | UserFlags.REPORT_BANNED);
			else await repository.updateFlags(ID, (flags) => flags | UserFlags.REPORT_BANNED);
			const stored = await fetchOne<LegacyUserRow>(
				Users.selectCql({columns: USER_COLUMNS, where: Users.where.eq('user_id')}),
				{user_id: ID},
			);
			expect(stored!.suspicious_activity_flags).toBe(4);
			expect(stored!.has_verified_phone).toBe(false);
			const reloaded = (await repository.findUnique(ID))!;
			expect(() => assertAccountNotLimited(reloaded)).toThrow(AccountLimitedError);
		},
	);
});

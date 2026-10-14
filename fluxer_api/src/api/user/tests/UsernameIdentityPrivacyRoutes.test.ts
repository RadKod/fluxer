// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {setupTestGuildWithMembers} from '@app/api/guild/tests/GuildTestUtils';
import {getUserCacheService, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {User} from '@app/api/models/User';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {wait} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

describe('private username state HTTP boundaries', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness({search: 'enabled'});
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await harness.shutdown();
	});
	it.each([0n, UserFlags.PROFILE_HIDDEN])(
		'keeps another user and their guild member public while own response carries state (%s)',
		async (flags) => {
			const {owner, members, guild} = await setupTestGuildWithMembers(harness, 1);
			const target = members[0]!;
			const id = createUserID(BigInt(target.userId));
			const stored = await getUserRepository().findUniqueAssert(id);
			const selected = new User({
				...stored.toRow(),
				username_state: 'selected',
				identity_version: 12n,
				flags: stored.flags | flags,
			});
			const findUnique = UserRepository.prototype.findUnique;
			vi.spyOn(UserRepository.prototype, 'findUnique').mockImplementation(function (this: UserRepository, userId) {
				return userId === id ? Promise.resolve(selected) : findUnique.call(this, userId);
			});
			await getUserCacheService().invalidateUserCache(id);
			const own = await createBuilder<Record<string, unknown>>(harness, target.token).get('/users/@me').execute();
			expect(own.username_state).toBe('selected');
			const other = await createBuilder<Record<string, unknown>>(harness, owner.token).get(`/users/${id}`).execute();
			const profile = await createBuilder<Record<string, unknown>>(harness, owner.token)
				.get(`/users/${id}/profile`)
				.execute();
			const member = await createBuilder<{user: Record<string, unknown>}>(harness, owner.token)
				.get(`/guilds/${guild.id}/members/${id}`)
				.execute();
			await createBuilder(harness, '').post(`/test/guilds/${guild.id}/mark-members-indexed`).body({}).execute();
			await wait(50);
			const search = await createBuilder<{members: Array<{user_id: string}>}>(harness, owner.token)
				.post(`/guilds/${guild.id}/members-search`)
				.body({query: target.username})
				.execute();
			expect(search.members.some((result) => result.user_id === id.toString())).toBe(true);
			for (const response of [other, profile, member, search]) {
				const serialized = JSON.stringify(response);
				for (const field of ['username_state', 'changeAvailableAt', 'freeChangeAvailable', 'reselect_reason'])
					expect(serialized).not.toContain(field);
			}
			expect(other.identity_version).toBe('12');
			expect(member.user.identity_version).toBe('12');
		},
	);
});

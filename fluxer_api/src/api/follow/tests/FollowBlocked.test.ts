// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {blockUser, setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {FollowService} from '@app/api/follow/FollowService';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import removeBlockedFollows from '@app/api/worker/tasks/RemoveBlockedFollows';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {UserProfileFullResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const helpers: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

async function counts(harness: ApiTestHarness, account: TestAccount) {
	return createBuilder<UserProfileFullResponse>(harness, account.token)
		.get(`/users/${account.userId}/profile`)
		.execute();
}

describe('follow and block (Review Focus 5)', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	async function pair(): Promise<[TestAccount, TestAccount]> {
		const {owner, members} = await setupTestGuildWithMembers(harness, 1);
		return [owner, members[0]!];
	}

	it('refuses a follow in either direction between a blocker and the blocked account', async () => {
		const [alice, bob] = await pair();
		await blockUser(harness, alice, bob.userId);

		for (const [from, to] of [
			[alice, bob],
			[bob, alice],
		] as const) {
			await createBuilder(harness, from.token)
				.put(`/users/${to.userId}/follow`)
				.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
				.execute();
		}
		expect(await counts(harness, alice)).toMatchObject({follower_count: 0, following_count: 0});
	});

	it('removes the follows both ways when a block is placed later', async () => {
		const [alice, bob] = await pair();
		await createBuilder(harness, alice.token)
			.put(`/users/${bob.userId}/follow`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await createBuilder(harness, bob.token)
			.put(`/users/${alice.userId}/follow`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();

		await blockUser(harness, bob, alice.userId);

		expect(await counts(harness, alice)).toMatchObject({follower_count: 0, following_count: 0});
		expect(await counts(harness, bob)).toMatchObject({follower_count: 0, following_count: 0});
		expect(await createBuilder(harness, bob.token).get(`/users/${bob.userId}/followers`).execute()).toEqual([]);
		expect(await createBuilder(harness, alice.token).get(`/users/${alice.userId}/following`).execute()).toEqual([]);
	});

	it('never fails the block when removing the follows fails, and leaves the removal to a worker job', async () => {
		const [alice, bob] = await pair();
		await createBuilder(harness, alice.token)
			.put(`/users/${bob.userId}/follow`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		const removal = vi
			.spyOn(FollowService.prototype, 'removeFollowsBetween')
			.mockRejectedValueOnce(new Error('store unavailable'));
		const addJob = vi.spyOn(NoopWorkerService.prototype, 'addJob');

		await blockUser(harness, bob, alice.userId);

		expect(addJob).toHaveBeenCalledWith('removeBlockedFollows', {userId: bob.userId, targetId: alice.userId});
		expect(await counts(harness, alice)).toMatchObject({following_count: 1});
		removal.mockRestore();

		await removeBlockedFollows({userId: bob.userId, targetId: alice.userId}, helpers);
		expect(await counts(harness, alice)).toMatchObject({following_count: 0});
		expect(await counts(harness, bob)).toMatchObject({follower_count: 0});
	});

	it('undoes a follow that raced a block', async () => {
		const [alice, bob] = await pair();
		await createBuilder(harness, alice.token)
			.put(`/users/${bob.userId}/follow`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await createBuilder(harness, alice.token)
			.delete(`/users/${bob.userId}/follow`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		// The block lands between the follow's own block check and its write: the check passes, the re-read after the write sees it.
		const original = FollowService.prototype.assertNotBlocked;
		let checks = 0;
		vi.spyOn(FollowService.prototype, 'assertNotBlocked').mockImplementation(async function (
			this: FollowService,
			a,
			b,
		) {
			checks++;
			if (checks === 1) {
				await blockUser(harness, bob, alice.userId);
				return;
			}
			return original.call(this, a, b);
		});

		await createBuilder(harness, alice.token)
			.put(`/users/${bob.userId}/follow`)
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
			.execute();
		expect(await counts(harness, alice)).toMatchObject({following_count: 0});
		expect(await counts(harness, bob)).toMatchObject({follower_count: 0});
		expect(await createBuilder(harness, bob.token).get(`/users/${bob.userId}/followers`).execute()).toEqual([]);
	});

	it('still allows unfollowing and removing a follower after the shared community is gone', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		await createBuilder(harness, alice.token)
			.delete(`/users/${bob.userId}/follow`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await createBuilder(harness, bob.token)
			.delete(`/users/@me/followers/${alice.userId}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
	});
});

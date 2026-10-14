// SPDX-License-Identifier: AGPL-3.0-or-later

import {usernameStartCapacityReady} from '@app/api/worker/tasks/UsernameCapacityMonitor';
import {runUsernameMigrationScan} from '@app/api/worker/tasks/UsernameMigrationTasks';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {afterEach, describe, expect, it, vi} from 'vitest';

function scanHarness(now = 60_000) {
	let state = {epoch: 2, cursor: null as string | null, scanned: 0, found: 0, done_at: null as string | null};
	const config = {
		readUsernameMigrationConfig: async () => ({
			state: 'preparing' as const,
			epoch: 2,
			preparing_at: new Date(0).toISOString(),
			started_at: null,
			forced_at: null,
		}),
		initializeUsernameMigrationScan: async () => state,
		compareAndSetUsernameMigrationScan: vi.fn(async (expected, next) => {
			expect(expected).toEqual(state);
			state = next;
			return true;
		}),
	};
	const users = {scanUsersTokenRangePage: vi.fn().mockResolvedValue({users: [], pageState: null})};
	const kv = {
		acquireLock: vi.fn().mockResolvedValue(true),
		releaseLock: vi.fn().mockResolvedValue(true),
		extendLock: vi.fn().mockResolvedValue(true),
	};
	return {config, users, kv, now: () => now, rowsPerSecond: 2000, readP99LimitMs: 500, getState: () => state};
}

describe('username preparation scanner', () => {
	afterEach(() => vi.useRealTimers());
	it('waits for the durable preparation barrier before reading user rows', async () => {
		const harness = scanHarness(59_999);
		await runUsernameMigrationScan(harness);
		expect(harness.users.scanUsersTokenRangePage).not.toHaveBeenCalled();
	});

	it('uses one worker, token pages of 500, and durable per-page CAS counts excluding bots and deleted accounts', async () => {
		const harness = scanHarness();
		const human = {isBot: false, isSystem: false, flags: 0n, discriminator: 0, toRow: () => ({username_state: null})};
		harness.users.scanUsersTokenRangePage.mockResolvedValue({
			users: [
				human,
				{...human, discriminator: 3},
				{...human, isBot: true},
				{...human, isSystem: true},
				{...human, flags: UserFlags.DELETED},
				{...human, toRow: () => ({username_state: 'selected'})},
			],
			pageState: 'next',
		});
		await runUsernameMigrationScan(harness);
		expect(harness.users.scanUsersTokenRangePage).toHaveBeenCalledTimes(1);
		expect(harness.users.scanUsersTokenRangePage.mock.calls[0]?.[1]).toBe(500);
		expect(harness.getState()).toMatchObject({epoch: 2, scanned: 3, found: 1, done_at: null});
		expect(harness.kv.releaseLock).toHaveBeenCalledTimes(1);
	});

	it('resumes the durable token cursor and cannot checkpoint a stale epoch', async () => {
		const harness = scanHarness();
		harness.config.compareAndSetUsernameMigrationScan.mockResolvedValue(false);
		await expect(runUsernameMigrationScan(harness)).rejects.toThrow('epoch');
		expect(harness.getState().cursor).toBeNull();
		harness.kv.acquireLock.mockResolvedValue(false);
		await runUsernameMigrationScan(harness);
		expect(harness.users.scanUsersTokenRangePage).toHaveBeenCalledTimes(1);
	});
	it('renews the scan lock during slow reads and refuses a checkpoint after losing the lease', async () => {
		vi.useFakeTimers();
		const harness = scanHarness();
		let finish!: (page: {users: []; pageState: null}) => void;
		harness.users.scanUsersTokenRangePage.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		harness.kv.extendLock.mockResolvedValue(false);
		const run = runUsernameMigrationScan(harness);
		await vi.advanceTimersByTimeAsync(10_001);
		finish({users: [], pageState: null});
		await expect(run).rejects.toThrow('lease');
		expect(harness.config.compareAndSetUsernameMigrationScan).not.toHaveBeenCalled();
		expect(harness.kv.releaseLock).toHaveBeenCalledTimes(1);
	});
});

describe('username start capacity', () => {
	it.each([
		[{max_guild_members: 40_000, max_guild_online: 10}, 100],
		[{max_guild_members: 20, max_guild_online: 4_000}, 100],
		[{max_guild_members: 20, max_guild_online: 10}, 80_000],
	])('stays closed at 80 percent of a T6 trigger: %o with %s accounts', (guild, accounts) => {
		expect(usernameStartCapacityReady(accounts, guild)).toBe(false);
		expect(usernameStartCapacityReady(accounts - 1, {max_guild_members: 20, max_guild_online: 10})).toBe(true);
	});
});

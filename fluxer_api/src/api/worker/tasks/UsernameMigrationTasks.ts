// SPDX-License-Identifier: AGPL-3.0-or-later
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {splitTokenRing} from '@app/api/database/TokenRangeScan';
import type {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

interface ScanDependencies {
	config: Pick<
		InstanceConfigRepository,
		'readUsernameMigrationConfig' | 'initializeUsernameMigrationScan' | 'compareAndSetUsernameMigrationScan'
	>;
	users: Pick<UserRepository, 'scanUsersTokenRangePage'>;
	kv: Pick<IKVProvider, 'acquireLock' | 'releaseLock' | 'extendLock'>;
	now?: () => number;
	rowsPerSecond: number;
	readP99LimitMs: number;
}
const ranges = splitTokenRing(64);
export async function runUsernameMigrationScan({
	config,
	users,
	kv,
	now = Date.now,
	rowsPerSecond,
	readP99LimitMs,
}: ScanDependencies): Promise<{done: boolean; delayMs: number}> {
	if (!Number.isFinite(rowsPerSecond) || rowsPerSecond <= 0 || !Number.isFinite(readP99LimitMs) || readP99LimitMs <= 0)
		throw new Error('Invalid username preparation budget');
	const token = randomUUID();
	const lock = 'username:preparation-scan';
	if (!(await kv.acquireLock(lock, token, 30))) return {done: true, delayMs: 0};
	let leaseLost = false;
	let renewal: Promise<void> = Promise.resolve();
	const heartbeat = setInterval(() => {
		renewal = renewal
			.then(async () => {
				if (!(await kv.extendLock(lock, token, 30))) leaseLost = true;
			})
			.catch(() => {
				leaseLost = true;
			});
	}, 10_000);
	try {
		const migration = await config.readUsernameMigrationConfig();
		if (
			migration.state !== 'preparing' ||
			!migration.preparing_at ||
			now() < Date.parse(migration.preparing_at) + 60_000
		)
			return {done: true, delayMs: 0};
		const state = await config.initializeUsernameMigrationScan(migration.epoch);
		if (state.done_at) return {done: true, delayMs: 0};
		const cursor: {range: number; pageState: string | null} = state.cursor
			? JSON.parse(state.cursor)
			: {range: 0, pageState: null};
		if (
			!Number.isInteger(cursor.range) ||
			cursor.range < 0 ||
			cursor.range >= ranges.length ||
			(cursor.pageState !== null && typeof cursor.pageState !== 'string')
		)
			throw new Error('Invalid username scan cursor');
		const started = performance.now();
		const page = await users.scanUsersTokenRangePage(ranges[cursor.range]!, 500, cursor.pageState);
		if (page.users.length > 500) throw new Error('Username scan page exceeds budget');
		const duration = performance.now() - started;
		await renewal;
		if (leaseLost || !(await kv.extendLock(lock, token, 30))) throw new Error('Username scan lease was lost');
		let scanned = 0;
		let found = 0;
		for (const user of page.users) {
			if (user.isBot || user.isSystem || (user.flags & UserFlags.DELETED) !== 0n) continue;
			scanned++;
			if (user.discriminator === 0 && user.toRow().username_state !== 'selected') found++;
		}
		const nextRange = page.pageState === null ? cursor.range + 1 : cursor.range;
		const done = nextRange === ranges.length;
		const next = {
			...state,
			scanned: state.scanned + scanned,
			found: state.found + found,
			cursor: done ? null : JSON.stringify({range: nextRange, pageState: page.pageState}),
			done_at: done ? new Date(now()).toISOString() : null,
		};
		if (!(await config.compareAndSetUsernameMigrationScan(state, next)))
			throw new Error('Username scan epoch or cursor changed');
		// Micup: slow individual reads conservatively halve the page budget; this is not a cluster p99 measurement.
		const effectiveRate = duration > readP99LimitMs ? rowsPerSecond / 2 : rowsPerSecond;
		// Micup: hold the global lease through the row budget so concurrent cron kicks cannot skip the delay.
		await delay(Math.max(0, (500 / effectiveRate) * 1000 - (performance.now() - started)));
		if (leaseLost) throw new Error('Username scan lease was lost');
		return {done, delayMs: 0};
	} finally {
		clearInterval(heartbeat);
		await renewal;
		await kv.releaseLock(lock, token);
	}
}

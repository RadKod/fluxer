// SPDX-License-Identifier: AGPL-3.0-or-later

import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {unreadAck, unreadIncrement} from '@app/api/feed/notification/FeedNotificationService';
import {startDockerContainer} from '@app/api/test/DockerTestContainer';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';
import {KVClient} from '@pkgs/kv_client/src/KVClient';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

// The hash commands the feed inbox's unread state uses: the test double and a real Valkey must agree.
async function hashContract(kv: IKVProvider, key: string, wait: (ms: number) => Promise<void>): Promise<void> {
	expect(await kv.hincrby(key, 'seq', 1)).toBe(1);
	expect(await kv.hincrby(key, 'seq', 1)).toBe(2);
	await kv.pipeline().hset(key, 'ready', '2::0').hset(key, 'acked', '1:5').expire(key, 60).exec();
	expect(await kv.hgetall(key)).toEqual({seq: '2', ready: '2::0', acked: '1:5'});
	expect(await kv.ttl(key)).toBeGreaterThan(0);
	await kv.pipeline().hdel(key, 'ready').exec();
	expect(await kv.hget(key, 'ready')).toBeNull();
	// The last field gone takes the key, and its TTL, with it.
	await kv.hdel(key, 'seq', 'acked');
	expect(await kv.exists(key)).toBe(0);
	// One TTL for the whole hash: every field expires at once, and a new increment starts from 1.
	await kv.pipeline().hset(key, 'acked', '3:9').hset(key, 'ready', '3::0').exec();
	await kv.hincrby(key, 'seq', 3);
	await kv.expire(key, 1);
	await wait(1_100);
	expect(await kv.hgetall(key)).toEqual({});
	expect(await kv.hincrby(key, 'seq', 1)).toBe(1);
	await kv.del(key);
}

// The two scripts that move the unread hash in one step each: the test double mirrors them in TypeScript.
async function unreadScriptContract(kv: IKVProvider, key: string): Promise<void> {
	// The first count makes the hash with its epoch and its day.
	expect(await unreadIncrement(kv, key, 1_000, null)).toBe(1);
	const epoch = Number(await kv.hget(key, 'epoch'));
	expect(epoch).toBeGreaterThan(0);
	expect(await kv.ttl(key)).toBeGreaterThan(23 * 3600);
	// A key whose mark is above the last read's sequence was counted since that read.
	expect(await unreadIncrement(kv, key, 2_000, '1')).toBeNull();
	// A read covers what the session saw, never past the sequence, never back; it drops READY's cache.
	await kv.hset(key, 'ready', '1::1:');
	expect(await unreadAck(kv, key, 5, epoch, 3_000)).toEqual({seq: 1, epoch});
	expect(await kv.hgetall(key)).toEqual({seq: '1', acked: '1:3000', epoch: String(epoch)});
	expect(await unreadAck(kv, key, 0, epoch, 3_000)).toEqual({seq: 1, epoch});
	expect(await unreadIncrement(kv, key, 4_000, null)).toBe(2);
	// A session that saw another epoch saw none of this sequence.
	expect(await unreadAck(kv, key, 2, epoch - 1, 4_000)).toEqual({seq: 1, epoch});
	// An action no later than the read's cursor is read; a key at the read's sequence counts again when it moves after it.
	expect(await unreadIncrement(kv, key, 4_000, null)).toBeNull();
	expect(await unreadIncrement(kv, key, 5_000, '1')).toBe(3);
	// Without the hash a read starts it, under a new epoch, and covers nothing.
	await kv.del(key);
	const started = await unreadAck(kv, key, 9, 0, 6_000);
	expect(started.seq).toBe(0);
	expect(started.epoch).toBeGreaterThan(0);
	expect(await kv.hget(key, 'acked')).toBe('0:6000');
	await kv.del(key);
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (typeof address === 'string' || address === null) {
				reject(new Error('no port'));
				return;
			}
			const port = address.port;
			server.close(() => resolve(port));
		});
	});
}

describe('KV hash contract (2a.9b)', () => {
	it('holds on the test double', async () => {
		let now = Date.now();
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		const mock = new MockKVProvider();
		await hashContract(mock, 'contract:unread', async (ms) => {
			now += ms;
		});
		await unreadScriptContract(mock, 'contract:unread');
		vi.restoreAllMocks();
	});

	const dockerAvailable = spawnSync('docker', ['version'], {stdio: 'ignore'}).status === 0;
	const container = `fluxer-kv-hash-${process.pid.toString(36)}-${Date.now().toString(36)}`;
	describe.skipIf(!dockerAvailable)('on a real Valkey (valkey/valkey:9.1-alpine, as deploy/self-hosting)', () => {
		let kv: KVClient | null = null;
		beforeAll(async () => {
			const port = await freePort();
			startDockerContainer([
				'run',
				'-d',
				'--name',
				container,
				'-p',
				`127.0.0.1:${port}:6379`,
				'valkey/valkey:9.1-alpine',
			]);
			for (let attempt = 0; attempt < 60 && kv === null; attempt++) {
				const client = new KVClient(`redis://127.0.0.1:${port}`);
				if (await client.health().catch(() => false)) {
					kv = client;
				} else {
					client.close();
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
			}
			if (kv === null) throw new Error('Valkey did not start');
		}, 60_000);
		afterAll(() => {
			kv?.close();
			spawnSync('docker', ['rm', '-f', container], {stdio: 'ignore'});
		});
		it('holds on Valkey', async () => {
			await hashContract(kv!, 'contract:unread', (ms) => new Promise((resolve) => setTimeout(resolve, ms)));
			await unreadScriptContract(kv!, 'contract:unread');
		});
	});
});

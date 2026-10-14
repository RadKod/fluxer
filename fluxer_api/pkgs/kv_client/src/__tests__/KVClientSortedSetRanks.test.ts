// SPDX-License-Identifier: AGPL-3.0-or-later

import {KVClient} from '@pkgs/kv_client/src/KVClient';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import Redis, {Cluster} from 'ioredis';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const key = 'micupbot:lb:42';

afterEach(() => vi.restoreAllMocks());

describe.each(['standalone', 'cluster'] as const)('KVClient sorted-set ranks (%s)', (mode) => {
	let client: KVClient;
	const prototype = mode === 'cluster' ? Cluster.prototype : Redis.prototype;

	beforeEach(() => {
		vi.spyOn(prototype, 'connect').mockResolvedValue(undefined);
		client = new KVClient({url: 'redis://127.0.0.1:6379', mode});
	});

	afterEach(() => client.close());

	it('zrevrangeWithScores returns members high to low with numeric scores', async () => {
		const command = vi.spyOn(prototype, 'zrevrange').mockResolvedValue(['high', '120.5', 'low', '-2']);
		expect(await client.zrevrangeWithScores(key, 1, -1)).toEqual([
			{member: 'high', score: 120.5},
			{member: 'low', score: -2},
		]);
		expect(command).toHaveBeenCalledExactlyOnceWith(key, 1, -1, 'WITHSCORES');
	});

	it('zrevrank is null for a missing member', async () => {
		const command = vi.spyOn(prototype, 'zrevrank').mockResolvedValueOnce(null).mockResolvedValueOnce(0);
		expect(await client.zrevrank(key, 'missing')).toBeNull();
		expect(await client.zrevrank(key, 'high')).toBe(0);
		expect(command).toHaveBeenCalledWith(key, 'missing');
	});

	it('zremrangebyrank trims the low end', async () => {
		const command = vi.spyOn(prototype, 'zremrangebyrank').mockResolvedValue(2);
		expect(await client.zremrangebyrank(key, 0, -3)).toBe(2);
		expect(command).toHaveBeenCalledExactlyOnceWith(key, 0, -3);
	});

	it('rejects malformed score pairs', async () => {
		const command = vi.spyOn(prototype, 'zrevrange');
		for (const reply of [['member'], ['member', 'invalid'], ['member', '']]) {
			command.mockResolvedValueOnce(reply);
			await expect(client.zrevrangeWithScores(key, 0, -1)).rejects.toMatchObject({code: 'KV_CLIENT_INVALID_RESPONSE'});
		}
	});
});

describe('MockKVProvider sorted-set ranks', () => {
	let kv: MockKVProvider;
	beforeEach(async () => {
		kv = new MockKVProvider();
		await kv.zadd(key, 10, 'low', 30.5, 'high', 20, 'middle', 20, 'middle-z');
	});

	it('zrevrangeWithScores returns members high to low with numeric scores', async () => {
		expect(await kv.zrevrangeWithScores(key, 0, -1)).toEqual([
			{member: 'high', score: 30.5},
			{member: 'middle-z', score: 20},
			{member: 'middle', score: 20},
			{member: 'low', score: 10},
		]);
		expect(await kv.zrevrangeWithScores(key, -2, -1)).toHaveLength(2);
		expect(await kv.zrevrangeWithScores(key, 0, -5)).toEqual([]);
		expect(await kv.zrevrangeWithScores(key, 2, 1)).toEqual([]);
	});

	it('zrevrank is null for a missing member', async () => {
		expect(await kv.zrevrank(key, 'missing')).toBeNull();
		expect(await kv.zrevrank(key, 'high')).toBe(0);
		expect(await kv.zrevrank(key, 'low')).toBe(3);
	});

	it('zremrangebyrank trims the low end', async () => {
		expect(await kv.zremrangebyrank(key, 0, -5)).toBe(0);
		expect(await kv.zremrangebyrank(key, 0, -3)).toBe(2);
		expect(await kv.zrevrangeWithScores(key, 0, -1)).toEqual([
			{member: 'high', score: 30.5},
			{member: 'middle-z', score: 20},
		]);
		expect(await kv.zremrangebyrank(key, 0, -1)).toBe(2);
		expect(await kv.exists(key)).toBe(0);
	});

	it('rank commands respect expiry and missing keys', async () => {
		await kv.expire(key, 0);
		expect(await kv.zrevrangeWithScores(key, 0, -1)).toEqual([]);
		expect(await kv.zrevrank(key, 'high')).toBeNull();
		expect(await kv.zremrangebyrank(key, 0, -1)).toBe(0);
	});
});

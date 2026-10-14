// SPDX-License-Identifier: AGPL-3.0-or-later

import {KVClient} from '@pkgs/kv_client/src/KVClient';
import {computeHashSlot} from '@pkgs/kv_client/src/KVHashSlots';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const {commands} = vi.hoisted(() => ({
	commands: [] as Array<{name: string; args: Array<string | number>}>,
}));

vi.mock('ioredis', () => {
	class MockCommander {
		length = 0;
		private readonly queued: Array<unknown> = [];

		hset(...args: Array<string>): this {
			return this.queue('hset', args, 1);
		}

		hdel(...args: Array<string>): this {
			return this.queue('hdel', args, args.length - 1);
		}

		expire(...args: Array<string | number>): this {
			return this.queue('expire', args, 1);
		}

		async exec(): Promise<Array<[null, unknown]>> {
			return this.queued.map((reply) => [null, reply]);
		}

		private queue(name: string, args: Array<string | number>, reply: unknown): this {
			commands.push({name, args});
			this.queued.push(reply);
			this.length++;
			return this;
		}
	}

	class MockRedis {
		async hincrby(key: string, field: string, increment: number): Promise<number> {
			commands.push({name: 'hincrby', args: [key, field, increment]});
			return 7;
		}

		pipeline(): MockCommander {
			return new MockCommander();
		}
	}
	return {default: MockRedis, Cluster: MockRedis};
});

// The feed inbox's unread hash: one key, so every command of it lands on one slot of a KV cluster.
describe('KVClient hash counter and pipelined hash writes', () => {
	beforeEach(() => {
		commands.length = 0;
	});

	it('increments a hash field by the given amount and returns the new value', async () => {
		const client = new KVClient('redis://127.0.0.1:6379');

		await expect(client.hincrby('feed:notif:unread:1', 'seq', 1)).resolves.toBe(7);
		expect(commands).toEqual([{name: 'hincrby', args: ['feed:notif:unread:1', 'seq', 1]}]);
	});

	it('pipelines field writes and deletes of one hash on one cluster slot', async () => {
		const client = new KVClient({url: 'redis://127.0.0.1:6379', mode: 'cluster'});

		const results = await client
			.pipeline()
			.hset('feed:notif:unread:1', 'ready', '2::0')
			.hdel('feed:notif:unread:1', 'ready', 'acked')
			.expire('feed:notif:unread:1', 60)
			.exec();

		expect(results).toEqual([
			[null, 1],
			[null, 2],
			[null, 1],
		]);
		expect(commands).toEqual([
			{name: 'hset', args: ['feed:notif:unread:1', 'ready', '2::0']},
			{name: 'hdel', args: ['feed:notif:unread:1', 'ready', 'acked']},
			{name: 'expire', args: ['feed:notif:unread:1', 60]},
		]);
		expect(new Set(commands.map((command) => computeHashSlot(String(command.args[0])))).size).toBe(1);
	});
});

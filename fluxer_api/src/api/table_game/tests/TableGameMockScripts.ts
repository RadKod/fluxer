// SPDX-License-Identifier: AGPL-3.0-or-later

import {registerMockKVScript} from '@app/api/test/mocks/MockKVProvider';

// The mock KV's commands are async; a script body must not interleave with another script, as in Valkey.
let tail: Promise<unknown> = Promise.resolve();
function atomic<T>(body: () => Promise<T>): Promise<T> {
	const run = tail.then(body);
	tail = run.catch(() => {});
	return run;
}

// JS twins of the table game Lua scripts (TableGameRepository), line for line; real Valkey parity runs in CI (KL2).
export function registerTableGameMockScripts(): void {
	registerMockKVScript('tableGameCas', (store, key, [expected, next, json, ttl]) =>
		atomic(async () => {
			const current = await store.hget(key, 'v');
			if (expected === '-1') {
				if (current !== null) return 0;
			} else if (current !== expected) {
				return 0;
			}
			await store.hset(key, 'v', next!);
			await store.hset(key, 's', json!);
			await store.expire(key, Number(ttl));
			return 1;
		}),
	);
	registerMockKVScript('tableGameSpectate', (store, key, [userId, limit, ttl]) =>
		atomic(async () => {
			if ((await store.sismember(key, userId!)) === 1) {
				await store.expire(key, Number(ttl));
				return 1;
			}
			if ((await store.scard(key)) >= Number(limit)) return 0;
			await store.sadd(key, userId!);
			await store.expire(key, Number(ttl));
			return 1;
		}),
	);
	registerMockKVScript('tableGameUnlock', (store, key, [expected]) =>
		atomic(async () => {
			if ((await store.get(key)) !== expected) return 0;
			await store.del(key);
			return 1;
		}),
	);
}

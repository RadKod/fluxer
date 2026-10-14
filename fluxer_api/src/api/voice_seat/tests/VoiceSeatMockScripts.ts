// SPDX-License-Identifier: AGPL-3.0-or-later

import {type MockKVProvider, registerMockKVScript} from '@app/api/test/mocks/MockKVProvider';

// Line-by-line JS twins of the voice seat Lua scripts in VoiceSeatRepository.
// Real Valkey runs the Lua itself in the valkey block of VoiceSeatRepository.test.ts (CI KL2).
// The mock has no hash field TTL: the g: tombstone twin stores its deadline (ms) and counts as present until then.
const tombstoneLive = (value: string | null) => value !== null && Number(value) > Date.now();
// EXISTS: Valkey drops an emptied hash and its expired g: fields; the mock keeps both, so a live field decides.
const hashExists = async (kv: MockKVProvider, k: string) =>
	Object.entries(await kv.hgetall(k)).some(([field, value]) => !field.startsWith('g:') || tombstoneLive(value));

export function registerVoiceSeatMockScripts(): void {
	// Date.now() stands in for the server TIME the Lua reads.
	registerMockKVScript('voiceSeatTake', async (kv: MockKVProvider, k: string, args: Array<string>) => {
		const [id, uid, ttlArg, mode, jv, capArg, windowArg, ...seats] = args as [
			string,
			string,
			string,
			string,
			string,
			string,
			string,
			...Array<string>,
		];
		const ttl = Number(ttlArg);
		const cap = Number(capArg);
		const window = Number(windowArg);
		let now = 0;
		let used = 0;
		if (cap > 0) {
			now = Date.now();
			if (now < Number((await kv.hget(k, 'r:ends')) ?? 0)) used = Number((await kv.hget(k, 'r:count')) ?? 0);
			if (used >= cap) return ['', 'limited', ''];
		}
		const spend = async () => {
			if (cap === 0) return;
			if (used === 0) await kv.hset(k, 'r:ends', String(now + window));
			await kv.hset(k, 'r:count', String(used + 1));
		};
		if (mode === 'join') {
			if (tombstoneLive(await kv.hget(k, `g:${id}`))) return ['', 'gone', ''];
			await kv.hset(k, `j:${id}`, jv);
			await kv.hset(k, `l:${uid}`, id);
		}
		let held = await kv.hget(k, `p:${id}`);
		let dropped = '';
		if (held && mode !== 'explicit' && !/^seat_T\d\d_\d$/.test(held) && !seats.includes(held)) {
			await kv.hdel(k, `s:${held}`, `p:${id}`);
			if ((await kv.hget(k, `u:${uid}`)) === id) await kv.hdel(k, `u:${uid}`);
			held = null;
			dropped = id;
		}
		let other = await kv.hget(k, `u:${uid}`);
		if (other === id) other = null;
		if (mode !== 'explicit') {
			if (held) {
				await kv.expire(k, ttl);
				return [held, 'same', ''];
			}
			if (other) {
				await kv.expire(k, ttl);
				return ['', 'user_elsewhere', ''];
			}
		}
		for (const seat of seats) {
			if (mode !== 'explicit' && /^seat_T\d\d_Y\d$/.test(seat)) continue;
			const owner = await kv.hget(k, `s:${seat}`);
			if (owner === id) {
				await kv.expire(k, ttl);
				return [seat, 'same', ''];
			}
			if (!owner) {
				let freed = '';
				if (held) await kv.hdel(k, `s:${held}`);
				if (other) {
					const otherSeat = await kv.hget(k, `p:${other}`);
					if (otherSeat) await kv.hdel(k, `s:${otherSeat}`);
					await kv.hdel(k, `p:${other}`);
					freed = other;
				}
				await kv.hset(k, `s:${seat}`, id);
				await kv.hset(k, `p:${id}`, seat);
				await kv.hset(k, `u:${uid}`, id);
				await spend();
				await kv.expire(k, ttl);
				return [seat, 'ok', freed];
			}
			if (mode === 'explicit') {
				await kv.expire(k, ttl);
				return ['', 'taken', ''];
			}
		}
		if (dropped !== '') await spend();
		await kv.expire(k, ttl);
		return ['', 'full', dropped];
	});

	registerMockKVScript('voiceSeatRelease', async (kv: MockKVProvider, k: string, args: Array<string>) => {
		const [id, uid, goneArg] = args as [string, string, string];
		const gone = Number(goneArg);
		if ((await kv.hdel(k, `j:${id}`)) === 0 && gone > 0 && (await hashExists(kv, k))) {
			await kv.hset(k, `g:${id}`, String(Date.now() + gone * 1000));
		}
		if ((await kv.hget(k, `l:${uid}`)) === id) await kv.hdel(k, `l:${uid}`);
		const seat = await kv.hget(k, `p:${id}`);
		if (!seat) return ['', ''];
		await kv.hdel(k, `s:${seat}`, `p:${id}`);
		if ((await kv.hget(k, `u:${uid}`)) === id) await kv.hdel(k, `u:${uid}`);
		const heir = await kv.hget(k, `l:${uid}`);
		if (heir && (await kv.hget(k, `j:${heir}`)) !== null && !(await kv.hget(k, `p:${heir}`))) {
			await kv.hset(k, `s:${seat}`, heir);
			await kv.hset(k, `p:${heir}`, seat);
			await kv.hset(k, `u:${uid}`, heir);
			return [seat, heir];
		}
		return [seat, ''];
	});

	// Same accepted race as the Lua: a leave between the gateway read and this write gets its j: written back.
	registerMockKVScript('voiceSeatMark', async (kv: MockKVProvider, k: string, args: Array<string>) => {
		const [ttlArg, ...pairs] = args as [string, ...Array<string>];
		let written = 0;
		for (let i = 0; i < pairs.length; i += 2) {
			if (tombstoneLive(await kv.hget(k, `g:${pairs[i]}`))) continue;
			if ((await kv.hget(k, `j:${pairs[i]}`)) === null) written += await kv.hset(k, `j:${pairs[i]}`, pairs[i + 1]!);
		}
		await kv.expire(k, Number(ttlArg));
		return written;
	});

	registerMockKVScript('voiceSeatHolders', async (kv: MockKVProvider, k: string, seats: Array<string>) =>
		Promise.all(seats.map((seat) => kv.hget(k, `s:${seat}`))),
	);

	registerMockKVScript('voiceSeatVacate', async (kv: MockKVProvider, k: string, args: Array<string>) => {
		const [id, uid, ttlArg] = args as [string, string, string];
		const seat = await kv.hget(k, `p:${id}`);
		if (!seat) return '';
		await kv.hdel(k, `s:${seat}`, `p:${id}`);
		if ((await kv.hget(k, `u:${uid}`)) === id) await kv.hdel(k, `u:${uid}`);
		await kv.expire(k, Number(ttlArg));
		return seat;
	});
}

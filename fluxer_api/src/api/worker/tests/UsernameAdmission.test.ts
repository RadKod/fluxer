// SPDX-License-Identifier: AGPL-3.0-or-later

import {USERNAME_ADMISSION_SCRIPT, UsernameAdmission} from '@app/api/worker/tasks/UsernameAdmission';
import {describe, expect, it, vi} from 'vitest';

describe('username admission leases', () => {
	it('refills a spent ten-token lease while the shared global budget still has capacity', async () => {
		let reserved = 0;
		const evalScript = vi.fn(async () => {
			const grant = Math.min(10, 25 - reserved);
			reserved += grant;
			return [grant, 100, 500];
		});
		const admission = new UsernameAdmission({evalScript}, () => 0);
		const outcomes = await Promise.all(
			Array.from({length: 40}, () =>
				admission.admit({policyRevision: 1, admission: {globalPerSecond: 25, paused: false}}),
			),
		);
		expect(outcomes.filter(Boolean)).toHaveLength(25);
		expect(evalScript).toHaveBeenCalledTimes(3);
	});
	it('uses one server-time script and consumes partial leases without another network call', async () => {
		let now = 0;
		const evalScript = vi.fn().mockResolvedValue([3, 100, 500]);
		const admission = new UsernameAdmission({evalScript, isClustered: () => false}, () => now);
		const snapshot = {policyRevision: 4, admission: {globalPerSecond: 3, paused: false}};
		expect(await admission.admit(snapshot)).toBe(true);
		expect(await admission.admit(snapshot)).toBe(true);
		expect(await admission.admit(snapshot)).toBe(true);
		expect(await admission.admit(snapshot)).toBe(false);
		expect(evalScript).toHaveBeenCalledTimes(1);
		expect(evalScript.mock.calls[0]?.[1]).toBe(USERNAME_ADMISSION_SCRIPT);
		expect(USERNAME_ADMISSION_SCRIPT).toContain("redis.call('TIME')");
		expect(USERNAME_ADMISSION_SCRIPT).toContain('math.min(10, remaining)');
		now = 501;
		expect(await admission.admit(snapshot)).toBe(true);
		expect(evalScript).toHaveBeenCalledTimes(2);
	});

	it('drops old leases when revision or budget changes and shares the cumulative server counter', async () => {
		let reserved = 0;
		const evalScript = vi.fn(async (_command, _script, _keys, _routing, _revision, budget) => {
			const grant = Math.min(10, Math.max(0, Number(budget) - reserved));
			reserved += grant;
			return [grant, 100, 500];
		});
		const kv = {evalScript, isClustered: () => false};
		const first = new UsernameAdmission(kv, () => 0);
		const restarted = new UsernameAdmission(kv, () => 0);
		expect(await first.admit({policyRevision: 1, admission: {globalPerSecond: 20, paused: false}})).toBe(true);
		expect(await restarted.admit({policyRevision: 2, admission: {globalPerSecond: 15, paused: false}})).toBe(true);
		expect(reserved).toBe(15);
		expect(await first.admit({policyRevision: 2, admission: {globalPerSecond: 15, paused: false}})).toBe(false);
		expect(reserved).toBe(15);
	});

	it('fails closed for unavailable, malformed, paused and clustered Valkey', async () => {
		const snapshot = {policyRevision: 1, admission: {globalPerSecond: 100, paused: false}};
		expect(await new UsernameAdmission({}, () => 0).admit(snapshot)).toBe(false);
		for (const reply of [[11, 1, 1000], [1, 1, 1001], [1, 'bad', 500], null]) {
			expect(await new UsernameAdmission({evalScript: async () => reply}, () => 0).admit(snapshot)).toBe(false);
		}
		const evalScript = vi.fn().mockRejectedValue(new Error('Valkey down'));
		expect(await new UsernameAdmission({evalScript}, () => 0).admit(snapshot)).toBe(false);
		expect(await new UsernameAdmission({evalScript, isClustered: () => true}, () => 0).admit(snapshot)).toBe(false);
		expect(
			await new UsernameAdmission({evalScript}, () => 0).admit({
				...snapshot,
				admission: {...snapshot.admission, paused: true},
			}),
		).toBe(false);
	});

	it('serializes concurrent calls and expires tokens before delayed replies can cross a server second', async () => {
		let now = 0;
		const evalScript = vi.fn(async () => {
			now += 600;
			return [10, 100, 500];
		});
		const admission = new UsernameAdmission({evalScript}, () => now);
		expect(await admission.admit({policyRevision: 1, admission: {globalPerSecond: 10, paused: false}})).toBe(false);
		const fast = vi.fn().mockResolvedValue([10, 101, 500]);
		const concurrent = new UsernameAdmission({evalScript: fast}, () => 0);
		const outcomes = await Promise.all(
			Array.from({length: 50}, () =>
				concurrent.admit({policyRevision: 1, admission: {globalPerSecond: 10, paused: false}}),
			),
		);
		expect(outcomes.filter(Boolean)).toHaveLength(10);
		expect(fast).toHaveBeenCalledTimes(1);
	});
});

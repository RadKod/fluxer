// SPDX-License-Identifier: AGPL-3.0-or-later

import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {InstanceConfigRepository, type ReferralTierConfig} from '@app/api/instance/InstanceConfigRepository';
import {InstanceConfigWriteRaceExecutor} from '@app/api/instance/tests/InstanceConfigWriteRaceExecutor';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const REFERRAL_CONFIG_KEY = 'referral_config';
const TIER: ReferralTierConfig = {
	id: '1490000000000000001',
	threshold: 5,
	reward: {type: 'premium_days', days: 30},
	enabled: true,
	created_at: '2026-10-01T00:00:00.000Z',
};

describe('referral config', () => {
	const pods: Array<InstanceConfigRepository> = [];
	let executor: InstanceConfigWriteRaceExecutor;

	beforeEach(() => {
		executor = new InstanceConfigWriteRaceExecutor(new InMemoryCassandraQueryExecutor());
		setCassandraQueryExecutorForTesting(executor);
	});

	afterEach(() => {
		for (const pod of pods) pod.shutdown();
		pods.length = 0;
	});

	function createPod(): InstanceConfigRepository {
		const pod = new InstanceConfigRepository(new MockKVProvider());
		pods.push(pod);
		return pod;
	}

	it('defaults: enabled false, 3 days, cap 50, ip limit 3, no tiers', async () => {
		const expected = {enabled: false, min_active_days: 3, daily_valid_cap: 50, ip_registration_limit: 3, tiers: []};
		expect(await createPod().getReferralConfig()).toEqual(expected);
		expect(await createPod().readStoredReferralConfig()).toEqual(expected);
	});

	it('salvages a broken stored value', async () => {
		const pod = createPod();
		await pod.setConfig(
			REFERRAL_CONFIG_KEY,
			JSON.stringify({enabled: true, min_active_days: 'x', daily_valid_cap: 20, tiers: [TIER]}),
		);

		expect(await pod.getReferralConfig()).toEqual({
			enabled: true,
			min_active_days: 3,
			daily_valid_cap: 20,
			ip_registration_limit: 3,
			tiers: [TIER],
		});
	});

	it('update is CAS like shop', async () => {
		const first = createPod();
		const second = createPod();
		await first.getReferralConfig();
		await second.getReferralConfig();
		executor.watch(REFERRAL_CONFIG_KEY);
		executor.pauseWritesUntil(2);

		await Promise.all([
			first.updateReferralConfig(() => ({enabled: true})),
			second.updateReferralConfig((current) => ({tiers: [...current.tiers, TIER]})),
		]);

		expect(executor.events.filter((event) => event === 'write rejected')).toHaveLength(1);
		expect(executor.events.filter((event) => event === 'write')).toHaveLength(2);
		const stored = JSON.parse((await executor.readDirectly(REFERRAL_CONFIG_KEY))!) as Record<string, unknown>;
		expect(stored).toMatchObject({enabled: true, tiers: [TIER]});
		expect(await first.readStoredReferralConfig()).toMatchObject({enabled: true, tiers: [TIER]});
	});

	it('refuses more than 50 tiers', async () => {
		const tiers = Array.from({length: 51}, (_, index) => ({...TIER, id: String(1490000000000000001n + BigInt(index))}));
		await expect(createPod().updateReferralConfig(() => ({tiers}))).rejects.toThrow();
	});
});

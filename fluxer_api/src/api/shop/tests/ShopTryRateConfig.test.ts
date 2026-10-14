// SPDX-License-Identifier: AGPL-3.0-or-later

import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {InstanceConfigWriteRaceExecutor} from '@app/api/instance/tests/InstanceConfigWriteRaceExecutor';
import {planShopTryRateUpdate} from '@app/api/shop/ShopTryRate';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import {afterEach, describe, expect, it} from 'vitest';

describe('shop rate LWT writes', () => {
	const pods: Array<InstanceConfigRepository> = [];
	afterEach(async () => {
		await Promise.all(pods.map((pod) => pod.shutdown()));
		pods.length = 0;
	});
	it.each([false, true])('preserves concurrent admin settings and a newer bulletin (newer=%s)', async (newer) => {
		const executor = new InstanceConfigWriteRaceExecutor(new InMemoryCassandraQueryExecutor());
		setCassandraQueryExecutorForTesting(executor);
		const repository = new InstanceConfigRepository(new MockKVProvider());
		pods.push(repository);
		await repository.updateShopConfig(() => ({try_to_azn_rate_micro: 40_000, try_rate_date: '2026-10-01'}));
		executor.watch('shop_config');
		let competed = false;
		executor.competeBeforeEachWrite(async () => {
			if (competed) return;
			competed = true;
			const current = JSON.parse((await executor.readDirectly('shop_config'))!);
			await executor.writeDirectly(
				'shop_config',
				JSON.stringify({
					...current,
					item_sales_open: true,
					try_to_azn_rate_override_micro: 45_000,
					...(newer ? {try_rate_date: '2026-10-03', try_to_azn_rate_micro: 42_000} : {}),
				}),
			);
		});
		await repository.updateShopConfig((current) =>
			planShopTryRateUpdate(current, {rateMicro: 41_000, date: '2026-10-02'}, new Date('2026-10-05T12:00:00Z')),
		);
		expect(executor.events).toContain('write rejected');
		expect(await repository.readStoredShopConfig()).toMatchObject({
			item_sales_open: true,
			try_to_azn_rate_override_micro: 45_000,
			try_to_azn_rate_micro: newer ? 42_000 : 41_000,
			try_rate_date: newer ? '2026-10-03' : '2026-10-02',
		});
	});
});

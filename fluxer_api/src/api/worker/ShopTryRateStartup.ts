// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ShopConfig} from '@app/api/instance/InstanceConfigRepository';
import {Logger} from '@app/api/Logger';
import type {WorkerService} from '@app/api/worker/WorkerService';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

const INITIAL_SYNC_KEY = 'sync:shop_try_rate:initialized';

export async function queueShopTryRateStartupJob(
	kv: Pick<IKVProvider, 'setnx' | 'del'>,
	worker: Pick<WorkerService, 'addJob'>,
	getConfig: () => Promise<Partial<ShopConfig>>,
): Promise<void> {
	let claimed = false;
	try {
		const config = await getConfig();
		if (config.try_to_azn_rate_micro != null) return;
		claimed = await kv.setnx(INITIAL_SYNC_KEY, '1', 21_600);
		if (!claimed) return;
		await worker.addJob('syncShopTryRate', {});
	} catch (error) {
		Logger.warn({error}, 'Could not enqueue the initial shop TRY rate sync');
		if (claimed) await kv.del(INITIAL_SYNC_KEY);
	}
}

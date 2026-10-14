// SPDX-License-Identifier: AGPL-3.0-or-later

import {getBakuDate, parseCbarTryRate, planShopTryRateUpdate} from '@app/api/shop/ShopTryRate';
import {EXTERNAL_RESPONSE_LIMITS} from '@app/api/utils/ExternalResponseLimits';
import * as FetchUtils from '@app/api/utils/FetchUtils';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';

const syncShopTryRate: WorkerTaskHandler = async (_payload, helpers) => {
	try {
		const now = new Date();
		const date = getBakuDate(now).split('-').reverse().join('.');
		const url = `https://www.cbar.az/currencies/${date}.xml`;
		const response = await fetch(url, {signal: AbortSignal.timeout(15_000), redirect: 'error'});
		if (!response.ok) {
			FetchUtils.discardResponseBody(response.body, response.status);
			throw new Error(`CBAR HTTP ${response.status}`);
		}
		const xml = await FetchUtils.streamToStringWithLimit(response.body, {
			maxBytes: EXTERNAL_RESPONSE_LIMITS.cbarRateBytes,
			headers: response.headers,
			url,
			description: 'CBAR currency bulletin',
		});
		const bulletin = parseCbarTryRate(xml);
		const {instanceConfigRepository} = getWorkerDependencies();
		await instanceConfigRepository.updateShopConfig((current) => planShopTryRateUpdate(current, bulletin, now));
	} catch (error) {
		// The previous rate remains available until its bulletin is stale. A feed outage must not cause 25 redeliveries.
		helpers.logger.warn({error}, 'Could not refresh the shop TRY display rate; keeping the previous bulletin');
	}
};

export default syncShopTryRate;

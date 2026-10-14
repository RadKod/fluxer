// SPDX-License-Identifier: AGPL-3.0-or-later

import {getShopOrderService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';

// Trigger: a cursor more than 15 minutes old. The admin shop page shows the lag; this makes it loud.
const LAG_WARN_SECONDS = 900;

// Every 10 s (WorkerMain cron): queues the due shop_order_checks rows within the reconcile budget.
const reconcileShopOrders: WorkerTaskHandler = async (_payload, helpers) => {
	const run = await getShopOrderService().reconcile(new Date());
	if (!run) {
		helpers.logger.debug('Shop order reconcile skipped: the previous run is still going');
		return;
	}
	const {queued, lagSeconds} = run;
	if (lagSeconds > LAG_WARN_SECONDS) {
		helpers.logger.warn({lagSeconds, queued}, 'Shop order reconcile is more than 15 minutes behind');
		return;
	}
	helpers.logger.debug({queued, lagSeconds}, 'Reconciled shop orders');
};

export default reconcileShopOrders;

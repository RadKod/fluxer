// SPDX-License-Identifier: AGPL-3.0-or-later

import {getReferralRewardService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';

// no lag on the admin page; a cursor 15 minutes behind the last closed slot is loud here.
const LAG_WARN_SECONDS = 900;

// Every minute (WorkerMain cron): queues an evaluateReferral job per row of the closed referral_checks slots.
const processReferralChecks: WorkerTaskHandler = async (_payload, helpers) => {
	const run = await getReferralRewardService().reconcileChecks(new Date());
	if (!run) {
		helpers.logger.debug('Referral check walk skipped: the previous run is still going');
		return;
	}
	const {queued, lagSeconds} = run;
	if (lagSeconds > LAG_WARN_SECONDS) {
		helpers.logger.warn({lagSeconds, queued}, 'Referral checks are more than 15 minutes behind');
		return;
	}
	helpers.logger.debug({queued, lagSeconds}, 'Queued referral evaluations');
};

export default processReferralChecks;

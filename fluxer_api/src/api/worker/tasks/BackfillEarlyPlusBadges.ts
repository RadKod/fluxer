// SPDX-License-Identifier: AGPL-3.0-or-later

import {getEarlyPlusBadgeService} from '@app/api/middleware/ServiceSingletons';
import {JobCancelledError, type WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';

// Micup Early Plus: queued when the period opens; a redelivered or repeated run writes the same rows. A cancel on the
// jobs page stops it at the next page; badges already given stay.
const backfillEarlyPlusBadges: WorkerTaskHandler = async (_payload, helpers) => {
	const startedAt = Date.now();
	const {granted, scanned, stopped} = await getEarlyPlusBadgeService().backfill({
		shouldStop: () => helpers.shouldCancel(),
		onPage: (scannedSoFar, grantedSoFar) => helpers.reportProgress(scannedSoFar, null, `${grantedSoFar} granted`),
	});
	if (stopped) throw new JobCancelledError();
	return {granted, scanned, duration_ms: Date.now() - startedAt};
};

export default backfillEarlyPlusBadges;

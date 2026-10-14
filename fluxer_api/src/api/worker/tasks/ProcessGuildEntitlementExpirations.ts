// SPDX-License-Identifier: AGPL-3.0-or-later

import {getGuildBoostService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';

// Hourly. Takes boosts off when their booster's premium (and its grace) has ended and wakes guilds whose level grace or
// custom invite code hold has run out. Guild packages (L1) are not part of this wave.
const processGuildEntitlementExpirations: WorkerTaskHandler = async () => {
	await getGuildBoostService().processExpirations(new Date());
};

export default processGuildEntitlementExpirations;

// SPDX-License-Identifier: AGPL-3.0-or-later

import {getFeedTimelineService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';

// The Keşfet list build, every 30 s on the batch lane; runs that piled up behind a busy lane end at its 20 s gate.
const refreshFeedDiscover: WorkerTaskHandler = async () => {
	await getFeedTimelineService().discover.buildSnapshot();
};

export default refreshFeedDiscover;

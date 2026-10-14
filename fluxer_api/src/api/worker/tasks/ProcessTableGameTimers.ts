// SPDX-License-Identifier: AGPL-3.0-or-later

import {getTableGameService} from '@app/api/middleware/ServiceSingletons';
import {TABLE_GAME_TIMER_WARN_MS} from '@app/api/table_game/TableGameLimits';
import type {TableGameService} from '@app/api/table_game/TableGameService';
import type {WorkerTaskHandler, WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';

// Every second (WorkerMain cron, batch lane): settles the game tables whose turn, grace or lobby deadline has passed.
// A tick over 500 ms is the trigger to move this off the batch lane.
const processTableGameTimers = async (
	_payload: unknown,
	helpers: WorkerTaskHelpers,
	service: Pick<TableGameService, 'processDueTimers'> = getTableGameService(),
): Promise<void> => {
	const {processed, durationMs} = await service.processDueTimers(Date.now());
	if (durationMs > TABLE_GAME_TIMER_WARN_MS) {
		helpers.logger.warn({processed, durationMs}, 'Table game timer tick took over 500 ms');
	}
};

export default processTableGameTimers satisfies WorkerTaskHandler;

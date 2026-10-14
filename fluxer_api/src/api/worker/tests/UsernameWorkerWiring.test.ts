// SPDX-License-Identifier: AGPL-3.0-or-later

import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {CronScheduler} from '@app/api/worker/CronScheduler';
import {findLaneForTask} from '@app/api/worker/WorkerLaneConfig';
import {registerCronJobs} from '@app/api/worker/WorkerMain';
import type {WorkerService} from '@app/api/worker/WorkerService';
import {workerTasks} from '@app/api/worker/WorkerTaskRegistry';
import {describe, expect, it, vi} from 'vitest';

describe('username worker connections', () => {
	it('registers repair every 30 seconds, scan kick and daily dictionary cleanup without a runtime monitor', () => {
		const cron = new CronScheduler({addJob: vi.fn()} as unknown as WorkerService, new NoopLogger());
		const upsert = vi.spyOn(cron, 'upsert');
		registerCronJobs(cron, 86400000);
		for (const [name, schedule] of [
			['processUsernameRepair', '*/30 * * * * *'],
			['scanUsernameMigration', '*/30 * * * * *'],
			['cleanupUsernameDictionary', '0 20 4 * * *'],
		]) {
			expect(upsert).toHaveBeenCalledWith(name, name, {}, schedule, {ledger: false});
			expect(workerTasks[name as keyof typeof workerTasks]).toBeTypeOf('function');
		}
		expect(findLaneForTask('reindexUserGuildMembers' as never)).toBe('lifecycle');
		expect(upsert.mock.calls.map((call) => call[0])).not.toContain('monitorUsernameMigration');
		expect(workerTasks).not.toHaveProperty('monitorUsernameMigration');
	});
});

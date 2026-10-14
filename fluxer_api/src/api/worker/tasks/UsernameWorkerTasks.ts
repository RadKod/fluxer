// SPDX-License-Identifier: AGPL-3.0-or-later
import {createHash} from 'node:crypto';
import {cleanupUsernameDictionaryGenerations} from '@app/api/admin/services/AdminBanManagementService';
import type {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {getUsernameOwnershipService} from '@app/api/middleware/ServiceRegistry';
import {UsernameRepairSweeper} from '@app/api/user/username/UsernameRepairSweeper';
import {runUsernameMigrationScan} from '@app/api/worker/tasks/UsernameMigrationTasks';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import {registerHistogram} from '@fluxer/hono/src/middleware/Metrics';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const sweepDuration = registerHistogram(
	'fluxer_api_username_repair_sweep_seconds',
	'Username repair sweep duration',
	[1, 5, 10, 20, 30],
);
let sweeper: UsernameRepairSweeper | undefined;
let sweeperOwner: ReturnType<typeof getUsernameOwnershipService> | undefined;
let sweeperConfig: InstanceConfigRepository | undefined;

export const processUsernameRepair: WorkerTaskHandler = async (_payload, helpers) => {
	const {instanceConfigRepository} = getWorkerDependencies();
	const migration = await instanceConfigRepository.readUsernameMigrationConfig();
	if (migration.state === 'legacy') return;
	const ownership = getUsernameOwnershipService();
	if (!sweeper || sweeperOwner !== ownership || sweeperConfig !== instanceConfigRepository) {
		sweeper = new UsernameRepairSweeper({ownership, config: instanceConfigRepository});
		sweeperOwner = ownership;
		sweeperConfig = instanceConfigRepository;
	}
	const started = performance.now();
	const result = await sweeper.run();
	sweepDuration.observe((performance.now() - started) / 1000);
	if (result.budgetExceeded || result.failed > 0)
		helpers.logger.warn({...result}, 'Username repair sweep needs another bounded pass');
};

const ScanPayloadSchema = z.object({epoch: z.number().int().nonnegative().optional()});
export const scanUsernameMigration: WorkerTaskHandler = async (payload, helpers) => {
	const {epoch} = ScanPayloadSchema.parse(payload);
	const {instanceConfigRepository: config, userRepository: users, kvClient: kv} = getWorkerDependencies();
	const migration = await config.readUsernameMigrationConfig();
	if (epoch !== undefined && epoch !== migration.epoch) return;
	const rowsPerSecond = Number((await config.getConfig('prep_rows_per_second')) ?? 2000);
	const readP99LimitMs = Number((await config.getConfig('prep_read_p99_limit_ms')) ?? 500);
	const result = await runUsernameMigrationScan({config, users, kv, rowsPerSecond, readP99LimitMs});
	if (result.done) return;
	const state = await config.initializeUsernameMigrationScan(migration.epoch);
	const cursor = createHash('sha256')
		.update(state.cursor ?? '')
		.digest('hex');
	// Micup: durable continuations keep a 500-row page from being limited to the 30-second cron kick.
	await helpers.addJob(
		'scanUsernameMigration',
		{epoch: migration.epoch},
		{
			jobKey: `username-scan:${migration.epoch}:${cursor}`,
			runAt: new Date(Date.now() + result.delayMs),
			maxAttempts: 25,
			skipLedger: true,
		},
	);
};

export const cleanupUsernameDictionary: WorkerTaskHandler = async () => {
	await cleanupUsernameDictionaryGenerations();
};

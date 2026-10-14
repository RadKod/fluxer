// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import * as ActivityEvents from '@app/api/infrastructure/activity/ActivityEvents';
import * as SharedLists from '@app/api/infrastructure/activity/SharedLists';
import * as ContentBlocklistCaches from '@app/api/middleware/ContentBlocklistCaches';
import * as ServiceRegistry from '@app/api/middleware/ServiceRegistry';
import * as SearchFactory from '@app/api/SearchFactory';
import {MockSnowflakeService} from '@app/api/test/mocks/MockSnowflakeService';
import * as LifecycleHooks from '@app/api/user/lifecycle/MicupUserLifecycleHooks';
import * as AccountActions from '@app/api/worker/AccountActionConsumer';
import * as BlocklistStartup from '@app/api/worker/BlocklistFeedStartup';
import {CronScheduler} from '@app/api/worker/CronScheduler';
import {JetStreamWorkerQueue} from '@app/api/worker/JetStreamWorkerQueue';
import * as WorkerContext from '@app/api/worker/WorkerContext';
import * as WorkerDependencies from '@app/api/worker/WorkerDependencies';
import {WorkerHeartbeat} from '@app/api/worker/WorkerHeartbeat';
import {startWorkerMain} from '@app/api/worker/WorkerMain';
import {WorkerRunner} from '@app/api/worker/WorkerRunner';
import {WorkerService} from '@app/api/worker/WorkerService';
import * as Server from '@fluxer/hono/src/Server';
import * as Cassandra from '@pkgs/cassandra/src/Client';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {JetStreamConnectionManager} from '@pkgs/nats/src/JetStreamConnectionManager';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

describe('worker startup', () => {
	let restoreConfig: () => void;
	beforeEach(() => {
		const worker = {...Config.worker};
		const backend = Config.database.backend;
		const selfHosted = Config.instance.selfHosted;
		restoreConfig = () => {
			Object.assign(Config.worker, worker);
			Config.database.backend = backend;
			Config.instance.selfHosted = selfHosted;
		};
		Config.database.backend = 'cassandra';
		Object.assign(Config.worker, {mode: 'single_task', taskName: 'reconcileShopOrders', enableCronScheduler: true});
		vi.spyOn(LifecycleHooks, 'registerMicupUserLifecycleHooks').mockImplementation(() => {});
		vi.spyOn(Cassandra, 'initCassandra').mockResolvedValue(undefined);
		vi.spyOn(Cassandra, 'shutdownCassandra').mockResolvedValue(undefined);
		vi.spyOn(ServiceRegistry, 'createSnowflakeService').mockReturnValue(
			new MockSnowflakeService() as unknown as ReturnType<typeof ServiceRegistry.createSnowflakeService>,
		);
		vi.spyOn(ServiceRegistry, 'setInjectedSnowflakeService').mockImplementation(() => {});
		vi.spyOn(ServiceRegistry, 'setInjectedWorkerService').mockImplementation(() => {});
		vi.spyOn(ServiceRegistry, 'getWorkerService').mockReturnValue({addJob: vi.fn()} as unknown as ReturnType<
			typeof ServiceRegistry.getWorkerService
		>);
		vi.spyOn(ServiceRegistry, 'shutdownVoiceResources').mockResolvedValue(undefined);
		vi.spyOn(ServiceRegistry, 'closeOwnedKVClient').mockResolvedValue(undefined);
		vi.spyOn(JetStreamConnectionManager.prototype, 'connect').mockResolvedValue(undefined);
		vi.spyOn(JetStreamConnectionManager.prototype, 'drain').mockResolvedValue(undefined);
		vi.spyOn(JetStreamConnectionManager.prototype, 'getJetStreamClient').mockReturnValue(
			{} as ReturnType<JetStreamConnectionManager['getJetStreamClient']>,
		);
		vi.spyOn(JetStreamConnectionManager.prototype, 'getJetStreamManager').mockResolvedValue(
			{} as Awaited<ReturnType<JetStreamConnectionManager['getJetStreamManager']>>,
		);
		vi.spyOn(ContentBlocklistCaches, 'startContentBlocklistCaches').mockResolvedValue(undefined);
		vi.spyOn(ContentBlocklistCaches, 'stopContentBlocklistCaches').mockResolvedValue(undefined);
		vi.spyOn(ActivityEvents, 'startActivityEvents').mockResolvedValue(undefined);
		vi.spyOn(ActivityEvents, 'shutdownActivityEvents').mockResolvedValue(undefined);
		vi.spyOn(SharedLists, 'startSharedListWatch').mockImplementation(() => {});
		vi.spyOn(SharedLists, 'stopSharedListWatch').mockImplementation(() => {});
		vi.spyOn(JetStreamWorkerQueue.prototype, 'ensureInfrastructure').mockResolvedValue(undefined);
		vi.spyOn(SearchFactory, 'initializeSearch').mockResolvedValue(undefined);
		vi.spyOn(SearchFactory, 'shutdownSearch').mockResolvedValue(undefined);
		vi.spyOn(WorkerContext, 'setWorkerDependencies').mockImplementation(() => {});
		vi.spyOn(WorkerContext, 'clearWorkerDependencies').mockImplementation(() => {});
		vi.spyOn(BlocklistStartup, 'queueBlocklistFeedStartupJobs').mockResolvedValue(undefined);
		vi.spyOn(WorkerService.prototype, 'addJob').mockResolvedValue(1n);
		vi.spyOn(CronScheduler.prototype, 'start').mockImplementation(() => {});
		vi.spyOn(WorkerRunner.prototype, 'start').mockResolvedValue(undefined);
		vi.spyOn(WorkerHeartbeat.prototype, 'start').mockImplementation(() => {});
		vi.spyOn(Server, 'setupGracefulShutdown').mockImplementation(() => {});
		vi.spyOn(process, 'on').mockReturnValue(process);
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('worker exited');
		});
	});
	it.each([true, false])(
		'starts automatic account actions only for hosted lifecycle workers (selfHosted=%s)',
		async (selfHosted) => {
			Config.instance.selfHosted = selfHosted;
			Object.assign(Config.worker, {mode: 'lane', laneName: 'lifecycle'});
			vi.spyOn(WorkerDependencies, 'initializeWorkerDependencies').mockResolvedValue({
				kvClient: new MockKVProvider(),
				channelRepository: {channelData: {}, messages: {}},
			} as unknown as WorkerDependencies.WorkerDependencies);
			const startActions = vi.spyOn(AccountActions, 'startAccountActionConsumer').mockImplementation(() => {});
			await startWorkerMain();
			expect(startActions).toHaveBeenCalledTimes(selfHosted ? 0 : 1);
			expect(WorkerRunner.prototype.start).toHaveBeenCalled();
		},
	);
	afterEach(() => {
		vi.restoreAllMocks();
		restoreConfig();
	});
});

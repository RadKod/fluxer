// SPDX-License-Identifier: AGPL-3.0-or-later

import {buildAPIConfigFromMaster} from '@app/api/Config';
import type {APIWorkerLaneName} from '@app/api/config/APIConfig';
import {
	findLaneForTask,
	queuesUnconsumedPurgeRuns,
	queuesUnconsumedViewFlushes,
	resolveWorkerLanes,
	validateLaneCompleteness,
	WORKER_LANES,
} from '@app/api/worker/WorkerLaneConfig';
import {workerTasks} from '@app/api/worker/WorkerTaskRegistry';
import {loadConfig} from '@fluxer/config/src/ConfigLoader';
import {describe, expect, it} from 'vitest';

describe('WorkerLaneConfig', () => {
	it('roster carries only the slot walk', () => {
		const lanes = resolveWorkerLanes({mode: 'all_lanes', laneConcurrencyOverrides: {}});
		const lane = lanes.find((candidate) => candidate.name === 'roster');
		const tasks = ['queueGuildRosterSlots', 'runGuildRosterSlots'];
		expect(lane).toMatchObject({
			consumerName: 'workers_roster',
			taskTypes: tasks,
			retiredTaskTypes: [],
			concurrency: 8,
			maxAckPending: 600,
			ackWaitMs: 300000,
			maxDeliver: 3,
		});
		for (const task of tasks) expect(findLaneForTask(task)).toBe('roster');
		expect(lanes.indexOf(lane!)).toBe(lanes.findIndex((candidate) => candidate.name === 'referral') + 1);
		expect(
			resolveWorkerLanes({mode: 'single_lane', laneName: 'roster', laneConcurrencyOverrides: {roster: 2}}),
		).toEqual([{...lane, concurrency: 2}]);
		expect(() => validateLaneCompleteness(workerTasks)).not.toThrow();
	});
	it('roster_live carries the reaction sync and render tasks', () => {
		const lanes = resolveWorkerLanes({mode: 'all_lanes', laneConcurrencyOverrides: {}});
		const lane = lanes.find((candidate) => candidate.name === 'roster_live');
		const tasks = ['syncGuildRosterReaction', 'renderGuildRosterMessage'];
		expect(lane).toMatchObject({
			consumerName: 'workers_roster_live',
			taskTypes: tasks,
			retiredTaskTypes: [],
			concurrency: 16,
			maxAckPending: 10_000,
			ackWaitMs: 30_000,
			maxDeliver: 8,
		});
		for (const task of tasks) expect(findLaneForTask(task)).toBe('roster_live');
		expect(lanes.indexOf(lane!)).toBe(lanes.findIndex((candidate) => candidate.name === 'roster') + 1);
		expect(
			resolveWorkerLanes({mode: 'single_lane', laneName: 'roster_live', laneConcurrencyOverrides: {roster_live: 2}}),
		).toEqual([{...lane, concurrency: 2}]);
		expect(() => validateLaneCompleteness(workerTasks)).not.toThrow();
	});
	it('roster_live allows at least eight deliveries for contended joins', () => {
		for (const taskName of ['syncGuildRosterReaction', 'renderGuildRosterMessage'] as const) {
			const [lane] = resolveWorkerLanes({mode: 'single_task', taskName, laneConcurrencyOverrides: {}});
			expect(lane!.maxDeliver).toBeGreaterThanOrEqual(8);
		}
	});
	it('preserves both roster lane concurrency overrides in the API config', async () => {
		const master = await loadConfig();
		const config = buildAPIConfigFromMaster({
			...master,
			services: {
				...master.services,
				api: {
					...master.services.api,
					worker: {
						mode: 'single_lane',
						lane: 'roster_live',
						lane_concurrency_overrides: {roster: 2, roster_live: 4},
					},
				},
			},
		});
		expect(config.worker.laneName).toBe('roster_live');
		expect(config.worker.laneConcurrencyOverrides).toMatchObject({roster: 2, roster_live: 4});
	});
	it('returns all lanes in all_lanes mode', () => {
		const lanes = resolveWorkerLanes({
			mode: 'all_lanes',
			laneConcurrencyOverrides: {},
		});
		expect(lanes.map((lane) => lane.name)).toEqual(WORKER_LANES.map((lane) => lane.name));
	});
	it('returns a single lane in single_lane mode', () => {
		const lanes = resolveWorkerLanes({
			mode: 'single_lane',
			laneName: 'batch',
			laneConcurrencyOverrides: {},
		});
		expect(lanes).toHaveLength(1);
		expect(lanes[0]!.name).toBe('batch');
	});
	it('resolves Stripe webhook processing in lifecycle lane when running single_task mode', () => {
		const lanes = resolveWorkerLanes({
			mode: 'single_task',
			taskName: 'processStripeWebhook',
			laneConcurrencyOverrides: {},
		});
		expect(lanes).toHaveLength(1);
		expect(lanes[0]!.name).toBe('lifecycle');
		expect(lanes[0]!.taskTypes).toEqual(['processStripeWebhook']);
	});
	it('keeps mention processing in realtime and routes embed extraction to the dedicated unfurl lane', () => {
		const mentionLane = resolveWorkerLanes({
			mode: 'single_task',
			taskName: 'handleMentions',
			laneConcurrencyOverrides: {},
		});
		const mentionChunkLane = resolveWorkerLanes({
			mode: 'single_task',
			taskName: 'handleMentionChunk',
			laneConcurrencyOverrides: {},
		});
		const embedLane = resolveWorkerLanes({
			mode: 'single_task',
			taskName: 'extractEmbeds',
			laneConcurrencyOverrides: {},
		});
		expect(mentionLane).toHaveLength(1);
		expect(mentionLane[0]!.name).toBe('realtime');
		expect(mentionLane[0]!.taskTypes).toEqual(['handleMentions']);
		expect(mentionChunkLane).toHaveLength(1);
		expect(mentionChunkLane[0]!.name).toBe('realtime');
		expect(mentionChunkLane[0]!.taskTypes).toEqual(['handleMentionChunk']);
		expect(embedLane).toHaveLength(1);
		expect(embedLane[0]!.name).toBe('unfurl');
		expect(embedLane[0]!.taskTypes).toEqual(['extractEmbeds']);
		expect(findLaneForTask('extractFeedPostEmbeds')).toBe('unfurl');
	});
	it('runs feed fan-out and notification aggregation on their own lane', () => {
		const lanes = resolveWorkerLanes({mode: 'all_lanes', laneConcurrencyOverrides: {}});
		const feedLane = lanes.find((lane) => lane.name === 'feed');
		expect(feedLane?.consumerName).toBe('workers_feed');
		expect(feedLane?.taskTypes).toEqual(['fanoutFeedPost', 'aggregateFeedNotification']);
		expect(resolveWorkerLanes({mode: 'single_lane', laneName: 'feed', laneConcurrencyOverrides: {}})).toEqual([
			feedLane,
		]);
	});
	it('runs the Bunny video tasks on their own lane after feed', () => {
		const lanes = resolveWorkerLanes({mode: 'all_lanes', laneConcurrencyOverrides: {}});
		const videoLane = lanes.find((lane) => lane.name === 'video');
		expect(videoLane).toMatchObject({
			consumerName: 'workers_video',
			taskTypes: [
				'processFeedVideoWebhook',
				'scanFeedVideo',
				'deleteFeedVideo',
				'keepFeedVideoEvidence',
				'reconcileFeedVideos',
				'reconcileFeedVideoBucket',
				'drainFeedVideoJobs',
			],
			retiredTaskTypes: [],
			concurrency: 4,
			// short NAK waits hold these slots; waits over a minute sit in KV minute buckets instead.
			maxAckPending: 10_000,
			// A reported video's evidence streams up to 2 GiB of HLS segments in one job.
			ackWaitMs: 600_000,
			maxDeliver: 25,
		});
		expect(lanes.indexOf(videoLane!)).toBe(lanes.findIndex((lane) => lane.name === 'feed') + 1);
		expect(findLaneForTask('scanFeedVideo')).toBe('video');
		expect(resolveWorkerLanes({mode: 'single_lane', laneName: 'video', laneConcurrencyOverrides: {video: 8}})).toEqual([
			{...videoLane, concurrency: 8},
		]);
		expect(() => validateLaneCompleteness(workerTasks)).not.toThrow();
	});
	it('runs the feed view flush on its own views lane after video', () => {
		const lanes = resolveWorkerLanes({mode: 'all_lanes', laneConcurrencyOverrides: {}});
		const viewsLane = lanes.find((lane) => lane.name === 'views');
		expect(viewsLane).toMatchObject({
			consumerName: 'workers_views',
			taskTypes: ['flushFeedViewCounters', 'flushFeedViewCounterSlice'],
			retiredTaskTypes: [],
			// 16 slots take a minute's 16 slices of up to 45 s at once (16 × 45 s ≤ 16 × 60 s).
			concurrency: 16,
			maxAckPending: 100,
			ackWaitMs: 120_000,
			maxDeliver: 3,
		});
		expect(lanes.indexOf(viewsLane!)).toBe(lanes.findIndex((lane) => lane.name === 'video') + 1);
		expect(findLaneForTask('flushFeedViewCounters')).toBe('views');
		expect(findLaneForTask('flushFeedViewCounterSlice')).toBe('views');
		expect(lanes.find((lane) => lane.name === 'batch')?.taskTypes).not.toContain('flushFeedViewCounterSlice');
		expect(resolveWorkerLanes({mode: 'single_lane', laneName: 'views', laneConcurrencyOverrides: {views: 1}})).toEqual([
			{...viewsLane, concurrency: 1},
		]);
		expect(() => validateLaneCompleteness(workerTasks)).not.toThrow();
	});
	it('warns when the cron queues view flushes that no lane of this worker takes', () => {
		const singleLane = (laneName: APIWorkerLaneName) =>
			resolveWorkerLanes({mode: 'single_lane', laneName, laneConcurrencyOverrides: {}});
		expect(queuesUnconsumedViewFlushes(singleLane('batch'), true)).toBe(true);
		expect(queuesUnconsumedViewFlushes(singleLane('views'), true)).toBe(false);
		expect(
			queuesUnconsumedViewFlushes(resolveWorkerLanes({mode: 'all_lanes', laneConcurrencyOverrides: {}}), true),
		).toBe(false);
		expect(queuesUnconsumedViewFlushes(singleLane('batch'), false)).toBe(false);
	});
	it('runs referral evaluation, grants and backfill pages on their own referral lane; the check cron on batch', () => {
		const lanes = resolveWorkerLanes({mode: 'all_lanes', laneConcurrencyOverrides: {}});
		const referralLane = lanes.find((lane) => lane.name === 'referral');
		expect(referralLane).toMatchObject({
			consumerName: 'workers_referral',
			taskTypes: ['evaluateReferral', 'grantReferralRewards', 'backfillReferralTier'],
			retiredTaskTypes: [],
		});
		expect(findLaneForTask('processReferralChecks')).toBe('batch');
		expect(lanes.find((lane) => lane.name === 'lifecycle')?.taskTypes).not.toContain('evaluateReferral');
		expect(
			resolveWorkerLanes({mode: 'single_lane', laneName: 'referral', laneConcurrencyOverrides: {referral: 2}}),
		).toEqual([{...referralLane, concurrency: 2}]);
		expect(() => validateLaneCompleteness(workerTasks)).not.toThrow();
	});
	it('builds the Keşfet list on the batch lane with the other feed crons', () => {
		expect(findLaneForTask('refreshFeedDiscover')).toBe('batch');
		expect(findLaneForTask('flushCounters')).toBe('batch');
	});
	it('builds the feed suggestions and runs their backfill on the batch lane', () => {
		expect(findLaneForTask('refreshFeedSuggestions')).toBe('batch');
		expect(findLaneForTask('backfillFeedSuggestionRanking')).toBe('batch');
		expect(() => validateLaneCompleteness(workerTasks)).not.toThrow();
	});
	it('runs the game table timer on the batch lane', () => {
		expect(findLaneForTask('processTableGameTimers')).toBe('batch');
		expect(() => validateLaneCompleteness(workerTasks)).not.toThrow();
	});
	it('queues guild boost work on the lifecycle and batch lanes', () => {
		expect(findLaneForTask('recomputeGuildBoost')).toBe('lifecycle');
		expect(findLaneForTask('processGuildEntitlementExpirations')).toBe('batch');
	});
	it('runs cache purges on their own lane so a backed up batch lane cannot hold them back', () => {
		const lanes = resolveWorkerLanes({mode: 'all_lanes', laneConcurrencyOverrides: {}});
		const purgeLane = lanes.find((lane) => lane.taskTypes.includes('processCachePurgeQueue'));
		const batchLane = lanes.find((lane) => lane.name === 'batch');
		expect(purgeLane?.name).toBe('purge');
		expect(purgeLane?.taskTypes).toEqual(['processCachePurgeQueue']);
		expect(purgeLane?.consumerName).not.toBe(batchLane?.consumerName);
		expect(batchLane?.taskTypes).toContain('rebuildCounter');
		expect(batchLane?.taskTypes).not.toContain('processCachePurgeQueue');
		// The jobs stream is a work queue: batch has to let go of the subject before the purge consumer claims it.
		expect(lanes.indexOf(purgeLane!)).toBeGreaterThan(lanes.indexOf(batchLane!));
		expect(resolveWorkerLanes({mode: 'single_lane', laneName: 'purge', laneConcurrencyOverrides: {}})).toEqual([
			purgeLane,
		]);
	});
	it('flags a cron worker that queues cache purge runs while none of its lanes takes them', () => {
		const singleLane = (laneName: APIWorkerLaneName) =>
			resolveWorkerLanes({mode: 'single_lane', laneName, laneConcurrencyOverrides: {}});
		expect(queuesUnconsumedPurgeRuns(singleLane('batch'), true, 'bunny')).toBe(true);
		expect(queuesUnconsumedPurgeRuns(singleLane('batch'), true, 'queue_only')).toBe(true);
		expect(queuesUnconsumedPurgeRuns(singleLane('purge'), true, 'http')).toBe(false);
		expect(
			queuesUnconsumedPurgeRuns(resolveWorkerLanes({mode: 'all_lanes', laneConcurrencyOverrides: {}}), true, 'bunny'),
		).toBe(false);
		// Nothing is queued without an adapter, and a worker without cron cannot tell whether anyone queues runs.
		expect(queuesUnconsumedPurgeRuns(singleLane('batch'), true, 'none')).toBe(false);
		expect(queuesUnconsumedPurgeRuns(singleLane('batch'), false, 'bunny')).toBe(false);
	});
	it('keeps each retired subject on the lane that used to run it', () => {
		const lanes = resolveWorkerLanes({
			mode: 'all_lanes',
			laneConcurrencyOverrides: {},
		});
		const retired = Object.fromEntries(
			lanes.filter((lane) => lane.retiredTaskTypes.length > 0).map((lane) => [lane.name, lane.retiredTaskTypes]),
		);
		expect(retired).toEqual({
			lifecycle: ['sendScheduledMessage', 'finalizeNcmecAttachmentReport'],
			batch: ['syncDisposableEmailDomains'],
		});
		for (const lane of lanes) {
			for (const task of lane.retiredTaskTypes) expect(lane.taskTypes).not.toContain(task);
		}
	});
	it('never claims a retired subject from a single_task lane', () => {
		const lanes = resolveWorkerLanes({
			mode: 'single_task',
			taskName: 'processStripeWebhook',
			laneConcurrencyOverrides: {},
		});
		expect(lanes[0]!.retiredTaskTypes).toEqual([]);
	});
	it('rejects a registry that brings a retired task name back', () => {
		const registry = Object.fromEntries(WORKER_LANES.flatMap((lane) => lane.taskTypes).map((task) => [task, () => {}]));
		expect(() => validateLaneCompleteness(registry)).not.toThrow();
		expect(() => validateLaneCompleteness({...registry, sendScheduledMessage: () => {}})).toThrow(
			/Retired tasks registered again: sendScheduledMessage/,
		);
	});
});

it('micupbot_live carries the live bot tasks', () => {
	const lane = resolveWorkerLanes({mode: 'all_lanes', laneConcurrencyOverrides: {}}).find(
		(l) => l.name === 'micupbot_live',
	);
	const tasks = [
		'runMicupBotCommand',
		'handleMicupBotMemberEvent',
		'applyMicupBotAutomodAction',
		'handleMicupBotLevelUp',
	];
	expect(lane).toMatchObject({
		consumerName: 'workers_micupbot_live',
		taskTypes: tasks,
		retiredTaskTypes: [],
		concurrency: 16,
		maxAckPending: 10000,
		ackWaitMs: 30000,
		maxDeliver: 3,
	});
	for (const task of tasks) expect(findLaneForTask(task)).toBe('micupbot_live');
	expect(() => validateLaneCompleteness(workerTasks)).not.toThrow();
});
it('micupbot_roles carries only the reaction role task', () => {
	const lane = resolveWorkerLanes({mode: 'all_lanes', laneConcurrencyOverrides: {}}).find(
		(l) => l.name === 'micupbot_roles',
	);
	const tasks = ['applyMicupBotReactionRole'];
	expect(lane).toMatchObject({
		consumerName: 'workers_micupbot_roles',
		taskTypes: tasks,
		retiredTaskTypes: [],
		concurrency: 16,
		maxAckPending: 10000,
		ackWaitMs: 30000,
		maxDeliver: 3,
	});
	for (const task of tasks) expect(findLaneForTask(task)).toBe('micupbot_roles');
	expect(() => validateLaneCompleteness(workerTasks)).not.toThrow();
});
it('micupbot carries the flush, rebuild and voice tasks', () => {
	const lane = resolveWorkerLanes({mode: 'all_lanes', laneConcurrencyOverrides: {}}).find((l) => l.name === 'micupbot');
	const tasks = [
		'flushMicupBotXp',
		'flushMicupBotXpSlice',
		'rebuildMicupBotLeaderboard',
		'queueMicupBotVoiceSlots',
		'runMicupBotVoiceSlots',
	];
	expect(lane).toMatchObject({
		consumerName: 'workers_micupbot',
		taskTypes: tasks,
		retiredTaskTypes: [],
		concurrency: 8,
		maxAckPending: 600,
		ackWaitMs: 300000,
		maxDeliver: 3,
	});
	for (const task of tasks) expect(findLaneForTask(task)).toBe('micupbot');
	expect(() => validateLaneCompleteness(workerTasks)).not.toThrow();
});

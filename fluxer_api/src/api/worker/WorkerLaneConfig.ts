// SPDX-License-Identifier: AGPL-3.0-or-later

import type {APIWorkerLaneName, APIWorkerMode} from '@app/api/config/APIConfig';
import type {CachePurgeAdapterName} from '@fluxer/config/src/MasterConfig';

interface LaneSettings {
	readonly consumerName: string;
	readonly tasks: ReadonlyArray<string>;
	readonly retiredTasks: ReadonlyArray<string>;
	readonly concurrency: number;
	readonly maxAckPending: number;
	readonly ackWaitMs: number;
	readonly maxDeliver: number;
}

const LANE_CONFIG = {
	realtime: {
		consumerName: 'workers_realtime',
		tasks: ['handleMentions', 'handleMentionChunk'] as const,
		retiredTasks: [],
		concurrency: 10,
		maxAckPending: 50,
		ackWaitMs: 15000,
		maxDeliver: 3,
	},
	unfurl: {
		consumerName: 'workers_unfurl',
		// Micup feed link previews wait at most 5 s on the unfurler. TEMPORARY: they share this lane with
		// message previews; give them a lane of their own when the unfurl queue delay passes 30 s.
		tasks: ['extractEmbeds', 'extractFeedPostEmbeds'] as const,
		retiredTasks: [],
		concurrency: 20,
		maxAckPending: 200,
		ackWaitMs: 30000,
		maxDeliver: 3,
	},
	lifecycle: {
		consumerName: 'workers_lifecycle',
		tasks: [
			'processStripeWebhook',
			'sendSystemDm',
			'userProcessPendingDeletion',
			'userProcessPendingDeletions',
			'applicationProcessDeletion',
			'guildProcessDeletion',
			'processUserDeletionHook',
			'bulkDeleteSelfMessagesImmediate',
			'bulkDeleteUserMessages',
			'deleteUserMessagesInGuildByTime',
			'messageShred',
			'harvestGuildData',
			'harvestUserData',
			'batchGuildAuditLogMessageDeletes',
			'reconcileUserPayments',
			'syncStripeCustomerEmail',
			'processAppStoreNotification',
			'processGooglePlayNotification',
			'refreshStorePurchase',
			'bulkUpdateUserFlags',
			'bulkScheduleUserDeletion',
			'bulkUpdateGuildFeatures',
			'bulkAddGuildMembers',
			'bulkBanFileShas',
			'bulkDeleteMessagesForUsers',
			'ensureUserPremium',
			'resetPremiumPerkSanitization',
			// TEMPORARY: shares the lifecycle lane with bulk jobs; give it its own lane when its queue delay passes 30 s.
			'propagatePartialUserChange',
			// Micup: TEMPORARY shared lifecycle lane; move reindex to its own process when queue age exceeds 30 seconds.
			'reindexUserGuildMembers',
			'processUsernameRepair',
			'recomputeGuildBoost',
			'removeBlockedFollows',
			'removeMemberBoosts',
			// Micup Öncü. TEMPORARY: shares the lifecycle lane; give it its own lane (concurrency 1) when the lifecycle
			// queue delay passes 30 s or pioneer CAS timeouts show up.
			'assignPioneerBadge',
			'backfillPioneerBadges',
			// Micup Early Plus: one run when the period opens.
			'backfillEarlyPlusBadges',
			// TEMPORARY: shares the lifecycle lane; give it a shop lane when its queue delay passes 30 s.
			'verifyShopOrder',
			'drainActivitySpool',
			'liftExpiredGuildInvitePauses',
		] as const,
		retiredTasks: ['sendScheduledMessage', 'finalizeNcmecAttachmentReport'],
		concurrency: 8,
		maxAckPending: 50,
		ackWaitMs: 60000,
		maxDeliver: 25,
	},
	batch: {
		consumerName: 'workers_batch',
		tasks: [
			'expireAttachments',
			'reconcileAttachmentDecay',
			'expireReportSnapshots',
			'clearAuthenticatedReporterEmails',
			'expireStaleJobs',
			'indexChannelMessages',
			'indexGuildMembers',
			'scanUsernameMigration',
			'cleanupUsernameDictionary',
			'processAssetDeletionQueue',
			'processExpiredPremiumSweep',
			'processInactivityDeletions',
			'processPendingBulkMessageDeletions',
			'processPremiumStateReconciliationQueue',
			'processPremiumExpirations',
			'processGuildEntitlementExpirations',
			'backfillGuildBoosts',
			'processStorePurchaseRefreshQueue',
			'pollGooglePlayVoidedPurchases',
			'pollAppStoreNotificationHistory',
			'prunePostgresKvTtl',
			'refreshSearchIndex',
			'seedThreadPermissions',
			'archiveInactiveThreads',
			'repairThreadIndexes',
			'deleteChannelThreads',
			'removeThreadMembershipsForGuildMember',
			'syncThreadSearchDocument',
			'backfillThreadSearch',
			'syncDiscoveryIndex',
			'syncUrlBlocklists',
			'syncFileShaBlocklists',
			'flushUserActivityBuffer',
			'flushCounters',
			'rebuildCounter',
			'refreshFeedDiscover',
			'reconcileShopOrders',
			'refreshFeedSuggestions',
			'backfillFeedSuggestionRanking',
			// Micup referral: the minute walk over the closed referral_checks slots; it only queues evaluateReferral jobs.
			'processReferralChecks',
			// the game table timer, every second. TEMPORARY: it shares the batch lane, so a batch
			// backlog (rebuildCounter after a gateway restart) delays turn timeouts; moves and ticks settle on their own.
			// Trigger: a tick over 500 ms (its warning) or a batch queue delay over 5 s. Path: a table_game lane of its own
			// and a job per timer shard.
			'processTableGameTimers',
		] as const,
		retiredTasks: ['syncDisposableEmailDomains'],
		concurrency: 12,
		maxAckPending: 100,
		ackWaitMs: 120000,
		maxDeliver: 25,
	},
	// removals of deleted and reported (CSAM) media from the CDN must not wait behind batch backlogs such
	// as the per-guild rebuildCounter jobs a gateway restart queues. NCMEC and admin removals go first through the
	// priority purge queue.
	// TEMPORARY: every replica draws on one Bunny account budget, so the lane purges no faster than that; move to tag
	// purges and a raised FLUXER_CACHE_PURGE_BUNNY_RATE_PER_MINUTE once "Bunny purge budget is spent" keeps showing up.
	purge: {
		consumerName: 'workers_purge',
		tasks: ['processCachePurgeQueue'] as const,
		retiredTasks: [],
		concurrency: 2,
		maxAckPending: 10,
		ackWaitMs: 120000,
		maxDeliver: 25,
	},
	// Micup: feed fan-out writes up to 500 home feed rows per job; a post flood must not starve the core lanes.
	feed: {
		consumerName: 'workers_feed',
		tasks: ['fanoutFeedPost', 'aggregateFeedNotification'] as const,
		retiredTasks: [],
		concurrency: 16,
		maxAckPending: 200,
		ackWaitMs: 60000,
		maxDeliver: 25,
	},
	// Micup feed videos (Bunny Stream): frame scans and evidence copies of up to 2 GiB of HLS segments outlast the other
	// lanes' ack waits, and a scan backlog must not hold up fan-out or batch work. TEMPORARY: concurrency 4 per
	// process; path: a process per lane (FLUXER_API_WORKER_LANE=video) and a pooled NSFW service; trigger: video queue
	// delay over 60 s.
	// A job scheduled ahead is NAKed until its time and holds a max_ack_pending slot meanwhile: waits over a minute
	// sit in KV minute buckets (drainFeedVideoJobs), so only waits up to a minute and error retries hold slots here.
	// TEMPORARY: 10 000 slots per consumer; path: more slots or more waits moved to the buckets; trigger: the consumer's
	// num_ack_pending above 8 000 (80 %).
	video: {
		consumerName: 'workers_video',
		tasks: [
			'processFeedVideoWebhook',
			'scanFeedVideo',
			'deleteFeedVideo',
			'keepFeedVideoEvidence',
			'reconcileFeedVideos',
			'reconcileFeedVideoBucket',
			'drainFeedVideoJobs',
		] as const,
		retiredTasks: [],
		concurrency: 4,
		maxAckPending: 10_000,
		ackWaitMs: 600000,
		maxDeliver: 25,
	},
	// view counters keep their own dirty sets and flush only here — a cron each minute and 16
	// slices of 64 partitions. 16 slots take a minute's 16 slices at once (16 × 45 s ≤ 16 × 60 s), so one process keeps up.
	// Ceiling and knobs: FLUXER_API_WORKER_FEED_VIEW_FLUSH_PARTITION_CONCURRENCY, then more slices.
	// TEMPORARY: in an all_lanes process this lane shares the event loop and Cassandra pool; path: its own process
	// (FLUXER_API_WORKER_LANE=views) and {"views":1} on all_lanes; trigger, whichever comes first: flushCounters' "whole
	// 8 s budget" warning, the view flush slice's "whole 45 s budget" warning, or feature_feed_views being turned on.
	views: {
		consumerName: 'workers_views',
		tasks: ['flushFeedViewCounters', 'flushFeedViewCounterSlice'] as const,
		retiredTasks: [],
		concurrency: 16,
		maxAckPending: 100,
		ackWaitMs: 120000,
		maxDeliver: 3,
	},
	// Micup referral: evaluations, reward grants and backfill pages, kept off lifecycle so an
	// hour's closed check slot or a tier backfill cannot hold up deletions, payments or system DMs. A backfill page grants
	// up to 500 accounts in sequence, hence the 2 minute ack wait.
	// TEMPORARY: 8 at a time per process. Trigger: the referral queue delay passes 60 s or the check cursor lags
	// 15 minutes. Path: a process per lane (FLUXER_API_WORKER_LANE=referral) and a higher concurrency override.
	referral: {
		consumerName: 'workers_referral',
		tasks: ['evaluateReferral', 'grantReferralRewards', 'backfillReferralTier'] as const,
		retiredTasks: [],
		concurrency: 8,
		maxAckPending: 200,
		ackWaitMs: 120000,
		maxDeliver: 25,
	},
	// Micup roster bot: the :25/:35 slot walks, separate from live reaction syncs and renders.
	roster: {
		consumerName: 'workers_roster',
		tasks: ['queueGuildRosterSlots', 'runGuildRosterSlots'] as const,
		retiredTasks: [],
		concurrency: 8,
		maxAckPending: 600,
		ackWaitMs: 300000,
		maxDeliver: 3,
	},
	// Temporary: one lane carries live roster jobs for all guilds. Move to a process per lane when
	// num_ack_pending exceeds 80% or sync lag_ms p95 exceeds 30 s.
	roster_live: {
		consumerName: 'workers_roster_live',
		tasks: ['syncGuildRosterReaction', 'renderGuildRosterMessage'] as const,
		retiredTasks: [],
		concurrency: 16,
		maxAckPending: 10_000,
		ackWaitMs: 30_000,
		maxDeliver: 8,
	},
	// Micup MicupBOT: per-message and per-event work — commands, joins/leaves, automod actions,
	// level-ups. Reaction roles use micupbot_roles. TEMPORARY: one lane for every guild's live bot work. Trigger: num_ack_pending
	// > 80 % or a command's lag_ms p95 > 5 s. Path: a process per lane (FLUXER_API_WORKER_LANE=micupbot_live).
	micupbot_live: {
		consumerName: 'workers_micupbot_live',
		tasks: [
			'runMicupBotCommand',
			'handleMicupBotMemberEvent',
			'applyMicupBotAutomodAction',
			'handleMicupBotLevelUp',
		] as const,
		retiredTasks: [],
		concurrency: 16,
		maxAckPending: 10_000,
		ackWaitMs: 30_000,
		maxDeliver: 3,
	},
	// Micup MicupBOT: the minute XP flush, leaderboard rebuilds and the 5-minute voice XP walk, off the live lane.
	// TEMPORARY: trigger: the XP flush slice "whole budget" warning or voice walk lag_ms p95 > 60 s; path:
	// a process per lane (FLUXER_API_WORKER_LANE=micupbot).
	micupbot: {
		consumerName: 'workers_micupbot',
		tasks: [
			'flushMicupBotXp',
			'flushMicupBotXpSlice',
			'rebuildMicupBotLeaderboard',
			'queueMicupBotVoiceSlots',
			'runMicupBotVoiceSlots',
		] as const,
		retiredTasks: [],
		concurrency: 8,
		maxAckPending: 600,
		ackWaitMs: 300_000,
		maxDeliver: 3,
	},
	// Micup MicupBOT: reaction role grants on their own lane, so a 1 M member community's new
	// panel cannot hold up commands, automod and welcomes. TEMPORARY: trigger: num_ack_pending > 80 %;
	// path: a process per lane (FLUXER_API_WORKER_LANE=micupbot_roles).
	micupbot_roles: {
		consumerName: 'workers_micupbot_roles',
		tasks: ['applyMicupBotReactionRole'] as const,
		retiredTasks: [],
		concurrency: 16,
		maxAckPending: 10_000,
		ackWaitMs: 30_000,
		maxDeliver: 3,
	},
	crosspost: {
		consumerName: 'workers_crosspost',
		tasks: [
			'crosspostMessage',
			'crosspostMessageChunk',
			'syncCrosspostedMessage',
			'syncCrosspostCopies',
			'removeChannelFollowers',
		] as const,
		retiredTasks: [],
		concurrency: 8,
		maxAckPending: 64,
		ackWaitMs: 60000,
		maxDeliver: 25,
	},
} satisfies Record<APIWorkerLaneName, LaneSettings>;

export type WorkerTaskName = (typeof LANE_CONFIG)[keyof typeof LANE_CONFIG]['tasks'][number];

interface WorkerLaneDefinition {
	name: APIWorkerLaneName;
	consumerName: string;
	taskTypes: ReadonlyArray<WorkerTaskName>;
	retiredTaskTypes: ReadonlyArray<string>;
	concurrency: number;
	maxAckPending: number;
	ackWaitMs: number;
	maxDeliver: number;
}

interface WorkerLaneRuntimeConfig {
	mode: APIWorkerMode;
	laneName?: APIWorkerLaneName;
	taskName?: WorkerTaskName;
	laneConcurrencyOverrides: Partial<Record<APIWorkerLaneName, number>>;
}

function makeLane(name: APIWorkerLaneName): WorkerLaneDefinition {
	const config = LANE_CONFIG[name];
	return {
		name,
		consumerName: config.consumerName,
		taskTypes: config.tasks,
		retiredTaskTypes: config.retiredTasks,
		concurrency: config.concurrency,
		maxAckPending: config.maxAckPending,
		ackWaitMs: config.ackWaitMs,
		maxDeliver: config.maxDeliver,
	};
}

const WORKER_LANES: ReadonlyArray<WorkerLaneDefinition> = [
	makeLane('realtime'),
	makeLane('unfurl'),
	makeLane('lifecycle'),
	makeLane('batch'),
	// After batch: on the work-queue jobs stream batch has to release a moved subject before another lane claims it.
	makeLane('purge'),
	makeLane('feed'),
	makeLane('video'),
	makeLane('views'),
	makeLane('referral'),
	makeLane('roster'),
	makeLane('roster_live'),
	makeLane('micupbot_live'),
	makeLane('micupbot_roles'),
	makeLane('micupbot'),
	makeLane('crosspost'),
];
const WORKER_LANE_MAP = buildWorkerLaneMap();
const WORKER_LANE_NAMES = Object.freeze(WORKER_LANES.map((lane) => lane.name));

function buildWorkerLaneMap(): Record<APIWorkerLaneName, WorkerLaneDefinition> {
	const laneMap = {} as Record<APIWorkerLaneName, WorkerLaneDefinition>;
	for (const lane of WORKER_LANES) {
		laneMap[lane.name] = lane;
	}
	return laneMap;
}

function resolveLaneName(laneName: APIWorkerLaneName | undefined): APIWorkerLaneName {
	if (!laneName) {
		throw new Error(
			`Worker lane name is required when worker mode is "single_lane". Available lanes: ${WORKER_LANE_NAMES.join(', ')}`,
		);
	}
	if (!Object.hasOwn(WORKER_LANE_MAP, laneName)) {
		throw new Error(`Unknown worker lane "${laneName}". Available lanes: ${WORKER_LANE_NAMES.join(', ')}`);
	}
	return laneName;
}

function resolveSingleTaskLane(taskName: WorkerTaskName | undefined): WorkerLaneDefinition {
	if (!taskName) {
		throw new Error('Worker task name is required when worker mode is "single_task"');
	}
	const parentLane = WORKER_LANES.find((lane) => lane.taskTypes.includes(taskName));
	if (!parentLane) {
		const allTaskNames = WORKER_LANES.flatMap<string>((lane) => [...lane.taskTypes]);
		throw new Error(`Task "${taskName}" is not assigned to any lane. Known tasks: ${allTaskNames.join(', ')}`);
	}
	return {
		name: parentLane.name,
		consumerName: `worker_${taskName}`,
		taskTypes: [taskName],
		retiredTaskTypes: [],
		concurrency: parentLane.concurrency,
		maxAckPending: parentLane.maxAckPending,
		ackWaitMs: parentLane.ackWaitMs,
		maxDeliver: parentLane.maxDeliver,
	};
}

function resolveLaneNames(config: WorkerLaneRuntimeConfig): Array<APIWorkerLaneName> {
	if (config.mode === 'single_lane') {
		return [resolveLaneName(config.laneName)];
	}
	return [...WORKER_LANE_NAMES];
}

function resolveLaneByName(laneName: APIWorkerLaneName): WorkerLaneDefinition {
	const lane = WORKER_LANE_MAP[laneName];
	if (!lane) {
		throw new Error(`Unknown worker lane "${laneName}". Available lanes: ${WORKER_LANE_NAMES.join(', ')}`);
	}
	return lane;
}

function applyLaneConcurrencyOverride(
	lane: WorkerLaneDefinition,
	laneConcurrencyOverrides: Partial<Record<APIWorkerLaneName, number>>,
): WorkerLaneDefinition {
	const overrideConcurrency = laneConcurrencyOverrides[lane.name];
	if (overrideConcurrency === undefined) {
		return lane;
	}
	if (!Number.isInteger(overrideConcurrency) || overrideConcurrency < 1) {
		throw new Error(
			`Invalid concurrency override for lane "${lane.name}": ${overrideConcurrency}. Expected an integer >= 1.`,
		);
	}
	return {
		...lane,
		concurrency: overrideConcurrency,
	};
}

function resolveWorkerLanes(config: WorkerLaneRuntimeConfig): Array<WorkerLaneDefinition> {
	if (config.mode === 'single_task') {
		return [resolveSingleTaskLane(config.taskName)];
	}
	const laneNames = resolveLaneNames(config);
	return laneNames.map((laneName) => {
		const lane = resolveLaneByName(laneName);
		return applyLaneConcurrencyOverride(lane, config.laneConcurrencyOverrides);
	});
}

function resolveCronSchedulerEnabled(mode: APIWorkerMode, configuredValue: boolean | undefined): boolean {
	if (configuredValue !== undefined) {
		return configuredValue;
	}
	return mode === 'all_lanes';
}

// Micup: cron queues a cache purge run every 10 s and only a worker on the purge lane takes it. A process cannot see
// the others, so the one that queues the runs says when none of its own lanes takes them: a single_lane split that
// leaves purge out would otherwise keep deleted and reported (CSAM) media on the CDN without a single error.
function queuesUnconsumedPurgeRuns(
	lanes: ReadonlyArray<WorkerLaneDefinition>,
	cronSchedulerEnabled: boolean,
	cachePurgeAdapter: CachePurgeAdapterName,
): boolean {
	return (
		cronSchedulerEnabled &&
		cachePurgeAdapter !== 'none' &&
		!lanes.some((lane) => lane.taskTypes.includes('processCachePurgeQueue'))
	);
}

// as the purge runs above — the process that queues the minute view flush says when none of its lanes
// takes it; a single_lane split without views would leave view counts in KV, never in Cassandra.
function queuesUnconsumedViewFlushes(
	lanes: ReadonlyArray<WorkerLaneDefinition>,
	cronSchedulerEnabled: boolean,
): boolean {
	return cronSchedulerEnabled && !lanes.some((lane) => lane.taskTypes.includes('flushFeedViewCounterSlice'));
}

function validateLaneCompleteness(registeredTasks: Record<string, unknown>): void {
	const registeredTaskNames = new Set(Object.keys(registeredTasks));
	const laneTaskNames = new Set<string>(WORKER_LANES.flatMap<string>((lane) => [...lane.taskTypes]));
	const missingFromLanes = [...registeredTaskNames].filter((task) => !laneTaskNames.has(task));
	const missingFromRegistry = [...laneTaskNames].filter((task) => !registeredTaskNames.has(task));
	const errors: Array<string> = [];
	if (missingFromLanes.length > 0) {
		errors.push(`Registered tasks not assigned to any lane: ${missingFromLanes.join(', ')}`);
	}
	if (missingFromRegistry.length > 0) {
		errors.push(`Lane tasks not found in registry: ${missingFromRegistry.join(', ')}`);
	}
	const retiredCollisions = WORKER_LANES.flatMap<string>((lane) => [...lane.retiredTaskTypes]).filter((task) =>
		registeredTaskNames.has(task),
	);
	if (retiredCollisions.length > 0) {
		errors.push(`Retired tasks registered again: ${retiredCollisions.join(', ')}`);
	}
	if (errors.length > 0) {
		throw new Error(`Worker lane configuration mismatch:\n${errors.join('\n')}`);
	}
}

export function findLaneForTask(taskName: string): APIWorkerLaneName | null {
	for (const [laneName, lane] of Object.entries(LANE_CONFIG) as Array<[APIWorkerLaneName, LaneSettings]>) {
		if ((lane.tasks as ReadonlyArray<string>).includes(taskName)) return laneName;
	}
	return null;
}

export type {WorkerLaneDefinition};
export {
	queuesUnconsumedPurgeRuns,
	queuesUnconsumedViewFlushes,
	resolveCronSchedulerEnabled,
	resolveWorkerLanes,
	validateLaneCompleteness,
	WORKER_LANES,
};

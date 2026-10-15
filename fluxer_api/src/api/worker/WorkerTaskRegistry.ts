// SPDX-License-Identifier: AGPL-3.0-or-later

import aggregateFeedNotification from '@app/api/worker/tasks/AggregateFeedNotification';
import applicationProcessDeletion from '@app/api/worker/tasks/ApplicationProcessDeletion';
import applyMicupBotAutomodAction from '@app/api/worker/tasks/ApplyMicupBotAutomodAction';
import applyMicupBotReactionRole from '@app/api/worker/tasks/ApplyMicupBotReactionRole';
import assignPioneerBadge from '@app/api/worker/tasks/AssignPioneerBadge';
import backfillGuildBoosts from '@app/api/worker/tasks/admin_bulk/BackfillGuildBoosts';
import bulkAddGuildMembers from '@app/api/worker/tasks/admin_bulk/BulkAddGuildMembers';
import bulkBanFileShas from '@app/api/worker/tasks/admin_bulk/BulkBanFileShas';
import bulkDeleteMessagesForUsers from '@app/api/worker/tasks/admin_bulk/BulkDeleteMessagesForUsers';
import bulkScheduleUserDeletion from '@app/api/worker/tasks/admin_bulk/BulkScheduleUserDeletion';
import bulkUpdateGuildFeatures from '@app/api/worker/tasks/admin_bulk/BulkUpdateGuildFeatures';
import bulkUpdateUserFlags from '@app/api/worker/tasks/admin_bulk/BulkUpdateUserFlags';
import backfillEarlyPlusBadges from '@app/api/worker/tasks/BackfillEarlyPlusBadges';
import backfillFeedSuggestionRanking from '@app/api/worker/tasks/BackfillFeedSuggestionRanking';
import backfillPioneerBadges from '@app/api/worker/tasks/BackfillPioneerBadges';
import backfillReferralTier from '@app/api/worker/tasks/BackfillReferralTier';
import batchGuildAuditLogMessageDeletes from '@app/api/worker/tasks/BatchGuildAuditLogMessageDeletes';
import bulkDeleteSelfMessagesImmediate from '@app/api/worker/tasks/BulkDeleteSelfMessagesImmediate';
import bulkDeleteUserMessages from '@app/api/worker/tasks/BulkDeleteUserMessages';
import clearAuthenticatedReporterEmails from '@app/api/worker/tasks/ClearAuthenticatedReporterEmails';
import crosspostMessage from '@app/api/worker/tasks/CrosspostMessage';
import crosspostMessageChunk from '@app/api/worker/tasks/CrosspostMessageChunk';
import deleteFeedVideo from '@app/api/worker/tasks/DeleteFeedVideo';
import deleteUserMessagesInGuildByTime from '@app/api/worker/tasks/DeleteUserMessagesInGuildByTime';
import drainActivitySpool from '@app/api/worker/tasks/DrainActivitySpool';
import drainFeedVideoJobs from '@app/api/worker/tasks/DrainFeedVideoJobs';
import ensureUserPremium from '@app/api/worker/tasks/EnsureUserPremium';
import evaluateReferral from '@app/api/worker/tasks/EvaluateReferral';
import expireAttachments from '@app/api/worker/tasks/ExpireAttachments';
import expireReportSnapshots from '@app/api/worker/tasks/ExpireReportSnapshots';
import expireStaleJobs from '@app/api/worker/tasks/ExpireStaleJobs';
import extractEmbeds from '@app/api/worker/tasks/ExtractEmbeds';
import extractFeedPostEmbeds from '@app/api/worker/tasks/ExtractFeedPostEmbeds';
import fanoutFeedPost from '@app/api/worker/tasks/FanoutFeedPost';
import flushCounters from '@app/api/worker/tasks/FlushCounters';
import flushFeedViewCounterSlice from '@app/api/worker/tasks/FlushFeedViewCounterSlice';
import flushFeedViewCounters from '@app/api/worker/tasks/FlushFeedViewCounters';
import flushMicupBotXp from '@app/api/worker/tasks/FlushMicupBotXp';
import flushMicupBotXpSlice from '@app/api/worker/tasks/FlushMicupBotXpSlice';
import flushUserActivityBuffer from '@app/api/worker/tasks/FlushUserActivityBuffer';
import grantReferralRewards from '@app/api/worker/tasks/GrantReferralRewards';
import guildProcessDeletion from '@app/api/worker/tasks/GuildProcessDeletion';
import handleMentionChunk from '@app/api/worker/tasks/HandleMentionChunk';
import handleMentions from '@app/api/worker/tasks/HandleMentions';
import handleMicupBotLevelUp from '@app/api/worker/tasks/HandleMicupBotLevelUp';
import handleMicupBotMemberEvent from '@app/api/worker/tasks/HandleMicupBotMemberEvent';
import harvestGuildData from '@app/api/worker/tasks/HarvestGuildData';
import harvestUserData from '@app/api/worker/tasks/HarvestUserData';
import indexChannelMessages from '@app/api/worker/tasks/IndexChannelMessages';
import indexGuildMembers from '@app/api/worker/tasks/IndexGuildMembers';
import keepFeedVideoEvidence from '@app/api/worker/tasks/KeepFeedVideoEvidence';
import liftExpiredGuildInvitePauses from '@app/api/worker/tasks/LiftExpiredGuildInvitePauses';
import messageShred from '@app/api/worker/tasks/MessageShred';
import pollAppStoreNotificationHistory from '@app/api/worker/tasks/PollAppStoreNotificationHistory';
import pollGooglePlayVoidedPurchases from '@app/api/worker/tasks/PollGooglePlayVoidedPurchases';
import processAppStoreNotification from '@app/api/worker/tasks/ProcessAppStoreNotification';
import processAssetDeletionQueue from '@app/api/worker/tasks/ProcessAssetDeletionQueue';
import processCachePurgeQueue from '@app/api/worker/tasks/ProcessCachePurgeQueue';
import processExpiredPremiumSweep from '@app/api/worker/tasks/ProcessExpiredPremiumSweep';
import processFeedVideoWebhook from '@app/api/worker/tasks/ProcessFeedVideoWebhook';
import processGooglePlayNotification from '@app/api/worker/tasks/ProcessGooglePlayNotification';
import processGuildEntitlementExpirations from '@app/api/worker/tasks/ProcessGuildEntitlementExpirations';
import processInactivityDeletions from '@app/api/worker/tasks/ProcessInactivityDeletions';
import processPendingBulkMessageDeletions from '@app/api/worker/tasks/ProcessPendingBulkMessageDeletions';
import processPremiumExpirations from '@app/api/worker/tasks/ProcessPremiumExpirations';
import processPremiumStateReconciliationQueue from '@app/api/worker/tasks/ProcessPremiumStateReconciliationQueue';
import processReferralChecks from '@app/api/worker/tasks/ProcessReferralChecks';
import processStorePurchaseRefreshQueue from '@app/api/worker/tasks/ProcessStorePurchaseRefreshQueue';
import processStripeWebhook from '@app/api/worker/tasks/ProcessStripeWebhook';
import processTableGameTimers from '@app/api/worker/tasks/ProcessTableGameTimers';
import processUserDeletionHook from '@app/api/worker/tasks/ProcessUserDeletionHook';
import propagatePartialUserChange from '@app/api/worker/tasks/PropagatePartialUserChange';
import prunePostgresKvTtl from '@app/api/worker/tasks/PrunePostgresKvTtl';
import queueGuildRosterSlots from '@app/api/worker/tasks/QueueGuildRosterSlots';
import queueMicupBotVoiceSlots from '@app/api/worker/tasks/QueueMicupBotVoiceSlots';
import rebuildCounter from '@app/api/worker/tasks/RebuildCounter';
import rebuildMicupBotLeaderboard from '@app/api/worker/tasks/RebuildMicupBotLeaderboard';
import recomputeGuildBoost from '@app/api/worker/tasks/RecomputeGuildBoost';
import reconcileAttachmentDecay from '@app/api/worker/tasks/ReconcileAttachmentDecay';
import reconcileFeedVideoBucket from '@app/api/worker/tasks/ReconcileFeedVideoBucket';
import reconcileFeedVideos from '@app/api/worker/tasks/ReconcileFeedVideos';
import reconcileShopOrders from '@app/api/worker/tasks/ReconcileShopOrders';
import reconcileUserPayments from '@app/api/worker/tasks/ReconcileUserPayments';
import refreshFeedDiscover from '@app/api/worker/tasks/RefreshFeedDiscover';
import refreshFeedSuggestions from '@app/api/worker/tasks/RefreshFeedSuggestions';
import refreshSearchIndex from '@app/api/worker/tasks/RefreshSearchIndex';
import refreshStorePurchase from '@app/api/worker/tasks/RefreshStorePurchase';
import reindexUserGuildMembers from '@app/api/worker/tasks/ReindexUserGuildMembers';
import removeBlockedFollows from '@app/api/worker/tasks/RemoveBlockedFollows';
import removeChannelFollowers from '@app/api/worker/tasks/RemoveChannelFollowers';
import removeMemberBoosts from '@app/api/worker/tasks/RemoveMemberBoosts';
import renderGuildRosterMessage from '@app/api/worker/tasks/RenderGuildRosterMessage';
import resetPremiumPerkSanitization from '@app/api/worker/tasks/ResetPremiumPerkSanitization';
import runGuildRosterSlots from '@app/api/worker/tasks/RunGuildRosterSlots';
import runMicupBotCommand from '@app/api/worker/tasks/RunMicupBotCommand';
import runMicupBotVoiceSlots from '@app/api/worker/tasks/RunMicupBotVoiceSlots';
import scanFeedVideo from '@app/api/worker/tasks/ScanFeedVideo';
import seedThreadPermissions from '@app/api/worker/tasks/SeedThreadPermissions';
import {sendSystemDm} from '@app/api/worker/tasks/SendSystemDm';
import syncCrosspostCopies from '@app/api/worker/tasks/SyncCrosspostCopies';
import syncCrosspostedMessage from '@app/api/worker/tasks/SyncCrosspostedMessage';
import syncDiscoveryIndex from '@app/api/worker/tasks/SyncDiscoveryIndex';
import syncFileShaBlocklists from '@app/api/worker/tasks/SyncFileShaBlocklists';
import syncGuildRosterReaction from '@app/api/worker/tasks/SyncGuildRosterReaction';
import syncStripeCustomerEmail from '@app/api/worker/tasks/SyncStripeCustomerEmail';
import syncUrlBlocklists from '@app/api/worker/tasks/SyncUrlBlocklists';
import {
	archiveInactiveThreads,
	deleteChannelThreads,
	removeThreadMembershipsForGuildMember,
	repairThreadIndexes,
} from '@app/api/worker/tasks/ThreadMaintenanceTasks';
import {backfillThreadSearch, syncThreadSearchDocument} from '@app/api/worker/tasks/ThreadSearchTasks';
import {
	cleanupUsernameDictionary,
	processUsernameRepair,
	scanUsernameMigration,
} from '@app/api/worker/tasks/UsernameWorkerTasks';
import userProcessPendingDeletion from '@app/api/worker/tasks/UserProcessPendingDeletion';
import userProcessPendingDeletions from '@app/api/worker/tasks/UserProcessPendingDeletions';
import verifyShopOrder from '@app/api/worker/tasks/VerifyShopOrder';
import type {WorkerTaskName} from '@app/api/worker/WorkerLaneConfig';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';

export const workerTasks: Record<WorkerTaskName, WorkerTaskHandler> = {
	reindexUserGuildMembers,
	processUsernameRepair,
	scanUsernameMigration,
	cleanupUsernameDictionary,
	aggregateFeedNotification,
	applicationProcessDeletion,
	assignPioneerBadge,
	backfillPioneerBadges,
	backfillEarlyPlusBadges,
	archiveInactiveThreads,
	deleteChannelThreads,
	removeThreadMembershipsForGuildMember,
	repairThreadIndexes,
	syncThreadSearchDocument,
	backfillThreadSearch,
	batchGuildAuditLogMessageDeletes,
	bulkAddGuildMembers: bulkAddGuildMembers,
	bulkBanFileShas: bulkBanFileShas,
	bulkDeleteMessagesForUsers: bulkDeleteMessagesForUsers,
	bulkDeleteSelfMessagesImmediate,
	bulkDeleteUserMessages,
	bulkScheduleUserDeletion: bulkScheduleUserDeletion,
	bulkUpdateGuildFeatures: bulkUpdateGuildFeatures,
	backfillGuildBoosts,
	bulkUpdateUserFlags: bulkUpdateUserFlags,
	clearAuthenticatedReporterEmails,
	crosspostMessage,
	crosspostMessageChunk,
	deleteUserMessagesInGuildByTime,
	ensureUserPremium,
	drainActivitySpool,
	expireAttachments,
	expireReportSnapshots,
	expireStaleJobs,
	extractEmbeds,
	extractFeedPostEmbeds,
	fanoutFeedPost,
	guildProcessDeletion,
	handleMentions,
	handleMentionChunk,
	harvestGuildData,
	harvestUserData,
	indexChannelMessages,
	indexGuildMembers,
	liftExpiredGuildInvitePauses,
	messageShred,
	processAssetDeletionQueue,
	processCachePurgeQueue,
	processStripeWebhook,
	processExpiredPremiumSweep,
	processGuildEntitlementExpirations,
	processInactivityDeletions,
	processPendingBulkMessageDeletions,
	processPremiumExpirations,
	processPremiumStateReconciliationQueue,
	processUserDeletionHook,
	propagatePartialUserChange,
	reconcileShopOrders,
	reconcileAttachmentDecay,
	reconcileUserPayments,
	removeBlockedFollows,
	removeMemberBoosts,
	resetPremiumPerkSanitization,
	processAppStoreNotification,
	processGooglePlayNotification,
	refreshStorePurchase,
	processStorePurchaseRefreshQueue,
	pollGooglePlayVoidedPurchases,
	pollAppStoreNotificationHistory,
	prunePostgresKvTtl,
	refreshSearchIndex,
	seedThreadPermissions,
	removeChannelFollowers,
	sendSystemDm,
	syncStripeCustomerEmail,
	syncFileShaBlocklists,
	syncUrlBlocklists,
	syncDiscoveryIndex,
	syncCrosspostCopies,
	syncCrosspostedMessage,
	flushUserActivityBuffer,
	flushCounters,
	rebuildCounter,
	refreshFeedDiscover,
	refreshFeedSuggestions,
	backfillFeedSuggestionRanking,
	processFeedVideoWebhook,
	scanFeedVideo,
	deleteFeedVideo,
	keepFeedVideoEvidence,
	reconcileFeedVideos,
	reconcileFeedVideoBucket,
	drainFeedVideoJobs,
	flushFeedViewCounters,
	flushFeedViewCounterSlice,
	recomputeGuildBoost,
	userProcessPendingDeletion,
	userProcessPendingDeletions,
	verifyShopOrder,
	processReferralChecks,
	renderGuildRosterMessage,
	syncGuildRosterReaction,
	runGuildRosterSlots,
	queueGuildRosterSlots,
	runMicupBotCommand,
	handleMicupBotMemberEvent,
	applyMicupBotAutomodAction,
	handleMicupBotLevelUp,
	applyMicupBotReactionRole,
	flushMicupBotXpSlice,
	rebuildMicupBotLeaderboard,
	queueMicupBotVoiceSlots,
	runMicupBotVoiceSlots,
	flushMicupBotXp,

	evaluateReferral,
	grantReferralRewards,
	backfillReferralTier,
	processTableGameTimers,
};

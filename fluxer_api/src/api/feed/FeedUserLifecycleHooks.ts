// SPDX-License-Identifier: AGPL-3.0-or-later

import {DISCOVER_HIDDEN_AUTHOR_FLAGS} from '@app/api/feed/discover/FeedDiscoverRules';
import {
	getFeedDiscoverRepository,
	getFeedInteractionService,
	getFeedNotificationService,
	getFeedPostService,
	getFeedRepository,
	getFeedTrendService,
	getFeedVideoService,
	getUserCacheService,
} from '@app/api/middleware/ServiceSingletons';
import {
	registerUserAccountWriteHook,
	registerUserBannedHook,
	registerUserBlockedHook,
	registerUserDeletionHook,
	registerUserHarvestHook,
	registerUserPairChangedHook,
} from '@app/api/user/lifecycle/UserLifecycleHooks';

// One 'feed' hook each for account deletion (lifecycle lane, retried, idempotent), the data export (feed.json), a block,
// an account write and a permanent ban. A block removes the follows both ways and home feeds keep only authors
// the reader follows, but that removal can fail and wait for its retry job, so the block hook also drops the two home
// verdicts (feed:access:); the notification inbox leaves out blocked accounts on read. Keşfet, which shows
// strangers: the block hook resets both accounts' Keşfet block sets, the write and ban hooks evict the author's posts.
export function registerFeedUserLifecycleHooks(): void {
	// Videos not yet posted go first (each to its Bunny delete job); posted ones go with their posts.
	registerUserDeletionHook('feed', async ({userId}) => {
		await getFeedVideoService().deleteUserVideos(userId);
		await getFeedPostService().deleteUserPosts(userId);
		await getFeedInteractionService().deleteUserInteractions(userId);
		await getFeedNotificationService().deleteUserNotifications(userId);
	});
	// A block marks both accounts' Keşfet block sets for 5 s: the next page recomputes them, and a set computed just
	// before the block cannot be written back over the mark.
	registerUserBlockedHook('feed', async ({userId, targetId}) => {
		await getFeedRepository().forgetAuthorAccess(userId, targetId);
		await getFeedDiscoverRepository().forgetBlockSets([userId, targetId]);
	});
	// A friendship, a request or a follow made or undone, either way, drops the two home verdicts too.
	registerUserPairChangedHook('feed', ({userId, targetId}) => getFeedRepository().forgetAuthorAccess(userId, targetId));
	// A permanent ban takes the account's posts out of every API process's Keşfet copy at once.
	registerUserBannedHook('feed', async ({userId}) => {
		await getFeedTrendService().evictAuthor(userId);
	});
	// A new flag that keeps an author off Keşfet (a timed ban, spammer, suspicious activity, self deletion) does the same
	// at once instead of at the next build. Most writes set no such bit: one bit test, no KV call.
	registerUserAccountWriteHook('feed', async ({previous, updated}) => {
		const added = (updated.flags ?? 0n) & ~(previous?.flags ?? 0n) & DISCOVER_HIDDEN_AUTHOR_FLAGS;
		if (added !== 0n) await getFeedTrendService().evictAuthor(updated.user_id);
		if ((previous?.content_hidden_since?.getTime() ?? null) !== (updated.content_hidden_since?.getTime() ?? null)) {
			await getUserCacheService().invalidateUserCache(updated.user_id);
		}
	});
	registerUserHarvestHook('feed', async ({userId}) => ({
		...(await getFeedPostService().exportUserPosts(userId)),
		...(await getFeedInteractionService().exportUserInteractions(userId)),
		notifications: await getFeedNotificationService().exportUserNotifications(userId),
		notification_read_state: await getFeedNotificationService().exportUserReadState(userId),
	}));
}

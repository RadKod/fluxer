// SPDX-License-Identifier: AGPL-3.0-or-later

import {Logger} from '@app/api/Logger';
import {getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {getFollowRepository, getFollowService} from '@app/api/middleware/ServiceSingletons';
import {
	registerUserBannedHook,
	registerUserBlockedHook,
	registerUserDeletionHook,
	registerUserHarvestHook,
} from '@app/api/user/lifecycle/UserLifecycleHooks';

// Account deletion settles every follow of and to the account in pages (idempotent, lifecycle lane); the data export
// lists the accounts it follows; a block removes the follows both ways, and when that fails the removeBlockedFollows
// job retries it, so blocking itself never fails.
export function registerFollowUserLifecycleHooks(): void {
	registerUserDeletionHook('follow', async ({userId}) => getFollowService().deleteUserFollows(userId));
	registerUserHarvestHook('follow', async ({userId}) => getFollowService().exportFollowing(userId));
	registerUserBlockedHook('follow', async ({userId, targetId}) => {
		try {
			await getFollowService().removeFollowsBetween(userId, targetId);
		} catch (error) {
			Logger.warn(
				{error, userId: userId.toString(), targetId: targetId.toString()},
				'Removing follows after a block failed; queued for retry',
			);
			await getWorkerService()
				.addJob('removeBlockedFollows', {userId: userId.toString(), targetId: targetId.toString()})
				.catch((queueError: unknown) =>
					Logger.error(
						{error: queueError, userId: userId.toString(), targetId: targetId.toString()},
						'Failed to queue removeBlockedFollows',
					),
				);
		}
	});
	// a permanent ban takes the account out of the follower ranking; the 'feed' ban hook already tells
	// every API process to drop it from Keşfet and the suggestions (FeedUserLifecycleHooks, author eviction). A later
	// flush may rank it again; the suggestion build drops permanently banned accounts too.
	registerUserBannedHook('follow', async ({userId}) => getFollowRepository().unrankFollowers([userId]));
}

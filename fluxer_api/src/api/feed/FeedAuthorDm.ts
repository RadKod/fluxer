// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {getContentMessage} from '@app/api/content_i18n/ContentI18n';
import {isHiddenFeedAuthor} from '@app/api/feed/FeedTimelineService';
import type {IUserRepository} from '@app/api/user/IUserRepository';
import type {WorkerTaskName} from '@app/api/worker/WorkerLaneConfig';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';

export type FeedAuthorDmKey =
	| 'feed.post_removed_by_moderator'
	| 'feed.comment_removed_by_moderator'
	| 'feed.video_failed'
	| 'feed.video_gone'
	| 'feed.video_too_large'
	| 'feed.video_rejected';

/**
 * A feed author learns of a removal or a failed video through a system DM in their locale; a deleted or disabled
 * (banned) account gets none.
 */
export async function sendFeedAuthorDm(
	deps: {users: Pick<IUserRepository, 'findUnique'>; worker: Pick<IWorkerService<WorkerTaskName>, 'addJob'>},
	authorId: UserID,
	key: FeedAuthorDmKey,
): Promise<void> {
	const author = await deps.users.findUnique(authorId);
	if (!author || isHiddenFeedAuthor(author)) return;
	await deps.worker.addJob(
		'sendSystemDm',
		{content: getContentMessage(key, author.locale), user_ids: [authorId.toString()]},
		{maxAttempts: 5},
	);
}

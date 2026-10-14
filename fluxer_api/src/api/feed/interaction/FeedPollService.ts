// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {FEED_POLL_VOTE_COUNT_COLUMNS, type FeedPostRow} from '@app/api/database/types/FeedTypes';
import {FEED_POLL_VOTE_COUNT_COUNTER} from '@app/api/feed/interaction/FeedInteractionCounters';
import type {FeedInteractionRepository} from '@app/api/feed/interaction/FeedInteractionRepository';
import type {KVCounterService} from '@app/api/infrastructure/KVCounterService';
import type {User} from '@app/api/models/User';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {ConflictError} from '@fluxer/errors/src/domains/core/ConflictError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import type {FeedPollCreateRequest} from '@fluxer/schema/src/domains/feed/FeedRequestSchemas';
import {snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';

const HOUR_MS = 3_600_000;

/**
 * The poll columns of a new post; it ends duration_hours after the post's snowflake time. Two options repeat when they
 * match after trim() and toLowerCase(), the composer's own check: no Turkish casing, so client and server never
 * disagree over I/ı and İ/i.
 */
export function pollColumnsFor(
	postId: bigint,
	poll: FeedPollCreateRequest,
): Pick<FeedPostRow, 'poll_options' | 'poll_expires_at'> {
	const keys = new Set(poll.options.map((option) => option.trim().toLowerCase()));
	if (keys.size !== poll.options.length) {
		throw InputValidationError.fromCode('poll.options', ValidationErrorCodes.INVALID_FORMAT);
	}
	return {
		poll_options: poll.options,
		poll_expires_at: new Date(snowflakeToDate(postId).getTime() + poll.duration_hours * HOUR_MS),
	};
}

// Single choice polls on feed posts: one vote per account, never changed or taken back; the author cannot vote. A vote
// is serialized per (post, account) by the counter subject lock and a read under it, as likes: no LWT on 16 partitions
// of a viral poll. The counter moves only when this call's own write or delete happened. Access is the controller's.
export class FeedPollService {
	constructor(private readonly deps: {repository: FeedInteractionRepository; kvCounterService: KVCounterService}) {}

	async vote(user: User, post: FeedPostRow, option: number, now = Date.now()): Promise<void> {
		const options = post.poll_options;
		if (!options || !post.poll_expires_at || option >= options.length) {
			throw InputValidationError.fromCode('option', ValidationErrorCodes.INVALID_FORMAT);
		}
		if (post.author_id === user.id) throw new MissingPermissionsError();
		if (post.poll_expires_at.getTime() <= now) {
			throw new ConflictError({code: APIErrorCodes.CONFLICT, message: 'The poll has ended'});
		}
		const {repository, kvCounterService} = this.deps;
		const counted = await kvCounterService.withSubjectLock(
			FEED_POLL_VOTE_COUNT_COUNTER,
			post.post_id.toString(),
			user.id.toString(),
			async () => {
				if ((await repository.getPollVote(user.id, post.post_id)) !== null) return false;
				await repository.putPollVote(user.id, post.post_id, option, new Date(now));
				await kvCounterService.add(FEED_POLL_VOTE_COUNT_COUNTER, `${post.post_id}:${option}`, 1);
				return true;
			},
		);
		if (!counted) throw new ConflictError({code: APIErrorCodes.CONFLICT, message: 'You already voted in this poll'});
	}

	/** Account deletion: takes the account's vote and its count off the post. Idempotent. */
	async removeVote(userId: UserID, postId: bigint): Promise<void> {
		const {repository, kvCounterService} = this.deps;
		await kvCounterService.withSubjectLock(
			FEED_POLL_VOTE_COUNT_COUNTER,
			postId.toString(),
			userId.toString(),
			async () => {
				const option = await repository.getPollVote(userId, postId);
				if (option === null) return;
				await repository.deletePollVote(userId, postId);
				await kvCounterService.add(FEED_POLL_VOTE_COUNT_COUNTER, `${postId}:${option}`, -1);
			},
		);
	}

	/** Votes per option for a page of posts (null without a poll), viewer-free: one KV read, the rows as fallback. */
	async getCounts(rows: Array<FeedPostRow>): Promise<Array<Array<number> | null>> {
		const polls = rows.filter((row) => row.poll_options);
		const ids = polls.flatMap((row) => row.poll_options!.map((_, index) => `${row.post_id}:${index}`));
		const bases = polls.flatMap((row) =>
			row.poll_options!.map((_, index) => row[FEED_POLL_VOTE_COUNT_COLUMNS[index]!] ?? 0),
		);
		const values =
			ids.length === 0 ? [] : await this.deps.kvCounterService.getMany(FEED_POLL_VOTE_COUNT_COUNTER, ids, bases);
		let cursor = 0;
		return rows.map((row) => (row.poll_options ? row.poll_options.map(() => Math.max(0, values[cursor++]!)) : null));
	}
}

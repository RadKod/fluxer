// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {type FeedPostRow, isPublicFeedPost} from '@app/api/database/types/FeedTypes';
import type {FeedDiscoverRepository} from '@app/api/feed/discover/FeedDiscoverRepository';
import {
	applyTrendFlush,
	feedPostHasVideo,
	isDiscoverAuthorEligible,
	isInTrendWindow,
	isTrendActorEligible,
	TREND_DAILY_CONTRIBUTIONS,
	TREND_DAILY_PER_AUTHOR,
	TREND_DAILY_REPORTS,
	TREND_REPORTS_TO_HIDE,
	TREND_WEIGHTS,
	type TrendAccount,
} from '@app/api/feed/discover/FeedDiscoverRules';
import {feedDayAt} from '@app/api/feed/FeedRepository';
import type {CounterFlusher, KVCounterService} from '@app/api/infrastructure/KVCounterService';
import {Logger} from '@app/api/Logger';

export const FEED_TREND_COUNTER = 'feed_post_trend';

// The weight multiplier a reaction counts with; 0 means it does not count.
type Gate = (repository: FeedDiscoverRepository) => Promise<number>;

interface FeedTrendServiceDeps {
	repository: FeedDiscoverRepository;
	kvCounterService: KVCounterService;
}

// Keşfet's reaction signal: public posts in their first 72 hours only, clean accounts at least 72 hours old, at
// most 300 contributions an account a day. Best effort: a failure is logged and never fails the like, comment, vote,
// report or post behind it.
export class FeedTrendService {
	constructor(private readonly deps: FeedTrendServiceDeps) {}

	recordPostCreated(author: TrendAccount, post: FeedPostRow, now = Date.now()): Promise<void> {
		return this.safely(async () => {
			if (!isPublicFeedPost(post) || !isDiscoverAuthorEligible(author, now, {hasVideo: feedPostHasVideo(post)})) return;
			await this.deps.kvCounterService.add(FEED_TREND_COUNTER, post.post_id.toString(), TREND_WEIGHTS.post);
		});
	}

	/** +4 (×16 when sampled past the cap) only for a like newly counted, the same back only for a counted one. */
	recordLike(actor: TrendAccount, post: FeedPostRow, direction: 1 | -1, now = Date.now()): Promise<void> {
		return this.contribute(actor, post, direction * TREND_WEIGHTS.like, now, (repository) =>
			direction === 1
				? repository.addLiker(post.post_id, actor.id, now)
				: repository.removeLiker(post.post_id, actor.id),
		);
	}

	recordComment(actor: TrendAccount, post: FeedPostRow, now = Date.now()): Promise<void> {
		return this.contribute(actor, post, TREND_WEIGHTS.firstComment, now, async (repository) =>
			(await repository.addCommenter(post.post_id, actor.id, now)) ? 1 : 0,
		);
	}

	recordPollVote(actor: TrendAccount, post: FeedPostRow, now = Date.now()): Promise<void> {
		return this.contribute(actor, post, TREND_WEIGHTS.pollVote, now);
	}

	/**
	 * Only reporters who could also move the trend count toward hiding a post, and each counted report spends
	 * one of the reporter's 10 daily reports, apart from the 300 reactions, so a few accounts cannot empty Keşfet; a busy post needs one reporter per 1000 counted likers, at least three. A post a
	 * moderator restored is not hidden again for 72 hours. A post past its 72 h window is off Keşfet already.
	 */
	recordReport(reporter: TrendAccount, post: FeedPostRow, now = Date.now()): Promise<void> {
		return this.safely(async () => {
			const {repository} = this.deps;
			if (!isPublicFeedPost(post) || !isInTrendWindow(post.post_id, now)) return;
			if (!isTrendActorEligible(reporter, now)) return;
			if ((await repository.countReport(reporter.id, feedDayAt(now))) > TREND_DAILY_REPORTS) return;
			const reports = await repository.addReporter(post.post_id, reporter.id, now);
			const needed = Math.max(TREND_REPORTS_TO_HIDE, Math.ceil((await repository.countLikers(post.post_id)) / 1000));
			if (reports < needed || (await repository.isRestored(post.post_id))) return;
			// Evicted once, when hidden: later reports of a hidden post broadcast nothing.
			if (await repository.hidePost(post.post_id)) await this.evict(post.post_id);
		});
	}

	/** The moderator's undo of a report hide (admin route): back in the ranking, not hidden again for 72 hours. */
	restorePost(postId: bigint): Promise<void> {
		return this.deps.repository.restorePost(postId);
	}

	/** Only posts Keşfet could still show (public, first 72 hours): account deletion stays at ~150 messages at most. */
	evictPost(post: Pick<FeedPostRow, 'post_id' | 'flags'>, now = Date.now()): Promise<void> {
		return this.safely(async () => {
			if (isPublicFeedPost(post) && isInTrendWindow(post.post_id, now)) await this.evict(post.post_id);
		});
	}

	evictAuthor(userId: UserID): Promise<void> {
		return this.safely(() => this.deps.repository.publishEvict('author', userId.toString()));
	}

	// Eligibility, then the daily allowances (spent even when the gate says no, so like/unlike loops burn them), then the
	// gate. The per-author allowance comes before the gate so a like it refuses never enters the counted likers (an unlike
	// would then take back what never counted), and it never holds back taking back a counted like.
	private contribute(actor: TrendAccount, post: FeedPostRow, weight: number, now: number, gate?: Gate): Promise<void> {
		return this.safely(async () => {
			const {repository, kvCounterService} = this.deps;
			if (!isPublicFeedPost(post) || !isInTrendWindow(post.post_id, now)) return;
			if (actor.id === post.author_id || !isTrendActorEligible(actor, now)) return;
			const day = feedDayAt(now);
			if ((await repository.countContribution(actor.id, day)) > TREND_DAILY_CONTRIBUTIONS) return;
			if (
				weight > 0 &&
				(await repository.countAuthorContribution(actor.id, post.author_id, day, now)) > TREND_DAILY_PER_AUTHOR
			) {
				return;
			}
			const multiplier = gate ? await gate(repository) : 1;
			if (multiplier === 0) return;
			await kvCounterService.add(FEED_TREND_COUNTER, post.post_id.toString(), weight * multiplier);
		});
	}

	private async evict(postId: bigint): Promise<void> {
		await this.deps.repository.unrankPost(postId);
		await this.deps.repository.publishEvict('post', postId.toString());
	}

	private async safely(work: () => Promise<void>): Promise<void> {
		try {
			await work();
		} catch (error) {
			Logger.warn({error}, 'Recording a Keşfet trend signal failed');
		}
	}
}

// The counter holds the post's weighted reactions; the flush turns growth above the high-water mark into score. No
// Cassandra write: the state is temporary (72 h) like the ranking.
// TEMPORARY: shared flush budget: this namespace flushes inside flushCounters' 8 s budget with every other
// counter. Trigger: the FlushCounters "whole 8 s budget" warning. Path: its own cron with its own dirty-set prefix.
export function createFeedTrendCounterFlusher(
	repository: FeedDiscoverRepository,
	now: () => number = Date.now,
): CounterFlusher {
	return {
		namespace: FEED_TREND_COUNTER,
		async readBase(id) {
			return (await repository.getTrendState(BigInt(id)))?.v ?? 0;
		},
		// Ranking first, then the state: a failed ZADD leaves the high-water mark where it was, so the next flush ranks the
		// post again; a failed state write after it only repeats the same ZADD (a score is set, never added).
		async flush(id, value) {
			const postId = BigInt(id);
			const {state, ranked} = applyTrendFlush(await repository.getTrendState(postId), value, now());
			if (ranked && state.L !== null) await repository.rankPost(postId, state.L);
			await repository.putTrendState(postId, state);
		},
		// No source to count from; a reconcile that guessed would drop reactions not flushed yet.
		async recount() {
			throw new Error('feed_post_trend has no recount source; its flush keeps a high-water mark instead');
		},
	};
}

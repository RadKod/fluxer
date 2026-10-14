// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import type {FeedNotificationService} from '@app/api/feed/notification/FeedNotificationService';
import {FOLLOWER_COUNT_COUNTER, FOLLOWING_COUNT_COUNTER} from '@app/api/follow/FollowCounters';
import type {FollowRepository} from '@app/api/follow/FollowRepository';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {ISnowflakeService} from '@app/api/infrastructure/ISnowflakeService';
import type {KVCounterService} from '@app/api/infrastructure/KVCounterService';
import type {UserCacheService} from '@app/api/infrastructure/UserCacheService';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {resolveLimitSafe} from '@app/api/limits/LimitConfigUtils';
import {createLimitMatchContext} from '@app/api/limits/LimitMatchContextBuilder';
import type {RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import type {User} from '@app/api/models/User';
import type {IUserRepository} from '@app/api/user/IUserRepository';
import type {ProfileExtension} from '@app/api/user/profile/ProfileExtensionProviders';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import {RelationshipTypes} from '@fluxer/constants/src/UserConstants';
import {MissingAccessError} from '@fluxer/errors/src/domains/core/MissingAccessError';
import {MaxFollowingError} from '@fluxer/errors/src/domains/user/MaxFollowingError';
import {DEFAULT_FREE_LIMITS} from '@fluxer/limits/src/LimitDefaults';
import type {FollowListResponse} from '@fluxer/schema/src/domains/follow/FollowResponseSchemas';
import {snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';

const DELETION_PAGE_SIZE = 500;
const DELETION_CONCURRENCY = 16;

interface FollowServiceDeps {
	repository: FollowRepository;
	userRepository: IUserRepository;
	userCacheService: UserCacheService;
	gatewayService: IGatewayService;
	kvCounterService: KVCounterService;
	limitConfigService: LimitConfigService;
	snowflakeService: ISnowflakeService;
	notificationService: FeedNotificationService;
}

// Access (Fluxer's profile rule) is checked by the caller; this service owns the rows, counters and events.
// Counters move by ±1 only when this call's own conditional write on user_following applied (KV counters).
export class FollowService {
	constructor(readonly deps: FollowServiceDeps) {}

	async follow({user, target, requestCache}: {user: User; target: User; requestCache: RequestCache}): Promise<void> {
		const {repository, kvCounterService} = this.deps;
		if (user.id === target.id || target.isBot || target.isSystem) {
			throw new MissingAccessError();
		}
		await this.assertNotBlocked(user.id, target.id);
		const existing = await repository.getFollow(user.id, target.id);
		if (existing) {
			// Already following: finish the follower row a failed earlier attempt may have left out.
			await this.settleFollowerRow(user.id, target.id, existing.follow_id);
			return;
		}
		const followId = await this.deps.snowflakeService.generate();
		if (!(await repository.insertFollowing({user_id: user.id, target_id: target.id, follow_id: followId}))) {
			return;
		}
		const [following] = await Promise.all([
			kvCounterService.add(FOLLOWING_COUNT_COUNTER, user.id.toString(), 1),
			kvCounterService.add(FOLLOWER_COUNT_COUNTER, target.id.toString(), 1),
		]);
		const maxFollowing = this.resolveMaxFollowing(user);
		if (following > maxFollowing) {
			await this.dropFollow(user.id, target.id, followId);
			throw new MaxFollowingError(maxFollowing);
		}
		await this.settleFollowerRow(user.id, target.id, followId);
		// A block written between the check above and the insert is caught here; one written after this read finds
		// the follow row and removes it in the block hook.
		try {
			await this.assertNotBlocked(user.id, target.id);
		} catch (error) {
			await this.dropFollow(user.id, target.id, followId);
			throw error;
		}
		await this.deps.gatewayService.dispatchPresence({
			userId: user.id,
			event: 'FOLLOW_CREATE',
			data: {
				id: followId.toString(),
				user: await this.deps.userCacheService.getUserPartialResponse(target.id, requestCache),
			},
		});
		await this.deps.notificationService.record({
			recipientId: target.id,
			actorId: user.id,
			type: 'follow',
			postId: null,
		});
	}

	/** Ends `userId` following `targetId`; used for unfollow, removing a follower and blocks. Idempotent. */
	async removeFollow(userId: UserID, targetId: UserID): Promise<void> {
		const row = await this.deps.repository.getFollow(userId, targetId);
		if (!row || !(await this.dropFollow(userId, targetId, row.follow_id))) return;
		await this.deps.gatewayService.dispatchPresence({
			userId,
			event: 'FOLLOW_DELETE',
			data: {user_id: targetId.toString()},
		});
	}

	async removeFollowsBetween(userId: UserID, targetId: UserID): Promise<void> {
		await Promise.all([this.removeFollow(userId, targetId), this.removeFollow(targetId, userId)]);
	}

	async assertNotBlocked(userId: UserID, targetId: UserID): Promise<void> {
		const {userRepository} = this.deps;
		const [blocked, blockedBy] = await Promise.all([
			userRepository.getRelationship(userId, targetId, RelationshipTypes.BLOCKED),
			userRepository.getRelationship(targetId, userId, RelationshipTypes.BLOCKED),
		]);
		if (blocked || blockedBy) {
			throw new MissingAccessError();
		}
	}

	async listFollowers(
		targetId: UserID,
		options: {before?: bigint; limit: number},
		requestCache: RequestCache,
		viewerId: UserID,
	): Promise<FollowListResponse> {
		const rows = await this.deps.repository.listFollowers(targetId, options);
		return this.toFollowList(
			rows.map((row) => [row.follow_id, row.user_id]),
			requestCache,
			viewerId,
		);
	}

	async listFollowing(
		userId: UserID,
		options: {after?: UserID; limit: number},
		requestCache: RequestCache,
		viewerId: UserID,
	): Promise<FollowListResponse> {
		const rows = await this.deps.repository.listFollowing(userId, options);
		return this.toFollowList(
			rows.map((row) => [row.follow_id, row.target_id]),
			requestCache,
			viewerId,
		);
	}

	async getProfileFields(userId: UserID, viewerId: UserID): Promise<ProfileExtension> {
		const {kvCounterService, repository} = this.deps;
		const [followerCount, followingCount, follow] = await Promise.all([
			kvCounterService.get(FOLLOWER_COUNT_COUNTER, userId.toString()),
			kvCounterService.get(FOLLOWING_COUNT_COUNTER, userId.toString()),
			viewerId === userId ? null : repository.getFollow(viewerId, userId),
		]);
		return {
			follower_count: Math.max(0, followerCount),
			following_count: Math.max(0, followingCount),
			is_following: viewerId === userId ? undefined : follow !== null,
		};
	}

	/**
	 * Account deletion (lifecycle lane, retried until done): settles every follow of and to the account in pages, then
	 * drops its follower partitions. Rerunning skips what an earlier run settled, since each removal is conditional.
	 */
	async deleteUserFollows(userId: UserID): Promise<void> {
		const {repository, kvCounterService} = this.deps;
		let after: UserID | undefined;
		for (;;) {
			const page = await repository.listFollowing(userId, {after, limit: DELETION_PAGE_SIZE});
			await mapWithConcurrency(page, DELETION_CONCURRENCY, async (row) => {
				if (await repository.deleteFollowing(userId, row.target_id, row.follow_id)) {
					await kvCounterService.add(FOLLOWER_COUNT_COUNTER, row.target_id.toString(), -1);
				}
				await repository.deleteFollower(row.target_id, row.follow_id);
			});
			if (page.length < DELETION_PAGE_SIZE) break;
			after = page.at(-1)!.target_id;
		}
		let before: bigint | undefined;
		for (;;) {
			const page = await repository.listFollowers(userId, {before, limit: DELETION_PAGE_SIZE});
			if (page.length === 0) break;
			await mapWithConcurrency(page, DELETION_CONCURRENCY, async (row) => {
				if (await repository.deleteFollowing(row.user_id, userId, row.follow_id)) {
					await kvCounterService.add(FOLLOWING_COUNT_COUNTER, row.user_id.toString(), -1);
				}
			});
			before = page.at(-1)!.follow_id;
		}
		await repository.deleteFollowerData(userId);
	}

	async exportFollowing(userId: UserID): Promise<{following: Array<{user_id: string; followed_at: string}>}> {
		const following: Array<{user_id: string; followed_at: string}> = [];
		let after: UserID | undefined;
		for (;;) {
			const page = await this.deps.repository.listFollowing(userId, {after, limit: DELETION_PAGE_SIZE});
			following.push(
				...page.map((row) => ({
					user_id: row.target_id.toString(),
					followed_at: snowflakeToDate(row.follow_id).toISOString(),
				})),
			);
			if (page.length < DELETION_PAGE_SIZE) return {following};
			after = page.at(-1)!.target_id;
		}
	}

	/** Removes one follow if this call's conditional delete applies; counters and the follower row follow it. */
	private async dropFollow(userId: UserID, targetId: UserID, followId: bigint): Promise<boolean> {
		const {repository, kvCounterService} = this.deps;
		if (!(await repository.deleteFollowing(userId, targetId, followId))) return false;
		await Promise.all([
			kvCounterService.add(FOLLOWING_COUNT_COUNTER, userId.toString(), -1),
			kvCounterService.add(FOLLOWER_COUNT_COUNTER, targetId.toString(), -1),
			repository.deleteFollower(targetId, followId),
		]);
		return true;
	}

	// The follower row is written after the follow row, so an unfollow that deletes it first could leave it behind;
	// reading the follow row again afterwards removes such a stray row.
	private async settleFollowerRow(userId: UserID, targetId: UserID, followId: bigint): Promise<void> {
		const {repository} = this.deps;
		await repository.putFollower(targetId, followId, userId);
		const current = await repository.getFollow(userId, targetId);
		if (current?.follow_id !== followId) {
			await repository.deleteFollower(targetId, followId);
		}
	}

	private resolveMaxFollowing(user: User): number {
		return resolveLimitSafe(
			this.deps.limitConfigService.getConfigSnapshot(),
			createLimitMatchContext({user}),
			'max_following',
			DEFAULT_FREE_LIMITS.max_following,
		);
	}

	// each row says whether the caller follows it, from the caller's 60 s following list (one KV read
	// a page); never an access check or a follow read per row (N+1). The caller's own row says nothing.
	private async toFollowList(
		entries: Array<[followId: bigint, userId: UserID]>,
		requestCache: RequestCache,
		viewerId: UserID,
	): Promise<FollowListResponse> {
		const [users, following] = await Promise.all([
			this.deps.userCacheService.getUserPartialResponses(
				entries.map(([, userId]) => userId),
				requestCache,
			),
			this.deps.repository.getFollowingIds(viewerId).then((ids) => new Set(ids)),
		]);
		return entries.map(([followId, userId]) => ({
			id: followId.toString(),
			user: users.get(userId)!,
			is_following: userId === viewerId ? undefined : following.has(userId),
		}));
	}
}

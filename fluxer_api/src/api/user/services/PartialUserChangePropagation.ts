// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import type {GuildID, UserID} from '@app/api/BrandedTypes';
import {mapGuildMemberToResponse} from '@app/api/guild/GuildModel';
import type {IGuildRepositoryAggregate} from '@app/api/guild/repositories/IGuildRepositoryAggregate';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {UserCacheService} from '@app/api/infrastructure/UserCacheService';
import type {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {Logger} from '@app/api/Logger';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {getKVClient, getWorkerService} from '@app/api/middleware/ServiceRegistry';
import type {User} from '@app/api/models/User';
import {updateUserCache} from '@app/api/user/UserCacheHelpers';
import {hasPartialUserFieldsChanged} from '@app/api/user/UserMappers';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import {USERNAME_CAPACITY_LIMITS} from '@app/api/worker/tasks/UsernameCapacityMonitor';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

const DIRTY_TTL_SECONDS = 3600;
const QUEUED_TTL_SECONDS = 60;
const GUILD_DISPATCH_CONCURRENCY = 8;
// Above the worker's 12 s read timeout, so one slow read between renewals cannot let the lock run out.
const LOCK_TTL_SECONDS = 30;
const LOCK_EXTEND_INTERVAL_MS = 10_000;

function dirtyKey(userId: UserID): string {
	return `propagate:dirty:{${userId}}`;
}

function queuedKey(userId: UserID): string {
	return `propagate:queued:{${userId}}`;
}

function lockKey(userId: UserID): string {
	return `propagate:lock:{${userId}}`;
}

interface UserGuildReader {
	findUnique(userId: UserID): Promise<User | null>;
	getUserGuildIds(userId: UserID): Promise<Array<GuildID>>;
}

interface PartialUserChangePropagationDeps {
	userCacheService: Pick<UserCacheService, 'setUserPartialResponseFromUser'>;
	usernameOwnership?: true;
}

export async function propagatePartialUserChange(deps: PartialUserChangePropagationDeps, user: User): Promise<void> {
	await updateUserCache({user, userCacheService: deps.userCacheService});
	const kv = getKVClient();
	if (deps.usernameOwnership)
		await kv.setex(`username:propagate:capacity:{${user.id}}`, DIRTY_TTL_SECONDS, randomUUID());
	await kv.setex(dirtyKey(user.id), DIRTY_TTL_SECONDS, randomUUID());
	await enqueuePropagation(kv, user.id);
}

// Micup: the one guarded announcement for the paths that start or end premium (the premium badge lives in the public
// flags). `oldUser` null means the public state before the write is unknown, so it is announced anyway. A failed
// announcement is logged and dropped: it never fails the premium write, session or profile read it follows.
export async function propagateIfPartialChanged(
	deps: PartialUserChangePropagationDeps,
	oldUser: User | null,
	newUser: User,
	context: string,
): Promise<void> {
	try {
		if (oldUser === null || hasPartialUserFieldsChanged(oldUser, newUser)) {
			await propagatePartialUserChange(deps, newUser);
		}
	} catch (error) {
		Logger.warn({userId: newUser.id.toString(), context, error}, 'Failed to propagate the premium badge change');
	}
}

async function enqueuePropagation(kv: IKVProvider, userId: UserID): Promise<void> {
	if (!(await kv.setnx(queuedKey(userId), '1', QUEUED_TTL_SECONDS))) {
		return;
	}
	try {
		await getWorkerService().addJob('propagatePartialUserChange', {userId: userId.toString()}, {skipLedger: true});
	} catch (error) {
		await kv.del(queuedKey(userId));
		throw error;
	}
}

export interface PendingPartialUserChangeDeps {
	kvClient: IKVProvider;
	userCacheService: UserCacheService;
	gatewayService: IGatewayService;
	userRepository: UserGuildReader;
	guildRepository: Pick<IGuildRepositoryAggregate, 'getMember' | 'findUnique'>;
	instanceConfigRepository?: Pick<InstanceConfigRepository, 'getUsernameMigrationConfig' | 'setUsernamePolicyConfig'>;
}

export async function dispatchPendingPartialUserChange(
	deps: PendingPartialUserChangeDeps,
	userId: UserID,
): Promise<void> {
	const {kvClient} = deps;
	await kvClient.del(queuedKey(userId));
	const lockToken = randomUUID();
	if (!(await kvClient.acquireLock(lockKey(userId), lockToken, LOCK_TTL_SECONDS))) {
		// The running task re-checks the dirty flag after it lets go and queues again, and a crashed holder's own
		// job is redelivered once its lock has run out, so this task has nothing left to do.
		return;
	}
	try {
		await dispatchPendingLocked(deps, userId, lockToken);
	} finally {
		await kvClient.releaseLock(lockKey(userId), lockToken);
	}
	if ((await kvClient.get(dirtyKey(userId))) !== null) {
		await enqueuePropagation(kvClient, userId);
	}
}

async function dispatchPendingLocked(
	deps: PendingPartialUserChangeDeps,
	userId: UserID,
	lockToken: string,
): Promise<void> {
	const {kvClient, userCacheService, gatewayService, userRepository, guildRepository} = deps;
	let lockExtendedAt = Date.now();
	const pending = await kvClient.get(dirtyKey(userId));
	if (pending === null) {
		return;
	}
	const user = await userRepository.findUnique(userId);
	const capacityKey = `username:propagate:capacity:{${userId}}`;
	const capacityPending = deps.instanceConfigRepository ? await kvClient.get(capacityKey) : null;
	const membersThreshold = USERNAME_CAPACITY_LIMITS.members;
	const monitorMembers =
		capacityPending !== null &&
		deps.instanceConfigRepository !== undefined &&
		(await deps.instanceConfigRepository.getUsernameMigrationConfig()).state === 'selecting';
	let paused: Promise<unknown> | undefined;
	if (user) {
		const requestCache = createRequestCache();
		userCacheService.setUserPartialResponseFromUserInRequestCache(user, requestCache);
		const guildIds = await userRepository.getUserGuildIds(userId);
		await mapWithConcurrency(guildIds, GUILD_DISPATCH_CONCURRENCY, async (guildId) => {
			if (Date.now() - lockExtendedAt >= LOCK_EXTEND_INTERVAL_MS) {
				lockExtendedAt = Date.now();
				if (!(await kvClient.extendLock(lockKey(userId), lockToken, LOCK_TTL_SECONDS))) {
					throw new Error('Lost the partial user change propagation lock');
				}
			}
			const member = await guildRepository.getMember(guildId, userId);
			if (!member) {
				return;
			}
			if (monitorMembers && deps.instanceConfigRepository) {
				// Micup: reuse the existing bounded guild loop; only username changes add a guild point read.
				const guild = await guildRepository.findUnique(guildId);
				if (!guild) return;
				if (
					!Number.isSafeInteger(guild.memberCount) ||
					guild.memberCount < 0 ||
					guild.memberCount >= membersThreshold
				) {
					paused ??= deps.instanceConfigRepository.setUsernamePolicyConfig({
						admission: {global_per_second: 0, paused: true},
					});
					await paused;
					Logger.warn(
						{guildId: guildId.toString(), members: guild.memberCount, membersThreshold},
						'Username migration admission paused at the guild capacity threshold',
					);
				}
			}
			await gatewayService.dispatchGuild({
				guildId,
				event: 'GUILD_MEMBER_UPDATE',
				data: await mapGuildMemberToResponse(member, userCacheService, requestCache),
			});
		});
		requestCache.clear();
	}
	await kvClient.releaseLock(dirtyKey(userId), pending);
	if (capacityPending) await kvClient.releaseLock(capacityKey, capacityPending);
}

// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {SYSTEM_THREAD_VIEWER} from '@app/api/experiment/ChannelThreadsGate';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import type {User} from '@app/api/models/User';
import {UserChannelService} from '@app/api/user/services/UserChannelService';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {JobCancelledError, type WorkerTaskHelpers, type WorkerTaskResult} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const SYSTEM_USER_ID: UserID = createUserID(0n);
const ALL_USERS_PAGE_SIZE = 100;
const CURSOR_TTL_SECONDS = 7 * 24 * 60 * 60;
const INELIGIBLE_FLAGS = UserFlags.DELETED | UserFlags.SELF_DELETED | UserFlags.DISABLED;
const PayloadSchema = z.union([
	z.object({
		content: z.string().min(1).max(4000),
		user_ids: z.array(z.string().regex(/^\d+$/)).min(1),
	}),
	z.object({
		content: z.string().min(1).max(4000),
		all_users: z.literal(true),
	}),
]);

function isEligibleRecipient(user: User): boolean {
	return user.id !== SYSTEM_USER_ID && !user.isBot && !user.isSystem && (user.flags & INELIGIBLE_FLAGS) === 0n;
}

// TEMPORARY: all_users is one sequential job over the whole users table, and every recipient opens a DM through
// ensureDmOpenForBothUsers, which writes a row for the system user (id 0) into the private_channels and
// user_dm_history partitions keyed by user_id 0. One row per recipient makes those single partitions grow with
// the user count, so a broadcast to more than ALL_USERS_RECIPIENT_LIMIT eligible users is rejected before the
// first send. Target: open the channel on the recipient side only (no system-side private channel or DM history
// row) and split the broadcast into child jobs over token ranges of the users table, then drop the limit.
// Trigger: the first all_users broadcast this limit rejects.
const ALL_USERS_RECIPIENT_LIMIT = 100_000;

async function allUsersExceedRecipientLimit(): Promise<boolean> {
	const {userRepository} = getWorkerDependencies();
	let eligible = 0;
	let pageState: string | null = null;
	do {
		const page = await userRepository.scanAllUsersPage(ALL_USERS_PAGE_SIZE, pageState);
		eligible += page.users.filter(isEligibleRecipient).length;
		if (eligible > ALL_USERS_RECIPIENT_LIMIT) return true;
		pageState = page.pageState;
	} while (pageState !== null);
	return false;
}

async function* allUserRecipients(helpers: WorkerTaskHelpers): AsyncGenerator<UserID> {
	const {userRepository, kvClient} = getWorkerDependencies();
	const cursorKey = `system_dm:all_users_cursor:${helpers.jobId}`;
	let pageState = await kvClient.get(cursorKey);
	if (pageState !== null) {
		helpers.logger.info('Resuming system DM broadcast from saved cursor');
	}
	do {
		const page = await userRepository.scanAllUsersPage(ALL_USERS_PAGE_SIZE, pageState);
		for (const user of page.users) {
			if (isEligibleRecipient(user)) {
				yield user.id;
			}
		}
		pageState = page.pageState;
		if (pageState !== null) {
			await kvClient.setex(cursorKey, CURSOR_TTL_SECONDS, pageState);
		}
	} while (pageState !== null);
	await kvClient.del(cursorKey);
}

async function* listedRecipients(userIds: Array<string>): AsyncGenerator<UserID> {
	for (const raw of userIds) {
		yield createUserID(BigInt(raw));
	}
}

export async function sendSystemDm(payload: unknown, helpers: WorkerTaskHelpers): Promise<WorkerTaskResult> {
	const parsed = PayloadSchema.parse(payload);
	const {content} = parsed;
	if ('all_users' in parsed && (await allUsersExceedRecipientLimit())) {
		const rejected = `all_users broadcasts are limited to ${ALL_USERS_RECIPIENT_LIMIT} eligible recipients; send to a user_ids list instead`;
		helpers.logger.warn({limit: ALL_USERS_RECIPIENT_LIMIT}, 'System DM all_users broadcast rejected');
		await helpers.reportProgress(0, 0, rejected);
		return {sent_count: 0, failed_count: 0, rejected};
	}
	const total = 'user_ids' in parsed ? parsed.user_ids.length : null;
	const recipients = 'user_ids' in parsed ? listedRecipients(parsed.user_ids) : allUserRecipients(helpers);
	const deps = getWorkerDependencies();
	const systemUser = await deps.userRepository.findUniqueAssert(SYSTEM_USER_ID);
	const userChannelService = new UserChannelService(
		deps.userRepository,
		deps.channelService,
		deps.channelRepository,
		deps.gatewayService,
		deps.snowflakeService,
		deps.userPermissionUtils,
		deps.limitConfigService,
	);
	const requestCache = createRequestCache();
	let sent = 0;
	let failed = 0;
	for await (const recipientId of recipients) {
		if (await helpers.shouldCancel()) {
			helpers.logger.info({sent, failed, total}, 'System DM job cancelled mid-flight');
			requestCache.clear();
			throw new JobCancelledError();
		}
		try {
			const channel = await userChannelService.ensureDmOpenForBothUsers({
				userId: SYSTEM_USER_ID,
				recipientId,
				userCacheService: deps.userCacheService,
				requestCache,
			});
			await deps.channelService.messages.send.sendMessage({
				user: systemUser,
				viewer: SYSTEM_THREAD_VIEWER,
				channelId: channel.id,
				data: {content},
				requestCache,
			});
			sent += 1;
		} catch (error) {
			failed += 1;
			helpers.logger.warn({recipientId: recipientId.toString(), error}, 'System DM send failed for recipient');
		}
		if ((sent + failed) % ALL_USERS_PAGE_SIZE === 0) {
			requestCache.clear();
			await helpers.reportProgress(sent + failed, total, `${sent} sent, ${failed} failed`);
		}
	}
	requestCache.clear();
	await helpers.reportProgress(sent + failed, sent + failed, `${sent} sent, ${failed} failed`);
	helpers.logger.info({sent, failed, total: sent + failed}, 'System DM job complete');
	return {sent_count: sent, failed_count: failed};
}

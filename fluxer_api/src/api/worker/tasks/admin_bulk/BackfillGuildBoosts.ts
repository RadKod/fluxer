// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import {AdminAuditService} from '@app/api/admin/services/AdminAuditService';
import {createUserID} from '@app/api/BrandedTypes';
import {GuildBoostBackfillRepository} from '@app/api/guild/boost/GuildBoostBackfillRepository';
import {getGuildBoostService} from '@app/api/middleware/ServiceSingletons';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import {JobCancelledError, type WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const LOCK_KEY = 'guild_boost:backfill:lock';
const CHECKPOINT_KEY = 'guild_boost:backfill:checkpoint';
const LOCK_TTL_SECONDS = 30;
const CONCURRENCY = 4;
const MAX_FAILURES = 100;
const PayloadSchema = z.object({
	admin_user_id: z.string().regex(/^\d+$/),
	audit_log_reason: z.string().nullable(),
});

const handler: WorkerTaskHandler = async (rawPayload, helpers) => {
	const payload = PayloadSchema.parse(rawPayload);
	const {kvClient, adminRepository, snowflakeService} = getWorkerDependencies();
	const token = randomUUID();
	const lockRequestedAt = Date.now();
	if (!(await kvClient.acquireLock(LOCK_KEY, token, LOCK_TTL_SECONDS))) {
		throw new Error('Guild boost backfill is already running');
	}
	const started = Date.now();
	let leaseExpires = lockRequestedAt + LOCK_TTL_SECONDS * 1000;
	let leaseLost = false;
	let renewal: Promise<void> | null = null;
	const assertLease = () => {
		if (leaseLost || Date.now() >= leaseExpires) throw new Error('Guild boost backfill lease was lost');
	};
	const renew = () => {
		if (renewal) return renewal;
		const requestedAt = Date.now();
		renewal = kvClient
			.extendLock(LOCK_KEY, token, LOCK_TTL_SECONDS)
			.then((extended) => {
				if (!extended) leaseLost = true;
				else leaseExpires = requestedAt + LOCK_TTL_SECONDS * 1000;
			})
			.catch((error) => {
				leaseLost = true;
				helpers.logger.error({err: error}, 'Guild boost backfill lease renewal failed');
			})
			.finally(() => {
				renewal = null;
			});
		return renewal;
	};
	const heartbeat = setInterval(() => {
		if (!leaseLost) void renew();
	}, 10_000);
	let checkpoint: string | null = null;
	let processed = 0;
	let successful = 0;
	let failedCount = 0;
	const failed: Array<{id: string; error: string}> = [];
	try {
		checkpoint = await kvClient.get(CHECKPOINT_KEY);
		let pageState = checkpoint;
		let scanError: unknown;
		const repository = new GuildBoostBackfillRepository();
		const service = getGuildBoostService();
		try {
			await helpers.reportProgress(0, null, 'Recomputing guild boosts');
			do {
				assertLease();
				if (await helpers.shouldCancel()) throw new JobCancelledError();
				const page = await repository.scanStateGuildIdsPage(pageState);
				assertLease();
				for (let offset = 0; offset < page.rows.length; offset += CONCURRENCY) {
					assertLease();
					if (await helpers.shouldCancel()) throw new JobCancelledError();
					await Promise.all(
						page.rows.slice(offset, offset + CONCURRENCY).map(async ({guild_id}) => {
							try {
								await service.recompute(guild_id);
								successful++;
							} catch (error) {
								failedCount++;
								if (failed.length < MAX_FAILURES) {
									failed.push({id: guild_id.toString(), error: error instanceof Error ? error.message : String(error)});
									helpers.logger.warn({guildId: guild_id.toString(), err: error}, 'Guild boost backfill item failed');
								}
							} finally {
								processed++;
							}
						}),
					);
				}
				await renew();
				assertLease();
				pageState = page.pageState;
				// Later successes cannot skip the first failed page on the next invocation.
				if (failedCount === 0 && pageState !== null) {
					await kvClient.set(CHECKPOINT_KEY, pageState);
					checkpoint = pageState;
				}
				await helpers.reportProgress(processed, null, `+${successful} ok, ${failedCount} failed`);
			} while (pageState !== null);
		} catch (error) {
			scanError = error;
		}
		const incomplete = failedCount > 0 || scanError !== undefined;
		await new AdminAuditService(adminRepository, snowflakeService).createAuditLog({
			adminUserId: createUserID(BigInt(payload.admin_user_id)),
			targetType: 'bulk_job',
			targetId: helpers.jobId,
			action: 'backfill_guild_boosts',
			auditLogReason: payload.audit_log_reason,
			metadata: new Map([
				['job_id', helpers.jobId.toString()],
				['processed', processed.toString()],
				['successful', successful.toString()],
				['failed', failedCount.toString()],
				['checkpoint', incomplete ? (checkpoint ?? '') : ''],
				['incomplete', String(incomplete)],
				['duration_ms', (Date.now() - started).toString()],
				...(scanError === undefined
					? []
					: ([['error', scanError instanceof Error ? scanError.message : String(scanError)]] as Array<
							[string, string]
						>)),
			]),
		});
		if (scanError !== undefined) throw scanError;
		if (!incomplete) {
			await renew();
			assertLease();
			await kvClient.del(CHECKPOINT_KEY);
			checkpoint = null;
		}
		await helpers.reportProgress(processed, processed, `+${successful} ok, ${failedCount} failed`);
		return {
			processed_count: processed,
			successful_count: successful,
			failed_count: failedCount,
			failed,
			checkpoint,
			incomplete,
		};
	} finally {
		clearInterval(heartbeat);
		await renewal;
		await kvClient.releaseLock(LOCK_KEY, token);
	}
};

export default handler;

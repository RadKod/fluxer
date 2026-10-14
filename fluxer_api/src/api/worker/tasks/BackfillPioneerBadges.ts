// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {getPioneerService, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {runAdminBulkJob} from '@app/api/worker/tasks/admin_bulk/AdminBulkJob';
import {createAdminBulkServices} from '@app/api/worker/tasks/admin_bulk/AdminBulkServices';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const Snowflake = z.string().regex(/^\d+$/);
const PayloadSchema = z.object({
	first_user_id: Snowflake,
	excluded_user_ids: z.array(Snowflake),
	dry_run: z.boolean(),
	admin_user_id: Snowflake,
	audit_log_reason: z.string().nullable(),
});

// Micup Öncü one-time backfill: exclusions, number 1, then today's accounts by id, then the live hook opens. Items need
// the state 'backfilling': a stop turns it off and the remaining items give nothing.
const backfillPioneerBadges: WorkerTaskHandler = async (rawPayload, helpers) => {
	const payload = PayloadSchema.parse(rawPayload);
	const service = getPioneerService();
	const userRepository = getUserRepository();
	const firstUserId = createUserID(BigInt(payload.first_user_id));
	const excludedIds = payload.excluded_user_ids.map((id) => createUserID(BigInt(id)));
	const skip = new Set([payload.first_user_id, ...payload.excluded_user_ids]);
	// The audit entry names the accounts, so a wrong ID shows in the dry run before an exclusion becomes permanent.
	const usernames = async (ids: ReadonlyArray<UserID>) =>
		(await Promise.all(ids.map((id) => userRepository.findUnique(id)))).map((user) => user?.username ?? '?').join(',');
	// A cancel, once seen, stays seen: the runner answers false when a later read of the flag fails.
	let cancelSeen = false;
	const shouldCancel = async () => (cancelSeen ||= await helpers.shouldCancel());
	try {
		let firstNumber: number | null = null;
		// A dry run writes nothing, so it names every requested exclusion.
		let exclusions: {excluded: Array<UserID>; alreadyRecorded: Array<UserID>} = {
			excluded: excludedIds,
			alreadyRecorded: [],
		};
		if (!payload.dry_run) {
			exclusions = await service.exclude(excludedIds);
			// Outside the item loop: number 1 must never be skipped as one failed item.
			firstNumber = await service.assign(firstUserId, {requireStatus: 'backfilling'});
		}
		const collected = await service.collectBackfillIds();
		const ids = collected.ids.map(String).filter((id) => !skip.has(id));
		const {auditService} = createAdminBulkServices(getWorkerDependencies());
		return await runAdminBulkJob({
			helpers: {...helpers, shouldCancel},
			ids,
			progressEvery: 100,
			apply: async (id) => {
				if (!payload.dry_run) await service.assignIfEligible(createUserID(BigInt(id)), 'backfilling');
			},
			afterItems: async () => {
				if (payload.dry_run) return [['would_assign', String(ids.length + 1)]];
				// runAdminBulkJob still runs this step after a cancel: a cancelled job must not open numbering.
				if (await shouldCancel()) {
					await service.abandonBackfill();
					return [['stopped_by_cancel', 'true']];
				}
				return service.finishBackfill();
			},
			summary: {
				auditService,
				adminUserId: createUserID(BigInt(payload.admin_user_id)),
				action: 'pioneer_backfill',
				auditLogReason: payload.audit_log_reason,
				metadata: [
					['dry_run', String(payload.dry_run)],
					['first_user_id', payload.first_user_id],
					['first_username', await usernames([firstUserId])],
					['first_user_number', String(firstNumber)],
					['excluded_count', String(exclusions.excluded.length)],
					['excluded_usernames', await usernames(exclusions.excluded)],
					['excluded_already_recorded', await usernames(exclusions.alreadyRecorded)],
					['flagged_waiting', String(collected.flagged)],
				],
			},
		});
	} finally {
		if (payload.dry_run) await service.endDryRun();
	}
};

export default backfillPioneerBadges;

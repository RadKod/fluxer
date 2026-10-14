// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {NcmecSubmissionService} from '@app/api/csam/NcmecSubmissionService';
import type {NcmecUserWorkflowRow} from '@app/api/database/types/CsamTypes';
import {getKVAccountDeletionQueue, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {registerUserBannedHook} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

type Deps = ConstructorParameters<typeof NcmecSubmissionService>[0];

describe('NCMEC ban and the banned hooks', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	it('a confirmed CSAM ban runs the banned hooks once, after it closed the sessions and sent the user update', async () => {
		const account = await createTestAccount(harness);
		const events: Array<string> = [];
		const restore = registerUserBannedHook('badges', async ({userId}) => {
			const sessions = (await getUserRepository().listAuthSessions(userId)).length;
			events.push(`banned hook ${userId} with ${sessions} sessions`);
		});
		const service = new NcmecSubmissionService({
			userRepository: getUserRepository(),
			deletionQueue: getKVAccountDeletionQueue(),
			updatePropagator: {propagateUserUpdate: async () => void events.push('user update')},
		} as unknown as Deps);
		const now = new Date();
		const workflow: NcmecUserWorkflowRow = {
			user_id: BigInt(account.userId),
			deleted_at: null,
			deleted_by_admin_id: null,
			deletion_private_reason: null,
			deletion_ncmec_report_id: null,
			archive_id: null,
			archive_requested_at: null,
			archive_requested_by_admin_id: null,
			archive_audit_log_reason: null,
			archive_completed_at: null,
			deletion_job_queued_at: null,
			previous_report_ids: null,
			created_at: now,
			updated_at: now,
		};

		expect((await getUserRepository().listAuthSessions(createUserID(BigInt(account.userId)))).length).toBeGreaterThan(
			0,
		);

		try {
			await service['banUserIfNeeded'](workflow, createUserID(BigInt(account.userId)), createUserID(1n), '1', 'test');
		} finally {
			restore();
		}

		expect(events).toEqual(['user update', `banned hook ${account.userId} with 0 sessions`]);
	});
});

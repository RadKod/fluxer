// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {PIONEER_MAX_SLOTS} from '@app/api/badge/PioneerService';
import {getPngDataUrl} from '@app/api/emoji/tests/EmojiTestUtils';
import {getSnowflakeService, setInjectedWorkerService} from '@app/api/middleware/ServiceRegistry';
import {getAdminRepository, getBadgeService, getPioneerRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {SyncTaskWorkerService} from '@app/api/test/SyncTaskWorkerService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import assignPioneerBadge from '@app/api/worker/tasks/AssignPioneerBadge';
import backfillPioneerBadges from '@app/api/worker/tasks/BackfillPioneerBadges';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import type {BadgeResponse} from '@fluxer/schema/src/domains/badge/BadgeResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const TEXT = "Öncü #{n} — sanalyer'in ilk 10.000 kullanıcısından";
const shown = (n: number) => `Öncü #${n} — sanalyer'in ilk 10.000 kullanıcısından`;

// One test only: the PioneerService singleton caches "closed" for the rest of the file (a new file's harness clears
// the singletons). The worker object is injected before the test, as in PioneerRoutes.test.ts.
const worker = new SyncTaskWorkerService({assignPioneerBadge, backfillPioneerBadges});

describe('Öncü badge closure', () => {
	let harness: ApiTestHarness;
	let admin: TestAccount;
	let badge: BadgeResponse;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		setWorkerDependenciesForTest({adminRepository: getAdminRepository(), snowflakeService: getSnowflakeService()});
		setInjectedWorkerService(worker);
		admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.BADGES_MANAGE,
		]);
		badge = await createBuilder<BadgeResponse>(harness, admin.token)
			.post('/admin/badges')
			.body({icon: getPngDataUrl(), description: TEXT})
			.expect(HTTP_STATUS.OK)
			.execute();
	});

	afterEach(() => vi.restoreAllMocks());

	afterAll(async () => {
		clearWorkerDependencies();
		setInjectedWorkerService(new NoopWorkerService());
		await harness?.shutdown();
	});

	function start(first: TestAccount, excluded: Array<TestAccount>) {
		return createBuilder(harness, admin.token)
			.post('/admin/badges/pioneer/backfill')
			.body({
				badge_id: badge.id,
				first_user_id: first.userId,
				excluded_user_ids: excluded.map((account) => account.userId),
			});
	}

	async function descriptions(account: TestAccount): Promise<Array<string>> {
		return (await getBadgeService().getProfileBadges(createUserID(BigInt(account.userId)))).map((b) => b.description);
	}

	it('the 10 001st account gets no badge and later accounts do not reach the queue', async () => {
		await start(await createTestAccount(harness), [admin])
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await getPioneerRepository().setNextSlot(PIONEER_MAX_SLOTS);

		expect(await descriptions(await createTestAccount(harness))).toEqual([shown(10_000)]);
		expect(await descriptions(await createTestAccount(harness))).toEqual([]);
		const addJob = vi.spyOn(worker, 'addJob');
		await createTestAccount(harness);
		expect(addJob.mock.calls.filter(([task]) => task === 'assignPioneerBadge')).toEqual([]);
	});
});

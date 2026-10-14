// SPDX-License-Identifier: AGPL-3.0-or-later

import {writeFileSync} from 'node:fs';
import {resolve, sep} from 'node:path';
import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {parseInstanceDiscoveryDocument} from '@fluxer/instance_bootstrap/src/Discovery';
import {RpcResponseSessionData} from '@fluxer/schema/src/domains/rpc/RpcSchemas';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

describe('username migration READY contract', () => {
	let harness: ApiTestHarness;
	beforeEach(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await harness.shutdown();
	});

	it.each(['legacy', 'preparing', 'selecting'] as const)(
		'carries %s migration and public tiers through the session response schema',
		async (state) => {
			const account = await createTestAccount(harness);
			const migration = {
				state,
				epoch: state === 'legacy' ? 0 : 1,
				preparing_at: state === 'legacy' ? null : '2026-10-01T00:00:00Z',
				started_at: state === 'selecting' ? '2026-10-01T00:01:00Z' : null,
				forced_at: state === 'selecting' ? '2026-10-08T00:01:00Z' : null,
			};
			const tiers = {'1': 'locked' as const, '2': 'for_sale' as const, '3': 'public' as const};
			vi.spyOn(InstanceConfigRepository.prototype, 'getUsernameMigrationConfig').mockResolvedValue(migration);
			const policy = await new InstanceConfigRepository().getUsernamePolicyConfig();
			vi.spyOn(InstanceConfigRepository.prototype, 'getUsernamePolicyConfig').mockResolvedValue({...policy, tiers});
			const response = await createBuilder<{type: 'session'; data: unknown}>(harness, '')
				.post('/test/rpc-session-init')
				.body({type: 'session', token: account.token, version: 1, ip: '127.0.0.1'})
				.expect(HTTP_STATUS.OK)
				.execute();
			const data = RpcResponseSessionData.parse(response.data);
			expect(data.username_migration).toEqual(migration);
			expect(data.username_tiers).toEqual(tiers);
			expect(data.user.id).toBe(account.userId);
			expect(data.user.username_state).toBe('legacy');
			expect(response.data).not.toHaveProperty('held_manifest');
			expect(response.data).not.toHaveProperty('username_policy');
			const discovery = await createBuilder(harness, '').get('/.well-known/fluxer').expect(HTTP_STATUS.OK).execute();
			const document = parseInstanceDiscoveryDocument(discovery);
			expect(document.usernameMigration).toEqual(data.username_migration);
			expect(document.usernameTiers).toEqual(data.username_tiers);
			if (state === 'selecting' && process.env.ENT2_READY_FIXTURE) {
				const path = resolve(process.env.ENT2_READY_FIXTURE);
				if (!path.startsWith(resolve('E:/micup-v2-wt/tmp/kullanici-adi') + sep)) {
					throw new Error('READY fixture must stay in the task temporary directory');
				}
				writeFileSync(path, JSON.stringify({rpc: response.data, discovery}));
			}
		},
	);
});

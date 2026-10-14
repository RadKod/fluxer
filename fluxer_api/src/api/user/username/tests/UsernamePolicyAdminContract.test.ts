// SPDX-License-Identifier: AGPL-3.0-or-later

import {AdminBanManagementService} from '@app/api/admin/services/AdminBanManagementService';
import * as schemas from '@fluxer/schema/src/domains/admin/UsernameSchemas';
import {describe, expect, it} from 'vitest';

describe('username administration contract', () => {
	it('publishes username dictionaries independently of profile substring bans', () => {
		expect(AdminBanManagementService.prototype).toHaveProperty('publishUsernameDictionary');
	});
	it('exposes a single atomic request for all three username tiers', () => {
		expect(schemas).toHaveProperty('UsernamePolicyUpdateRequest');
	});
	it('requires migration attestations and separate reservation requests', () => {
		expect(schemas).toHaveProperty('UsernameMigrationPrepareRequest');
		expect(schemas).toHaveProperty('UsernameMigrationStartRequest');
		expect(schemas).toHaveProperty('UsernameReserveRequest');
	});
	it('requires process and both-store mobile acknowledgements, rejects client proof spoofing', () => {
		expect(schemas.UsernameMigrationPrepareRequest.safeParse({processes_ready: true}).success).toBe(true);
		expect(schemas.UsernameMigrationPrepareRequest.safeParse({processes_ready: false}).success).toBe(false);
		const start = {
			epoch: 1,
			mobile_published: true,
			mobile_version: '1.2.3',
			guild_capacity: {
				max_guild_members: 100,
				max_guild_online: 10,
				source: 'activity report',
				observed_at: new Date().toISOString(),
			},
		};
		expect(schemas.UsernameMigrationStartRequest.safeParse(start).success).toBe(true);
		for (const patch of [
			{mobile_published: false},
			{mobile_version: ' '},
			{epoch: -1},
			{holds_ready: true},
			{min_client_version: '1'},
		]) {
			expect(schemas.UsernameMigrationStartRequest.safeParse({...start, ...patch}).success).toBe(false);
		}
	});
});

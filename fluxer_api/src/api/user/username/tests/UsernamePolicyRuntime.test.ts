// SPDX-License-Identifier: AGPL-3.0-or-later

import * as registry from '@app/api/middleware/ServiceRegistry';
import type {UsernameOwnershipService} from '@app/api/user/username/UsernameOwnershipService';
import {afterEach, describe, expect, it} from 'vitest';

describe('username runtime registration', () => {
	afterEach(() => {
		registry.setInjectedUsernameOwnershipService?.(undefined);
		registry.setInjectedUsernameMigrationPreconditions?.(undefined);
	});

	it('does not create an ownership service without admission and propagation adapters', () => {
		expect(registry.getUsernameOwnershipService).toBeTypeOf('function');
		expect(() => registry.getUsernameOwnershipService()).toThrow('unavailable');
	});

	it('returns only the explicitly registered ownership service', () => {
		expect(registry.setInjectedUsernameOwnershipService).toBeTypeOf('function');
		const service = {} as UsernameOwnershipService;
		registry.setInjectedUsernameOwnershipService(service);
		expect(registry.getUsernameOwnershipService()).toBe(service);
		registry.setInjectedUsernameOwnershipService(undefined);
		expect(() => registry.getUsernameOwnershipService()).toThrow('unavailable');
	});

	it('fails closed when start evidence is incomplete', async () => {
		const config = {
			readUsernameMigrationConfig: async () => ({state: 'preparing', epoch: 2, started_at: null, forced_at: null}),
			readUsernamePolicyConfig: async () => ({revision: 7, held_manifest: []}),
			readUsernameMigrationScan: async () => null,
			readUsernameMigrationGuildCapacity: async () => null,
			readUsernameReserveFence: async () => ({version: 0, pending: false}),
		};
		await expect(registry.readUsernameMigrationPreconditions(config as never)).rejects.toThrow('unavailable');
	});

	it('reads fresh migration evidence and preserves a rejected provider', async () => {
		expect(registry.setInjectedUsernameMigrationPreconditions).toBeTypeOf('function');
		let holdsReady = false;
		registry.setInjectedUsernameMigrationPreconditions(async () => ({
			holdsReady,
			capacityReady: true,
			reserveVersion: 0,
		}));
		expect(await registry.readUsernameMigrationPreconditions({} as never)).toEqual({
			holdsReady: false,
			capacityReady: true,
			reserveVersion: 0,
		});
		holdsReady = true;
		expect(await registry.readUsernameMigrationPreconditions({} as never)).toEqual({
			holdsReady: true,
			capacityReady: true,
			reserveVersion: 0,
		});
		registry.setInjectedUsernameMigrationPreconditions(async () => {
			throw new Error('metrics offline');
		});
		await expect(registry.readUsernameMigrationPreconditions({} as never)).rejects.toThrow('metrics offline');
	});
});

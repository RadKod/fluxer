// SPDX-License-Identifier: AGPL-3.0-or-later

import {WellKnownFluxerResponse} from '@fluxer/schema/src/domains/instance/InstanceSchemas';
import {describe, expect, it} from 'vitest';

describe('username policy discovery schema', () => {
	it('preserves migration state and dates with all three public tier modes', () => {
		const fields = WellKnownFluxerResponse.shape as Record<string, {parse(value: unknown): unknown}>;
		expect(fields.username_migration).toBeDefined();
		expect(fields.username_tiers).toBeDefined();
		const migration = {
			state: 'selecting',
			epoch: 4,
			preparing_at: '2026-10-08T23:59:00Z',
			started_at: '2026-10-09T00:00:00Z',
			forced_at: '2026-10-16T00:00:00Z',
		};
		expect(fields.username_migration.parse(migration)).toEqual(migration);
		expect(fields.username_tiers.parse({'1': 'locked', '2': 'for_sale', '3': 'public'})).toEqual({
			'1': 'locked',
			'2': 'for_sale',
			'3': 'public',
		});
	});
});

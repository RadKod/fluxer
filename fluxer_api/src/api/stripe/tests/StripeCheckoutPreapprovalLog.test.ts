// SPDX-License-Identifier: AGPL-3.0-or-later

import {Logger} from '@app/api/Logger';
import type {ProductRegistry} from '@app/api/stripe/ProductRegistry';
import {StripeCheckoutService} from '@app/api/stripe/services/StripeCheckoutService';
import type {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import type {ICacheService} from '@pkgs/cache/src/ICacheService';
import {afterEach, describe, expect, it, vi} from 'vitest';

describe('localized card preapproval logging', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('a failed lock release is logged without the preapproval token', async () => {
		const token = 'preapproval-token-never-logged';
		const cache = {
			get: vi
				.fn()
				.mockResolvedValueOnce({status: 'approved', finalCheckoutUrl: null, token})
				.mockResolvedValueOnce(null),
			acquireLock: vi.fn().mockResolvedValue('lock'),
			releaseLock: vi.fn().mockRejectedValue(new Error('kv down')),
		};
		const service = new StripeCheckoutService(
			null,
			{} as UserRepository,
			{} as ProductRegistry,
			cache as unknown as ICacheService,
		);
		const error = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'error');

		expect(await service.continueLocalizedCardPreapproval(token)).toEqual({status: 'expired'});

		expect(error).toHaveBeenCalledTimes(1);
		const logged = JSON.stringify(error.mock.calls, (_key, value) => (value instanceof Error ? value.message : value));
		expect(logged).toContain('kv down');
		expect(logged).not.toContain(token);
	});
});

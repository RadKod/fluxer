// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {vi} from 'vitest';

// Explicitly opt dormant Stripe domain suites into the upstream billing paths. Production availability stays closed.
vi.mock('@app/api/stripe/BillingConfigCache', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@app/api/stripe/BillingConfigCache')>();
	return {
		...actual,
		isBillingActive: (config = actual.getEffectiveBillingConfig()) =>
			config.enabled &&
			config.secretKey !== null &&
			actual.hasRecurringPricePair(config) &&
			actual.isPremiumTieringActive(),
		isStripeServiceable: (config = actual.getEffectiveBillingConfig()) =>
			config.secretKey !== null && (Config.instance.selfHosted ? actual.isPremiumTieringActive() : config.enabled),
	};
});

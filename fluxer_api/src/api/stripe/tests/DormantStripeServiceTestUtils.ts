// SPDX-License-Identifier: AGPL-3.0-or-later

import '@app/api/stripe/tests/DormantStripeTestFixture';
import {getGatewayService} from '@app/api/middleware/ServiceRegistry';
import {getCacheService, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {createTestStoreEntitlementService} from '@app/api/store_billing/tests/StoreBillingTestUtils';
import {getProductRegistry} from '@app/api/stripe/ProductRegistry';
import {getStripeClient} from '@app/api/stripe/StripeClient';
import {StripeSubscriptionService} from '@app/api/stripe/services/StripeSubscriptionService';

export function createDormantStripeSubscriptionService(): StripeSubscriptionService {
	return new StripeSubscriptionService(
		getStripeClient(),
		getUserRepository(),
		getProductRegistry(),
		getCacheService(),
		getGatewayService(),
		createTestStoreEntitlementService(),
	);
}

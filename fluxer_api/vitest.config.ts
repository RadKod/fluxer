// SPDX-License-Identifier: AGPL-3.0-or-later

import {availableParallelism} from 'node:os';
import {configDefaults, defineConfig} from 'vitest/config';

function parseParallelInteger(value: string | undefined, fallback: number): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 1) {
		return fallback;
	}
	return parsed;
}

function resolveDefaultParallelWorkers(): number {
	return Math.max(2, availableParallelism() - 1);
}

const DEFAULT_PARALLEL_WORKERS = resolveDefaultParallelWorkers();
const configuredMaxWorkers = parseParallelInteger(process.env.API_TEST_MAX_WORKERS, DEFAULT_PARALLEL_WORKERS);
const configuredMaxConcurrency = parseParallelInteger(process.env.API_TEST_MAX_CONCURRENCY, configuredMaxWorkers);

const MODULE_REGISTRY_TEST_FILES = [
	'src/api/worker/tests/BackfillGuildBoosts.test.ts',
	'src/api/donation/tests/DonationCheckout.test.ts',
	'src/api/donation/tests/DonationManage.test.ts',
	'src/api/store_billing/tests/StoreBillingStripeCoexistence.test.ts',
	'src/api/stripe/tests/PremiumStateService.test.ts',
	'src/api/stripe/tests/StripeCustomerEmailSync.test.ts',
	'src/api/stripe/tests/StripeRefundService.test.ts',
	'src/api/stripe/tests/StripeSubscriptionListPriceSwitch.test.ts',
	'src/api/stripe/tests/StripeSubscriptionService.test.ts',
	'src/api/stripe/tests/StripeWebhookCheckout.test.ts',
	'src/api/stripe/tests/StripeWebhookCore.test.ts',
	'src/api/stripe/tests/StripeWebhookDispute.test.ts',
	'src/api/stripe/tests/StripeWebhookEarlyFraudWarning.test.ts',
	'src/api/stripe/tests/StripeWebhookInvoice.test.ts',
	'src/api/stripe/tests/StripeWebhookRefund.test.ts',
	'src/api/stripe/tests/StripeWebhookSubscription.test.ts',
	'src/api/stripe/tests/StripeGiftSubscriptionShift.test.ts',
	'src/api/referral/tests/ReferralBackfill.test.ts',
	'src/api/referral/tests/ReferralGrant.test.ts',
	'src/api/user/username/tests/UsernamePolicyCache.test.ts',
	'src/api/user/username/tests/UsernamePolicyConfig.test.ts',
	'src/api/user/username/tests/UsernamePolicyService.test.ts',
	'src/api/user/username/tests/UsernamePolicyAdminAudit.test.ts',
	'src/api/user/username/tests/UsernamePolicyAdminContract.test.ts',
	'src/api/user/username/tests/UsernamePolicyAdminController.test.ts',
	'src/api/user/username/tests/UsernamePolicyAdminDictionaryController.test.ts',
	'src/api/user/username/tests/UsernamePolicyAdminDictionaryPublisher.test.ts',
	'src/api/user/username/tests/UsernamePolicyAdminDiscovery.test.ts',
	'src/api/user/username/tests/UsernamePolicyAdminLegacyProfiles.test.ts',
	'src/api/user/username/tests/UsernamePolicyAdminProfile.test.ts',
	'src/api/user/username/tests/UsernamePolicyAdminReserve.test.ts',
	'src/api/user/username/tests/UsernamePolicyAdminMigration.test.ts',
	'src/api/user/username/tests/UsernameAdminReadRoutes.test.ts',
	'src/api/user/username/tests/UsernamePolicyDictionaryCleanup.test.ts',
	'src/api/user/username/tests/UsernamePolicyRuntime.test.ts',
	'src/api/worker/tasks/HarvestThreadMembershipPaging.test.ts',
	'src/api/voice/tests/VoiceAvailabilityService.test.ts',
	'src/api/billing_documents/BillingDocuments.test.ts',
	// Upstream billing suites that need the dormant Stripe paths (DormantStripeTestFixture mocks a module).
	'src/api/stripe/tests/StripeWebhookBillingEmails.test.ts',
	'src/api/stripe/tests/StripeCheckoutWithdrawalWaiver.test.ts',
	'src/api/stripe/tests/StripeCheckoutDistribution.test.ts',
	'src/api/billing_documents/LegacyStripeInvoiceImport.test.ts',
	'src/api/admin/tests/AdminClosureStripeRefund.test.ts',
	'src/api/user/tests/AccountTierGates.test.ts',
	'src/api/admin/tests/audit_coverage/BillingDocumentAdminAuditCoverage.test.ts',
	'src/api/payment_disputes/tests/PaymentDisputeReviews.test.ts',
	// vi.mock of the Logger takes hold only when this file loads the service first, which a shared worker cannot promise.
	'src/api/operator_pass/OperatorPassFulfilmentService.test.ts',
];

// Wall-clock budgets measured while other workers run fail on CPU contention, not on slow code; these files run
// in their own project after every other project has finished, so their budgets stay strict.
const TIMING_BUDGET_TEST_FILES = [
	'src/api/user/username/tests/UsernamePolicyDictionary.test.ts',
	// sanalyer table games: property runs with a wall-clock budget.
	'src/api/table_game/engine/chess/tests/ChessGameProperty.test.ts',
	'src/api/table_game/engine/okey/tests/ClassicOkeyProperty.test.ts',
];

const INSTANCE_POLICY_TEST_FILES = ['src/api/admin/tests/InstanceConfigPendingRegistrationApproval.test.ts'];

const NATIVE_TIMEZONE_TEST_FILES = ['src/api/utils/AgeUtils.test.ts'];

// TEMPORARY: announcement channels are closed, so these upstream suites cannot build their fixtures; re-include them when they open (bucketed follower/crosspost partitions and a follower cap first).
const CLOSED_ANNOUNCEMENT_TEST_FILES = [
	'src/api/channel/tests/AnnouncementChannelConversion.test.ts',
	'src/api/channel/tests/AnnouncementChannelType.test.ts',
	'src/api/channel/tests/AnnouncementThreadRaces.test.ts',
	'src/api/channel/tests/AnnouncementThreads.test.ts',
	'src/api/channel/tests/CrosspostConcurrency.test.ts',
	'src/api/channel/tests/CrosspostModeration.test.ts',
	'src/api/channel/tests/CrosspostPropagation.test.ts',
	'src/api/channel/tests/CrosspostRateLimits.test.ts',
	'src/api/channel/tests/CrosspostSource.test.ts',
	'src/api/channel/tests/MessageCrosspost.test.ts',
	'src/api/channel/tests/MessageCrosspostFanout.test.ts',
	'src/api/guild/tests/GuildDeletionAttachmentPurge.test.ts',
	'src/api/report/tests/CrosspostReport.test.ts',
	'src/api/webhook/tests/ChannelFollow.test.ts',
	'src/api/webhook/tests/ChannelFollowPermissions.test.ts',
	'src/api/webhook/tests/FollowerWebhookManagement.test.ts',
	'src/api/worker/tests/CrosspostTasks.test.ts',
];

// sanalyer (Micup, COZ-API karar 10): these upstream suites only exercise purchase routes that stay closed here
// (Google Play self-service refunds, Visionary rejoin); re-include them if those routes open.
const CLOSED_BILLING_ROUTE_TEST_FILES = [
	'src/api/store_billing/tests/GooglePlaySelfServeRefund.test.ts',
	'src/api/stripe/tests/VisionaryRejoin.test.ts',
];

const sharedExclude = [
	...configDefaults.exclude,
	'pkgs/**',
	'../fluxer_desktop/**',
	'**/target/**',
	...CLOSED_ANNOUNCEMENT_TEST_FILES,
	...CLOSED_BILLING_ROUTE_TEST_FILES,
];

const sharedTestConfig = {
	globals: true,
	environment: 'node' as const,
	setupFiles: ['./src/api/test/Setup.ts'],
	pool: 'threads' as const,
	testTimeout: 40000,
	hookTimeout: 20000,
	maxConcurrency: configuredMaxConcurrency,
	execArgv: ['--no-experimental-webstorage', '--disable-warning=ExperimentalWarning'],
};

export default defineConfig({
	root: process.cwd(),
	cacheDir: './node_modules/.vitest',
	test: {
		maxWorkers: configuredMaxWorkers,
		maxConcurrency: configuredMaxConcurrency,
		fileParallelism: true,
		reporters: ['default', 'json'],
		outputFile: './test-results.json',

		projects: [
			{
				resolve: {tsconfigPaths: true},
				test: {
					...sharedTestConfig,
					name: 'api',
					include: ['src/**/*.{test,spec}.{ts,tsx}'],
					exclude: [
						...sharedExclude,
						...MODULE_REGISTRY_TEST_FILES,
						...INSTANCE_POLICY_TEST_FILES,
						...TIMING_BUDGET_TEST_FILES,
						...NATIVE_TIMEZONE_TEST_FILES,
					],
					isolate: false,
				},
			},
			{
				resolve: {tsconfigPaths: true},
				test: {
					...sharedTestConfig,
					name: 'api-module-registry',
					include: MODULE_REGISTRY_TEST_FILES,
					exclude: sharedExclude,
					isolate: true,
				},
			},
			{
				resolve: {tsconfigPaths: true},
				test: {
					...sharedTestConfig,
					name: 'api-instance-policy',
					include: INSTANCE_POLICY_TEST_FILES,
					exclude: sharedExclude,
					isolate: true,
				},
			},
			{
				resolve: {tsconfigPaths: true},
				test: {
					...sharedTestConfig,
					name: 'api-timing-budget',
					include: TIMING_BUDGET_TEST_FILES,
					exclude: sharedExclude,
					isolate: true,
					sequence: {groupOrder: 1},
				},
			},
			{
				resolve: {tsconfigPaths: true},
				test: {
					...sharedTestConfig,
					name: 'api-native-timezones',
					include: NATIVE_TIMEZONE_TEST_FILES,
					exclude: sharedExclude,
					pool: 'forks',
					isolate: true,
				},
			},
		],
	},
});

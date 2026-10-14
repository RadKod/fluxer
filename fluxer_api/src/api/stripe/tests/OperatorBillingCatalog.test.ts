// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from 'node:crypto';
import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {getCachedInstancePremiumMode, setCachedInstancePremiumMode} from '@app/api/limits/InstancePremiumModeCache';
import {getBillingRepository} from '@app/api/middleware/ServiceRegistry';
import {getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {
	getEffectiveBillingConfig,
	getStoredBillingConfig,
	isBillingActive,
	type StoredBillingConfig,
	setStoredBillingConfig,
} from '@app/api/stripe/BillingConfigCache';
import {getProductRegistry, ProductRegistry, ProductType} from '@app/api/stripe/ProductRegistry';
import {getStripeClient} from '@app/api/stripe/StripeClient';
import {setupSyncStripeWebhookWorker} from '@app/api/stripe/tests/StripeWebhookTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {
	createMockWebhookPayload,
	createStripeApiHandlers,
	type StripeApiHandlers,
} from '@app/api/test/msw/handlers/StripeApiHandlers';
import {server} from '@app/api/test/msw/server';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {getCurrencyPreferences, getGiftCurrencyPreferences, isLocalizedCurrency} from '@app/api/utils/CurrencyUtils';
import processStripeWebhook from '@app/api/worker/tasks/ProcessStripeWebhook';
import {setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {PremiumStateResponse} from '@fluxer/schema/src/domains/premium/PremiumSchemas';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {HttpResponse, http} from 'msw';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, test} from 'vitest';

const ENV_CURRENCIES = ['USD', 'EUR', 'BRL', 'DKK', 'INR', 'NOK', 'PLN', 'SEK', 'TRY'] as const;

function buildFullEnvPrices(): NonNullable<typeof Config.stripe.prices> {
	const prices: Record<string, string> = {};
	for (const currency of ENV_CURRENCIES) {
		const suffix = currency.charAt(0) + currency.slice(1).toLowerCase();
		const lower = currency.toLowerCase();
		prices[`monthly${suffix}`] = `price_envmonthly${lower}`;
		prices[`yearly${suffix}`] = `price_envyearly${lower}`;
		prices[`gift1Month${suffix}`] = `price_envgiftmonth${lower}`;
		prices[`gift1Year${suffix}`] = `price_envgiftyear${lower}`;
	}
	return prices as NonNullable<typeof Config.stripe.prices>;
}

const OPERATOR_PRICES = {
	GBP: {
		monthly: 'price_opgbpmonthly',
		yearly: 'price_opgbpyearly',
		gift_1_month: 'price_opgbpgiftmonth',
		gift_1_year: 'price_opgbpgiftyear',
	},
	SEK: {
		monthly: 'price_opsekmonthly',
		yearly: 'price_opsekyearly',
		gift_1_month: null,
		gift_1_year: null,
	},
	CHF: {
		monthly: 'price_opchfmonthly',
		yearly: 'price_opchfyearly',
		gift_1_month: 'price_opchfgiftmonth',
		gift_1_year: 'price_opchfgiftyear',
	},
};

const STORED_WEBHOOK_SECRET = 'whsec_operator_stored';
const ENV_WEBHOOK_SECRET = 'whsec_env_only';

function operatorBilling(overrides: Partial<StoredBillingConfig> = {}): StoredBillingConfig {
	return {
		enabled: true,
		stripe_secret_key: 'sk_test_operator_a',
		stripe_webhook_secret: STORED_WEBHOOK_SECRET,
		automatic_tax: null,
		tax_id_collection: null,
		terms_consent_required: null,
		default_currency: 'GBP',
		prices: OPERATOR_PRICES,
		country_currencies: {SE: 'SEK', CH: 'CHF'},
		legacy_prices: {monthly_GBP: ['price_opgbplegacymonthly']},
		...overrides,
	};
}

interface GlobalState {
	prices: typeof Config.stripe.prices;
	legacyPrices: typeof Config.stripe.legacyPrices;
	webhookSecret: typeof Config.stripe.webhookSecret;
	selfHosted: boolean;
	premiumMode: ReturnType<typeof getCachedInstancePremiumMode>;
	storedBilling: StoredBillingConfig | null;
}

function captureGlobalState(): GlobalState {
	return {
		prices: Config.stripe.prices,
		legacyPrices: Config.stripe.legacyPrices,
		webhookSecret: Config.stripe.webhookSecret,
		selfHosted: Config.instance.selfHosted,
		premiumMode: getCachedInstancePremiumMode(),
		storedBilling: getStoredBillingConfig(),
	};
}

function restoreGlobalState(state: GlobalState): void {
	Config.stripe.prices = state.prices;
	Config.stripe.legacyPrices = state.legacyPrices;
	Config.stripe.webhookSecret = state.webhookSecret;
	Config.instance.selfHosted = state.selfHosted;
	setCachedInstancePremiumMode(state.premiumMode);
	setStoredBillingConfig(state.storedBilling);
}

const WORKER_HELPERS = {logger: new NoopLogger()} as unknown as WorkerTaskHelpers;

function useOperatorBilling(overrides: Partial<StoredBillingConfig> = {}): void {
	Config.instance.selfHosted = true;
	setCachedInstancePremiumMode('mirror');
	setStoredBillingConfig(operatorBilling(overrides));
}

function signWebhook(payload: string, timestamp: number, secret: string): string {
	const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
	return `t=${timestamp},v1=${signature}`;
}

// COZ-API karar 10: yap?land?r?lm?? anahtarlar ve kataloglar Micup ?zerinde Stripe hizmetini a?maz.
describe('operator billing catalog', () => {
	let harness: ApiTestHarness;
	let stripeHandlers: StripeApiHandlers;
	let initialState: GlobalState;

	async function createAccount(): Promise<Awaited<ReturnType<typeof createTestAccount>>> {
		const storedBilling = getStoredBillingConfig();
		const premiumMode = getCachedInstancePremiumMode();
		const account = await createTestAccount(harness);
		setStoredBillingConfig(storedBilling);
		setCachedInstancePremiumMode(premiumMode);
		return account;
	}

	async function createPurchaser(): Promise<string> {
		const storedBilling = getStoredBillingConfig();
		const premiumMode = getCachedInstancePremiumMode();
		const account = await createAccount();
		await createBuilder(harness, account.token)
			.post(`/test/users/${account.userId}/security-flags`)
			.body({email_verified: true})
			.execute();
		setStoredBillingConfig(storedBilling);
		setCachedInstancePremiumMode(premiumMode);
		return account.token;
	}

	beforeAll(async () => {
		initialState = captureGlobalState();
		harness = await createApiTestHarness();
	});

	afterAll(async () => {
		restoreGlobalState(initialState);
		await harness.shutdown();
	});

	beforeEach(() => {
		restoreGlobalState(initialState);
		Config.stripe.prices = buildFullEnvPrices();
		Config.stripe.legacyPrices = {};
		stripeHandlers = createStripeApiHandlers({subscriptionsListEmpty: true});
		server.use(...stripeHandlers.handlers);
	});

	afterEach(() => {
		restoreGlobalState(initialState);
	});

	describe('env catalog mode', () => {
		test('registers every env price with the same product shape as before', () => {
			const registry = new ProductRegistry();
			expect(getEffectiveBillingConfig().catalogMode).toBe('env');
			for (const currency of ENV_CURRENCIES) {
				const lower = currency.toLowerCase();
				expect(registry.getProduct(`price_envmonthly${lower}`)).toEqual({
					type: ProductType.MONTHLY_SUBSCRIPTION,
					premiumType: UserPremiumTypes.SUBSCRIPTION,
					durationMonths: 1,
					isGift: false,
					currency,
					billingCycle: 'monthly',
				});
				expect(registry.getProduct(`price_envyearly${lower}`)).toEqual({
					type: ProductType.YEARLY_SUBSCRIPTION,
					premiumType: UserPremiumTypes.SUBSCRIPTION,
					durationMonths: 12,
					isGift: false,
					currency,
					billingCycle: 'yearly',
				});
				expect(registry.getProduct(`price_envgiftmonth${lower}`)).toEqual({
					type: ProductType.GIFT_1_MONTH,
					premiumType: UserPremiumTypes.SUBSCRIPTION,
					durationMonths: 1,
					isGift: true,
					currency,
				});
				expect(registry.getProduct(`price_envgiftyear${lower}`)).toEqual({
					type: ProductType.GIFT_1_YEAR,
					premiumType: UserPremiumTypes.SUBSCRIPTION,
					durationMonths: 12,
					isGift: true,
					currency,
				});
				expect(registry.getRecurringSubscriptionPriceId('monthly', lower)).toBe(`price_envmonthly${lower}`);
				expect(registry.getRecurringSubscriptionPriceId('yearly', currency)).toBe(`price_envyearly${lower}`);
				expect(registry.getGiftPriceId('gift_1_month', lower)).toBe(`price_envgiftmonth${lower}`);
				expect(registry.getGiftPriceId('gift_1_year', currency)).toBe(`price_envgiftyear${lower}`);
			}
			expect(registry.getRecurringSubscriptionPriceId('monthly', 'GBP')).toBeNull();
		});

		test('keeps the hosted country routing and localized currency rules', () => {
			expect(getCurrencyPreferences('SE')).toEqual(['SEK', 'EUR', 'USD']);
			expect(getCurrencyPreferences('GB')).toEqual(['USD', 'EUR']);
			expect(getGiftCurrencyPreferences('BR')).toEqual(['USD', 'EUR']);
			expect(isLocalizedCurrency('BRL')).toBe(true);
			expect(isLocalizedCurrency('USD')).toBe(false);
			expect(isLocalizedCurrency('EUR')).toBe(false);
		});

		test('ignores legacy slots outside the hosted currencies', () => {
			Config.stripe.legacyPrices = {monthly_gbp: ['price_legacygbp'], monthly_brl: ['price_legacybrl']};
			const registry = getProductRegistry();
			expect(registry.getProduct('price_legacygbp')).toBeNull();
			expect(registry.getProduct('price_legacybrl')?.currency).toBe('BRL');
		});

		test('hides env price ids despite configured Swedish prices', async () => {
			const token = await createPurchaser();
			await createBuilder(harness, token)
				.get('/premium/price-ids?country_code=SE')
				.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
				.execute();
			expect(stripeHandlers.spies.createdCheckoutSessions).toHaveLength(0);
		});

		test('rejects hosted gift checkout despite configured consent and tax', async () => {
			const token = await createPurchaser();
			await createBuilder(harness, token)
				.post('/stripe/checkout/gift')
				.body({price_id: 'price_envgiftmonthusd'})
				.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
				.execute();
			expect(stripeHandlers.spies.createdCheckoutSessions).toHaveLength(0);
		});

		test('rejects the hosted portal without altering a stored customer', async () => {
			const account = await createAccount();
			await createBuilder(harness, account.token)
				.post(`/test/users/${account.userId}/premium`)
				.body({stripe_customer_id: 'cus_hosted_existing'})
				.execute();
			await createBuilder(harness, account.token)
				.post('/premium/customer-portal')
				.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
				.execute();
			const user = await getUserRepository().findUnique(createUserID(BigInt(account.userId)));
			expect(user?.stripeCustomerId).toBe('cus_hosted_existing');
		});

		test('rejects localized recurring checkout before country validation', async () => {
			const token = await createPurchaser();
			await createBuilder(harness, token)
				.post('/stripe/checkout/subscription')
				.body({price_id: 'price_envmonthlybrl'})
				.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
				.execute();
			expect(stripeHandlers.spies.createdCheckoutSessions).toHaveLength(0);
		});
	});

	describe('operator catalog mode', () => {
		beforeEach(() => {
			useOperatorBilling();
		});

		test('builds the catalog from the stored prices only', () => {
			const registry = getProductRegistry();
			expect(getEffectiveBillingConfig().catalogMode).toBe('operator');
			expect(registry.getProduct('price_opgbpmonthly')).toEqual({
				type: ProductType.MONTHLY_SUBSCRIPTION,
				premiumType: UserPremiumTypes.SUBSCRIPTION,
				durationMonths: 1,
				isGift: false,
				currency: 'GBP',
				billingCycle: 'monthly',
			});
			expect(registry.getProduct('price_opgbplegacymonthly')?.currency).toBe('GBP');
			expect(registry.getProduct('price_envmonthlyusd')).toBeNull();
			expect(registry.getRecurringSubscriptionPriceId('yearly', 'gbp')).toBe('price_opgbpyearly');
			expect(registry.getGiftPriceId('gift_1_month', 'SEK')).toBeNull();
			expect(isLocalizedCurrency('GBP')).toBe(false);
			expect(isLocalizedCurrency('BRL')).toBe(false);
		});

		test('hides operator price ids for every country', async () => {
			const token = await createPurchaser();
			await createBuilder(harness, token)
				.get('/premium/price-ids?country_code=SE')
				.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
				.execute();
			expect(stripeHandlers.spies.createdCheckoutSessions).toHaveLength(0);
		});

		test('falls back to the first configured currency without a default', () => {
			setStoredBillingConfig(operatorBilling({default_currency: null, country_currencies: null}));
			expect(getCurrencyPreferences('US')).toEqual(['GBP', 'SEK', 'CHF']);
			expect(getGiftCurrencyPreferences('US')).toEqual(['GBP', 'CHF']);
		});

		test('rejects operator checkout with a configured GBP price', async () => {
			const token = await createPurchaser();
			await createBuilder(harness, token)
				.post('/stripe/checkout/subscription')
				.body({price_id: 'price_opgbpmonthly'})
				.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
				.execute();
			expect(stripeHandlers.spies.createdCheckoutSessions).toHaveLength(0);
		});

		test('rejects checkout even when the operator enables terms and tax', async () => {
			useOperatorBilling({automatic_tax: true, tax_id_collection: true, terms_consent_required: true});
			const token = await createPurchaser();
			await createBuilder(harness, token)
				.post('/stripe/checkout/subscription')
				.body({price_id: 'price_opgbpyearly'})
				.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
				.execute();
			expect(stripeHandlers.spies.createdCheckoutSessions).toHaveLength(0);
		});

		test('rejects checkout even for recognized legacy prices', async () => {
			const token = await createPurchaser();
			await createBuilder(harness, token)
				.post('/stripe/checkout/subscription')
				.body({price_id: 'price_opgbplegacymonthly'})
				.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
				.execute();
			expect(stripeHandlers.spies.createdCheckoutSessions).toHaveLength(0);
		});

		test('hides subscription prices even when the operator configures no gifts', async () => {
			useOperatorBilling({
				prices: {
					GBP: {monthly: 'price_opgbpmonthly', yearly: 'price_opgbpyearly', gift_1_month: null, gift_1_year: null},
				},
			});
			const token = await createPurchaser();
			await createBuilder(harness, token)
				.get('/premium/price-ids?country_code=GB')
				.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
				.execute();
			expect(stripeHandlers.spies.createdCheckoutSessions).toHaveLength(0);
		});

		test('does not fetch or mirror Stripe prices while serving premium state', async () => {
			const monthly = `price_disabled${crypto.randomBytes(4).toString('hex')}monthly`;
			useOperatorBilling({
				prices: {GBP: {monthly, yearly: 'price_disabledyearly', gift_1_month: null, gift_1_year: null}},
			});
			const account = await createAccount();
			const state = await createBuilder<PremiumStateResponse>(harness, account.token)
				.get('/premium/state')
				.expect(HTTP_STATUS.OK)
				.execute();
			expect(state.pricing.localized?.monthly_amount_minor ?? null).toBeNull();
			expect(await getBillingRepository().prices.findById(monthly)).toBeNull();
		});

		test('rejects the operator portal without replacing stored billing identities', async () => {
			const account = await createAccount();
			await createBuilder(harness, account.token)
				.post(`/test/users/${account.userId}/premium`)
				.body({stripe_customer_id: 'cus_from_old_account', stripe_subscription_id: 'sub_from_old_account'})
				.execute();
			useOperatorBilling();
			await createBuilder(harness, account.token)
				.post('/premium/customer-portal')
				.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
				.execute();
			const user = await getUserRepository().findUnique(createUserID(BigInt(account.userId)));
			expect(user?.stripeCustomerId).toBe('cus_from_old_account');
			expect(user?.stripeSubscriptionId).toBe('sub_from_old_account');
			expect(stripeHandlers.spies.createdCheckoutSessions).toHaveLength(0);
		});

		test('rejects configured operator checkout regardless of buyer country', async () => {
			const token = await createPurchaser();
			await createBuilder(harness, token)
				.post('/stripe/checkout/subscription')
				.body({price_id: 'price_opchfyearly', country_code: 'SE'})
				.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
				.execute();
			expect(stripeHandlers.spies.createdCheckoutSessions).toHaveLength(0);
		});

		test('rejects operator checkout before payment method validation', async () => {
			const token = await createPurchaser();
			await createBuilder(harness, token)
				.post('/stripe/checkout/subscription')
				.body({price_id: 'price_opgbpmonthly', payment_method: 'pix'})
				.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
				.execute();
			expect(stripeHandlers.spies.createdCheckoutSessions).toHaveLength(0);
		});

		test('rejects self-hosted gift checkout with a configured premium tier', async () => {
			const token = await createPurchaser();
			await createBuilder(harness, token)
				.post('/stripe/checkout/gift')
				.body({price_id: 'price_opgbpgiftmonth'})
				.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
				.execute();
			expect(stripeHandlers.spies.createdCheckoutSessions).toHaveLength(0);
		});
	});

	describe('stripe client', () => {
		test('remains unavailable when the stored secret changes', async () => {
			useOperatorBilling();
			expect(getStripeClient()).toBeNull();
			setStoredBillingConfig(operatorBilling({stripe_secret_key: 'sk_test_operator_b'}));
			expect(getStripeClient()).toBeNull();
			expect(isBillingActive()).toBe(false);
		});

		test('keeps servicing unavailable on self-hosted even with stored credentials', async () => {
			useOperatorBilling({enabled: false});
			expect(isBillingActive()).toBe(false);
			expect(getStripeClient()).toBeNull();
		});

		test('is unavailable on hosted when env billing is disabled', () => {
			const enabled = Config.stripe.enabled;
			Config.stripe.enabled = false;
			try {
				setStoredBillingConfig(operatorBilling({enabled: true}));
				expect(getStripeClient()).toBeNull();
			} finally {
				Config.stripe.enabled = enabled;
			}
		});

		test('sends no Stripe requests after stored credentials rotate', async () => {
			const authorizations: Array<string | null> = [];
			server.use(
				http.get('https://api.stripe.com/v1/prices/:id', ({request}) => {
					authorizations.push(request.headers.get('authorization'));
					return HttpResponse.json({});
				}),
			);
			for (const key of ['sk_test_rotate_a', 'sk_test_rotate_b']) {
				useOperatorBilling({stripe_secret_key: key});
				await createBuilder(harness, '')
					.get('/premium/price-ids')
					.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.NOT_FOUND)
					.execute();
			}
			expect(authorizations).toEqual([]);
		});
	});

	describe('premium purchase availability', () => {
		test('reports purchases enabled with Payriff active and Stripe inactive', async () => {
			const enabled = Config.payriff.enabled;
			try {
				useOperatorBilling({enabled: false});
				Config.payriff.enabled = true;
				expect(isBillingActive()).toBe(false);
				const account = await createAccount();
				const state = await createBuilder<PremiumStateResponse>(harness, account.token)
					.get('/premium/state')
					.expect(HTTP_STATUS.OK)
					.execute();
				expect(state.effective.premium_purchase_disabled).toBe(false);
			} finally {
				Config.payriff.enabled = enabled;
			}
		});

		test('reports purchases disabled while billing is inactive', async () => {
			Config.stripe.prices = {};
			expect(isBillingActive()).toBe(false);
			const account = await createAccount();
			const state = await createBuilder<PremiumStateResponse>(harness, account.token)
				.get('/premium/state')
				.expect(HTTP_STATUS.OK)
				.execute();
			expect(state.effective.premium_purchase_disabled).toBe(true);
			expect(state.billing.list_price_switch.reason).toBe('feature_unavailable');
		});

		test('reports purchases disabled despite configured Stripe catalog', async () => {
			expect(isBillingActive()).toBe(false);
			const account = await createAccount();
			const state = await createBuilder<PremiumStateResponse>(harness, account.token)
				.get('/premium/state')
				.expect(HTTP_STATUS.OK)
				.execute();
			expect(state.effective.premium_purchase_disabled).toBe(true);
		});

		test('reports purchases disabled on a self-hosted instance where everyone is premium', async () => {
			Config.instance.selfHosted = true;
			setCachedInstancePremiumMode('everyone');
			setStoredBillingConfig(operatorBilling());
			expect(isBillingActive()).toBe(false);
			const account = await createAccount();
			const state = await createBuilder<PremiumStateResponse>(harness, account.token)
				.get('/premium/state')
				.expect(HTTP_STATUS.OK)
				.execute();
			expect(state.effective.premium_purchase_disabled).toBe(true);
		});
	});
	describe('webhook secret', () => {
		beforeEach(() => {
			setupSyncStripeWebhookWorker();
			Config.stripe.webhookSecret = ENV_WEBHOOK_SECRET;
			useOperatorBilling();
		});

		async function sendWebhook(secret: string): Promise<number> {
			const {payload, timestamp} = createMockWebhookPayload({
				type: 'customer.created',
				data: {object: {id: `cus_operator_${crypto.randomBytes(4).toString('hex')}`}},
			});
			const {response} = await createBuilder(harness, '')
				.post('/stripe/webhook')
				.header('stripe-signature', signWebhook(payload, timestamp, secret))
				.header('content-type', 'application/json')
				.body(payload)
				.executeRaw();
			return response.status;
		}

		test('hides the Stripe webhook even with a valid stored signature', async () => {
			expect(await sendWebhook(STORED_WEBHOOK_SECRET)).toBe(HTTP_STATUS.NOT_FOUND);
		});

		test('hides the Stripe webhook before validating an env signature', async () => {
			expect(await sendWebhook(ENV_WEBHOOK_SECRET)).toBe(HTTP_STATUS.NOT_FOUND);
		});

		function signedJob(secret: string): {body: string; signature: string} {
			const {payload, timestamp} = createMockWebhookPayload({
				type: 'customer.created',
				data: {object: {id: `cus_operator_${crypto.randomBytes(4).toString('hex')}`}},
			});
			return {body: payload, signature: signWebhook(payload, timestamp, secret)};
		}

		test('accepts a queued event signed with the previous secret in the worker after a rotation', async () => {
			setStoredBillingConfig(operatorBilling({stripe_webhook_secret: 'whsec_operator_rotated'}));
			await expect(processStripeWebhook(signedJob(STORED_WEBHOOK_SECRET), WORKER_HELPERS)).resolves.toBeUndefined();
			await expect(processStripeWebhook(signedJob('whsec_operator_rotated'), WORKER_HELPERS)).resolves.toBeUndefined();
			await expect(processStripeWebhook(signedJob('whsec_never_configured'), WORKER_HELPERS)).rejects.toThrow();
		});

		test('retries instead of discarding a queued event when the self-hosted worker has no Stripe client', async () => {
			setWorkerDependenciesForTest({stripe: null});
			await expect(processStripeWebhook(signedJob(STORED_WEBHOOK_SECRET), WORKER_HELPERS)).rejects.toThrow();
		});

		test('still discards a queued event on hosted when Stripe is not configured', async () => {
			Config.instance.selfHosted = false;
			setWorkerDependenciesForTest({stripe: null});
			await expect(processStripeWebhook(signedJob(ENV_WEBHOOK_SECRET), WORKER_HELPERS)).resolves.toBeUndefined();
		});
	});
});

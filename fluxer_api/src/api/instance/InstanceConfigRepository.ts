// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from 'node:crypto';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import type {APIConfig, BlueskyOAuthConfig, BlueskyOAuthKeyConfig} from '@app/api/config/APIConfig';
import type {StoredLimitConfig} from '@app/api/constants/LimitConfig';
import {executeConditional, fetchMany, fetchOne, upsertOne} from '@app/api/database/CassandraQueryExecution';
import {Db, type PreparedQuery} from '@app/api/database/CassandraTypes';
import type {InstanceConfigurationRow} from '@app/api/database/types/InstanceConfigTypes';
import {syncChannelThreadsConfig} from '@app/api/experiment/ChannelThreadsGate';
import type {IStorageService} from '@app/api/infrastructure/IStorageService';
import {
	type AccountIdentity,
	getCachedAccountIdentityFetchedAt,
	invalidateCachedAccountIdentity,
	resolveAccountIdentity,
	type StoredAccountIdentity,
	setCachedAccountIdentity,
	type UsernameMigrationConfig,
} from '@app/api/instance/AccountIdentityModeCache';
import {
	BRANDING_ASSET_FIELDS,
	type BrandingAssetField,
	brandingAssetReferenceFromAnyUrl,
	brandingAssetStorageKey,
	isBrandingAssetReference,
	mapBrandingAssets,
	resolveBrandingAsset,
	toStoredBrandingAsset,
} from '@app/api/instance/BrandingAssetReferences';
import {
	getDefaultDateOfBirthCollection,
	setCachedDateOfBirthCollection,
} from '@app/api/instance/DateOfBirthCollectionCache';
import {InstanceConfigCache} from '@app/api/instance/InstanceConfigCache';
import {setCachedConfiguredLegalUrls} from '@app/api/instance/LegalUrls';
import {OfficialAppsEligibilityCache} from '@app/api/instance/OfficialAppsEligibilityCache';
import {getDefaultProductName, setCachedProductName} from '@app/api/instance/ProductName';
import {isSetupTokenEnforced} from '@app/api/instance/SetupToken';
import {normalizeSsoAllowedEmailDomains} from '@app/api/instance/SsoConfigValidation';
import {Logger} from '@app/api/Logger';
import {isStoredLimitConfig} from '@app/api/limits/LimitConfigValidation';
import {
	getEffectiveBillingConfig,
	isBillingActive,
	isStripeServiceable,
	setStoredBillingConfig,
} from '@app/api/stripe/BillingConfigCache';
import {InstanceConfiguration, Users} from '@app/api/Tables';
import {resolveDeferredPhoneGateEnabled, setCachedDeferredPhoneGateEnabled} from '@app/api/user/DeferredPhoneGateCache';
import {DEFAULT_DECAY_CONSTANTS, DEFAULT_RENEWAL_CONSTANTS} from '@app/api/utils/AttachmentDecay';
import {isJsonRecord} from '@app/api/utils/JsonBoundaryUtils';
import {randomBase64Url, secretMatchesHash, sha256Hex} from '@app/api/utils/SecretHash';
import {
	type AccountIdentityMode,
	AccountIdentityModes,
	type TagStyle,
	TagStyles,
} from '@fluxer/constants/src/AccountIdentityConstants';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {resolveSmtpTlsMode, type SmtpTlsMode, smtpTlsModeFromSecure} from '@fluxer/constants/src/SmtpConstants';
import {ConflictError} from '@fluxer/errors/src/domains/core/ConflictError';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';
import {
	InstanceConfigResponse,
	InstanceConfigUpdateRequest,
	type InstanceEmailSmtpTestRequest,
	PendingRegistrationResponse,
	type RegistrationUrlResponse,
} from '@fluxer/schema/src/domains/admin/AdminSchemas';
import {
	type CaptchaConfig,
	CaptchaConfigSchema,
	type CaptchaConfigUpdateRequest,
	type StoredCaptchaIntegrationProvider,
	StoredCaptchaIntegrationProviderSchema,
} from '@fluxer/schema/src/domains/admin/CaptchaSchemas';
import {
	type ChannelThreadsConfig,
	everyoneChannelThreadsConfig,
} from '@fluxer/schema/src/domains/admin/ChannelThreadsSchemas';
import {
	type DomainMigrationConfig,
	DomainMigrationConfigSchema,
} from '@fluxer/schema/src/domains/admin/DomainMigrationSchemas';
import {
	type GatewayRolloutConfig,
	GatewayRolloutConfigSchema,
} from '@fluxer/schema/src/domains/admin/GatewayRolloutSchemas';
import {
	type BillingCatalogMode,
	type StoredBillingConfig,
	StoredBillingConfigSchema,
} from '@fluxer/schema/src/domains/admin/InstanceBillingSchemas';
import {
	type LegacyPushServiceDeliveryWire,
	type PushRelayConfig,
	PushRelayConfigSchema,
	toLegacyPushServiceDeliveryWire,
} from '@fluxer/schema/src/domains/admin/PushRelaySchemas';
import {
	UsernameHeldManifestSchema,
	UsernameStoredGuildCapacitySchema,
} from '@fluxer/schema/src/domains/admin/UsernameSchemas';
import {
	type VoiceNoiseSuppressionConfig,
	VoiceNoiseSuppressionConfigSchema,
} from '@fluxer/schema/src/domains/admin/VoiceNoiseSuppressionSchemas';
import {type VoiceP2pConfig, VoiceP2pConfigSchema} from '@fluxer/schema/src/domains/admin/VoiceP2pSchemas';
import {type VoiceRoomConfig, VoiceRoomConfigSchema} from '@fluxer/schema/src/domains/admin/VoiceRoomConfigSchemas';
import {
	type ExperimentDeliveryConfig,
	ExperimentDeliveryConfigSchema,
} from '@fluxer/schema/src/domains/experiment/ExperimentSchemas';
import {
	type InstanceAppPublic,
	InstanceAppPublicSchema,
	type InstanceBranding,
	type InstanceCaptchaProvider,
	type InstanceCommunity,
	type InstanceRegistration,
	InstanceRegistrationSchema,
	type InstanceServices,
	type InstanceSetup,
} from '@fluxer/schema/src/domains/instance/InstanceSchemas';
import {
	CreateReferralTierRequest,
	ReferralTierReward,
	UpdateReferralSettingsRequest,
} from '@fluxer/schema/src/domains/referral/ReferralRequestSchemas';
import {UpdateShopSettingsRequest} from '@fluxer/schema/src/domains/shop/ShopAdminSchemas';
import {normalizeString, SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';
import {z} from 'zod';

const GATEWAY_ROLLOUT_CONFIG_KEY = 'gateway_rollout_config';
const VOICE_NOISE_SUPPRESSION_CONFIG_KEY = 'voice_noise_suppression_config';
const VOICE_ROOM_CONFIG_KEY = 'voice_room_config';
const PUSH_RELAY_CONFIG_KEY = 'push_service_delivery_config';
const DOMAIN_MIGRATION_CONFIG_KEY = 'domain_migration_config';
const VOICE_P2P_CONFIG_KEY = 'voice_p2p_config';
const CAPTCHA_CONFIG_KEY = 'captcha_config';
const CHANNEL_THREADS_CONFIG_KEY = 'channel_threads_config';
const EXPERIMENT_DELIVERY_CONFIG_KEY = 'experiment_delivery_config';
const REGISTRATION_CONFIG_KEY = 'registration_config';
const REGISTRATION_URLS_KEY = 'registration_urls';
const REGISTRATION_PENDING_APPROVALS_KEY = 'registration_pending_approvals';
const APP_PUBLIC_CONFIG_KEY = 'app_public_config';
const ADMIN_BOOTSTRAP_KEY = 'admin_bootstrapped';
const ADMIN_BOOTSTRAP_USER_ID_KEY = 'admin_bootstrap_user_id';
const SETUP_TOKEN_HASH_KEY = 'setup_token_hash';
const INSTANCE_POLICY_CONFIG_KEY = 'instance_policy_config';
const LIMIT_CONFIG_KEY = 'limit_config';
const INSTANCE_INTEGRATIONS_CONFIG_KEY = 'instance_integrations_config';
const INSTANCE_MEDIA_CONFIG_KEY = 'instance_media_config';
const SHOP_CONFIG_KEY = 'shop_config';
const REFERRAL_CONFIG_KEY = 'referral_config';
const INSTANCE_BILLING_CONFIG_KEY = 'instance_billing_config';
const ACCOUNT_IDENTITY_CONFIG_KEY = 'account_identity_config';
const USERNAME_POLICY_CONFIG_KEY = 'username_policy';
const USERNAME_MIGRATION_SCAN_CONFIG_KEY = 'username_migration_scan';
const USERNAME_REPAIR_STATE_CONFIG_KEY = 'username_repair_state';
export const INSTANCE_CONFIG_REFRESH_CHANNEL = 'instance-config-refresh';
export const REGISTRATION_PENDING_APPROVAL_TRAIT = 'registration_pending_approval';
export const REGISTRATION_REJECTED_TRAIT = 'registration_rejected';
export const INSTANCE_CONFIG_WRITE_ATTEMPTS = 5;

export class InstanceConfigWriteConflictError extends ConflictError {
	constructor(key: string) {
		super({
			code: APIErrorCodes.CONFLICT,
			message: `Instance config "${key}" changed concurrently on all ${INSTANCE_CONFIG_WRITE_ATTEMPTS} write attempts. Nothing was written. Retry the change.`,
		});
		this.name = 'InstanceConfigWriteConflictError';
	}
}

interface StoredValueUpdate<T> {
	value: string | null;
	result: T;
}

export type InstanceRegistrationConfig = InstanceRegistration;

interface InstanceAppPublicConfig extends Omit<InstanceAppPublic, 'setup'> {
	setup: Pick<InstanceSetup, 'configured'>;
}

type InstanceBrandingPatch = Partial<Omit<InstanceBranding, 'premium_product_name'>> & {
	premium_product_name?: string | null;
};

export type InstanceBillingConfig = StoredBillingConfig;

type InstanceBillingPriceSetPatch = Partial<NonNullable<StoredBillingConfig['prices']>[string]>;

export interface InstanceBillingConfigPatch {
	enabled?: boolean | null;
	stripe_secret_key?: string | null;
	stripe_webhook_secret?: string | null;
	automatic_tax?: boolean | null;
	tax_id_collection?: boolean | null;
	terms_consent_required?: boolean | null;
	default_currency?: string | null;
	prices?: Record<string, InstanceBillingPriceSetPatch> | null;
	country_currencies?: Record<string, string> | null;
	legacy_prices?: Record<string, Array<string>> | null;
}

export interface InstanceBillingAdminConfig {
	enabled: boolean | null;
	effective_enabled: boolean;
	stripe_secret_key_set: boolean;
	stripe_webhook_secret_set: boolean;
	stripe_secret_key_stored: boolean;
	stripe_webhook_secret_stored: boolean;
	automatic_tax: boolean | null;
	tax_id_collection: boolean | null;
	terms_consent_required: boolean | null;
	effective_automatic_tax: boolean;
	effective_tax_id_collection: boolean;
	effective_terms_consent_required: boolean;
	default_currency: string | null;
	prices: StoredBillingConfig['prices'];
	country_currencies: StoredBillingConfig['country_currencies'];
	legacy_prices: StoredBillingConfig['legacy_prices'];
	billing_active: boolean;
	stripe_serviceable: boolean;
	catalog_mode: BillingCatalogMode;
	webhook_url: string;
}

export type InstancePremiumMode = 'mirror' | 'everyone';

// Micup shop settings; not an instance feature, so the public instance response never shows them.
// sanalyer: prices are Turkish lira, so Micup's USD to AZN rate and CBAR TL display rate settings are gone.
export interface ShopConfig {
	premium_sales_open: boolean;
	item_sales_open: boolean;
	premium_discount_percent: number;
	visionary_on_sale: boolean;
	visionary_reward_item_ids: Array<string>;
	// Early Plus: the catalog badge paid premium and Visionary orders get while the period is open.
	early_plus_badge_id: string | null;
	early_plus_open: boolean;
	// Set by the first opening; from then on the badge is fixed.
	early_plus_opened_once: boolean;
}

// Micup referral programme; like the shop settings, never in the public instance response.
export interface ReferralTierConfig {
	id: string;
	threshold: number;
	reward: ReferralTierReward;
	enabled: boolean;
	created_at: string;
}

export interface ReferralConfig {
	enabled: boolean;
	min_active_days: number;
	daily_valid_cap: number;
	ip_registration_limit: number;
	tiers: Array<ReferralTierConfig>;
}

interface LimitConfigInputs {
	config: StoredLimitConfig | null;
	premiumMode: InstancePremiumMode;
}

export interface InstancePolicyConfig {
	deferred_phone_gate_enabled: boolean;
	single_community_enabled: boolean;
	single_community_guild_id: string | null;
	direct_messages_disabled: boolean;
	direct_messages_locked: boolean;
	premium_mode: InstancePremiumMode;
	premium_trial_days: number;
	official_apps: Array<{application_id: string; invite_permissions: string}>;
	guild_create_access: boolean;
	gif_enabled: boolean | null;
	youtube_enabled: boolean | null;
	bluesky_enabled: boolean | null;
}

type InstanceEmailProvider = 'smtp' | 'none';

interface InstanceGifIntegrationConfig {
	klipy_api_key: string | null;
}

interface InstanceYoutubeIntegrationConfig {
	api_key: string | null;
}

interface InstanceCaptchaIntegrationConfig {
	provider: StoredCaptchaIntegrationProvider | null;
	hcaptcha_site_key: string | null;
	hcaptcha_secret_key: string | null;
	turnstile_site_key: string | null;
	turnstile_secret_key: string | null;
}

interface InstanceEmailSmtpIntegrationConfig {
	host: string | null;
	port: number | null;
	username: string | null;
	password: string | null;
	tls_mode: SmtpTlsMode | null;
	secure: boolean | null;
}

interface InstanceEmailIntegrationConfig {
	enabled: boolean | null;
	provider: InstanceEmailProvider | null;
	from_email: string | null;
	from_name: string | null;
	smtp: InstanceEmailSmtpIntegrationConfig;
	disable_new_ip_authorization: boolean | null;
}

interface InstanceBlueskyKeyIntegrationConfig {
	kid: string;
	private_key: string | null;
}

interface InstanceBlueskyIntegrationConfig {
	enabled: boolean | null;
	client_name: string | null;
	client_uri: string | null;
	logo_uri: string | null;
	tos_uri: string | null;
	policy_uri: string | null;
	keys: Array<InstanceBlueskyKeyIntegrationConfig>;
}

interface InstanceIntegrationsConfig {
	gif: InstanceGifIntegrationConfig;
	youtube: InstanceYoutubeIntegrationConfig;
	captcha: InstanceCaptchaIntegrationConfig;
	email: InstanceEmailIntegrationConfig;
	bluesky: InstanceBlueskyIntegrationConfig;
}

interface InstanceGifEffectiveConfig {
	klipy_api_key: string | null;
	active_api_key: string | null;
	available: boolean;
}

export type InstanceCaptchaEffectiveConfig = CaptchaConfig &
	(
		| {provider: 'turnstile'; turnstile_site_key: string; turnstile_secret_key: string}
		| {provider: Exclude<InstanceCaptchaProvider, 'turnstile'>; turnstile_site_key: null; turnstile_secret_key: null}
	);

interface InstanceIntegrationsAdminConfig {
	gif: {
		klipy_api_key_set: boolean;
		effective_available: boolean;
	};
	youtube: {
		api_key_set: boolean;
		effective_available: boolean;
	};
	captcha: {
		provider: StoredCaptchaIntegrationProvider | null;
		effective_provider: InstanceCaptchaProvider;
		turnstile_site_key: string | null;
		turnstile_secret_key_set: boolean;
		effective_enabled: boolean;
	};
	email: {
		enabled: boolean | null;
		effective_enabled: boolean;
		provider: InstanceEmailProvider | null;
		effective_provider: InstanceEmailProvider;
		from_email: string | null;
		from_name: string | null;
		smtp: {
			host: string | null;
			port: number | null;
			username: string | null;
			password_set: boolean;
			tls_mode: SmtpTlsMode | null;
			effective_tls_mode: SmtpTlsMode | null;
		};
		disable_new_ip_authorization: boolean;
		effective_disable_new_ip_authorization: boolean;
	};
	bluesky: {
		enabled: boolean | null;
		effective_enabled: boolean;
		client_name: string | null;
		client_uri: string | null;
		logo_uri: string | null;
		tos_uri: string | null;
		policy_uri: string | null;
		key_count: number;
	};
}

interface InstanceAttachmentDecayConfig {
	enabled: boolean | null;
	min_size_mb: number | null;
	max_size_mb: number | null;
	max_eligible_size_mb: number | null;
	min_lifetime_days: number | null;
	max_lifetime_days: number | null;
	curve: number | null;
	renew_threshold_days: number | null;
	renew_window_days: number | null;
}

interface InstanceMediaConfig {
	attachment_decay: InstanceAttachmentDecayConfig;
}

export interface InstanceAttachmentDecayEffectiveConfig {
	enabled: boolean;
	min_size_mb: number;
	max_size_mb: number;
	max_eligible_size_mb: number;
	min_lifetime_days: number;
	max_lifetime_days: number;
	curve: number;
	renew_threshold_days: number;
	renew_window_days: number;
}

interface InstanceMediaAdminConfig {
	attachment_decay: InstanceAttachmentDecayConfig & {
		effective: InstanceAttachmentDecayEffectiveConfig;
	};
}

interface InstanceIntegrationsConfigPatch {
	gif?: Partial<InstanceGifIntegrationConfig>;
	youtube?: Partial<InstanceYoutubeIntegrationConfig>;
	captcha?: Partial<InstanceCaptchaIntegrationConfig>;
	email?: Partial<Omit<InstanceEmailIntegrationConfig, 'smtp'>> & {
		smtp?: Partial<Omit<InstanceEmailSmtpIntegrationConfig, 'secure'>>;
	};
	bluesky?: Partial<Omit<InstanceBlueskyIntegrationConfig, 'keys'>> & {
		keys?: Array<Partial<InstanceBlueskyKeyIntegrationConfig>>;
	};
}

interface InstanceMediaConfigPatch {
	attachment_decay?: Partial<InstanceAttachmentDecayConfig>;
}

export interface InstanceRegistrationUrl extends RegistrationUrlResponse {
	code_hash: string;
}

type InstanceRegistrationUrlPublic = RegistrationUrlResponse;
type InstancePendingRegistration = PendingRegistrationResponse;

export interface RegistrationUrlClaim {
	registration_url_id: string;
	user_id: string;
}

const DEFAULT_REGISTRATION_CONFIG: InstanceRegistrationConfig = {
	mode: 'open',
	admin_registration_urls_enabled: true,
};
const FETCH_CONFIG_QUERY = InstanceConfiguration.selectCql({
	where: InstanceConfiguration.where.eq('key'),
	limit: 1,
});
const FETCH_ALL_CONFIG_QUERY = InstanceConfiguration.selectCql();
const FETCH_ANY_USER_QUERY = Users.selectCql({columns: ['user_id'], limit: 1, unordered: true});
const FETCH_LIMIT_CONFIG_INPUTS_QUERY = InstanceConfiguration.selectCql({
	where: InstanceConfiguration.where.in('key', 'keys'),
});

function parseStoredLimitConfig(raw: string | null): StoredLimitConfig | null {
	if (raw === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		Logger.error({error}, 'Stored limit configuration is not valid JSON, falling back to default limits');
		return null;
	}
	if (!isStoredLimitConfig(parsed)) {
		Logger.error('Stored limit configuration has an invalid shape, falling back to default limits');
		return null;
	}
	return parsed;
}

function normalizeOptionalString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeOptionalPublicString(value: string | null | undefined, fallback: string | null): string | null {
	return value === undefined ? fallback : normalizeOptionalString(value);
}

function normalizeThemeColor(value: unknown): string | null {
	const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(normalizeOptionalString(value) ?? '');
	if (match === null) return null;
	const digits = match[1].toLowerCase();
	const color = `#${digits.length === 3 ? digits.replace(/./g, '$&$&') : digits}`;
	return color === '#000000' ? null : color;
}

function getDefaultPremiumProductName(): string {
	return Config.instance.selfHosted ? 'Premium' : 'Plutonium';
}

function getDefaultAppPublicConfig(): InstanceAppPublicConfig {
	return {
		branding: {
			product_name: getDefaultProductName(),
			icon_url: normalizeOptionalString(Config.instance.branding.iconUrl),
			symbol_url: normalizeOptionalString(Config.instance.branding.symbolUrl),
			logo_url: normalizeOptionalString(Config.instance.branding.logoUrl),
			wordmark_url: normalizeOptionalString(Config.instance.branding.wordmarkUrl),
			favicon_url: normalizeOptionalString(Config.instance.branding.faviconUrl),
			theme_color: normalizeThemeColor(Config.instance.branding.themeColor),
			status_page_url: normalizeOptionalString(Config.instance.branding.statusPageUrl),
			status_page_incident_history_url: normalizeOptionalString(Config.instance.branding.statusPageIncidentHistoryUrl),
			premium_product_name: getDefaultPremiumProductName(),
			premium_info_url: null,
		},
		setup: {
			configured: !Config.instance.selfHosted || Config.instance.setup.configured,
		},
		legal: {
			terms_url: null,
			privacy_url: null,
			guidelines_url: null,
			source_url: null,
		},
		registration: {
			collect_date_of_birth: getDefaultDateOfBirthCollection(),
		},
		localization: {default_locale: null, default_locale_time_zones: []},
	};
}

type StoredConfigSection =
	| 'app public'
	| 'gateway rollout'
	| 'voice noise suppression'
	| 'voice room'
	| 'push relay'
	| 'domain migration'
	| 'voice p2p'
	| 'captcha'
	| 'channel threads'
	| 'experiment delivery'
	| 'instance policy'
	| 'integrations'
	| 'media'
	| 'shop'
	| 'referral'
	| 'billing'
	| 'registration'
	| 'registration URLs'
	| 'pending registrations'
	| 'SSO flags'
	| 'SSO allowed domains'
	| 'account identity';

function parseStoredConfigValue(raw: string | null, section: StoredConfigSection): unknown {
	if (raw === null) return {};
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error(`Stored ${section} configuration is not valid JSON`);
	}
}

function describeInvalidFields(issues: ReadonlyArray<{path: ReadonlyArray<PropertyKey>}>, index?: number): string {
	const maxReportedIssues = 8;
	const invalidFields = new Set(
		issues.slice(0, maxReportedIssues).map((issue) => {
			const path = index === undefined ? issue.path : [index, ...issue.path];
			return path.length === 0 ? '<root>' : path.join('.');
		}),
	);
	const suffix = issues.length > maxReportedIssues ? ', ...' : '';
	return `${[...invalidFields].join(', ')}${suffix}`;
}

function validateStoredConfig<T>(
	schema: z.ZodType<T>,
	value: unknown,
	section: StoredConfigSection,
	index?: number,
): T {
	const result = schema.safeParse(value);
	if (!result.success) {
		throw new Error(
			`Stored ${section} configuration has invalid fields: ${describeInvalidFields(result.error.issues, index)}`,
		);
	}
	return result.data;
}

function removeStoredPaths(value: unknown, paths: ReadonlyArray<ReadonlyArray<PropertyKey>>): void {
	const arrays = new Set<Array<unknown>>();
	for (const path of paths) {
		let parent: unknown = value;
		for (const key of path.slice(0, -1)) {
			if (typeof parent !== 'object' || parent === null) break;
			parent = (parent as Record<PropertyKey, unknown>)[key];
		}
		if (typeof parent !== 'object' || parent === null) continue;
		delete (parent as Record<PropertyKey, unknown>)[path.at(-1)!];
		if (Array.isArray(parent)) arrays.add(parent);
	}
	for (const array of arrays) {
		array.splice(0, array.length, ...array.filter(() => true));
	}
}

function salvageStoredConfig<T>(schema: z.ZodType<T>, value: unknown, section: StoredConfigSection): T {
	const strict = schema.safeParse(value);
	if (strict.success) return strict.data;
	Logger.error(
		{section, invalidFields: describeInvalidFields(strict.error.issues)},
		'Invalid stored instance configuration, falling back to defaults for the invalid fields',
	);
	const signature = (issues: ReadonlyArray<{path: ReadonlyArray<PropertyKey>}>) =>
		issues.map((issue) => issue.path.join('.')).join('|');
	const salvaged = structuredClone(value);
	let issues = strict.error.issues;
	let trim = 0;
	for (let attempt = 0; attempt < 64; attempt++) {
		const paths = issues.map((issue) => issue.path.slice(0, Math.max(0, issue.path.length - trim)));
		if (paths.some((path) => path.length === 0)) break;
		removeStoredPaths(salvaged, paths);
		const result = schema.safeParse(salvaged);
		if (result.success) return result.data;
		trim = signature(result.error.issues) === signature(issues) ? trim + 1 : 0;
		issues = result.error.issues;
	}
	return schema.parse({});
}

function parseStoredConfig<T>(schema: z.ZodType<T>, raw: string | null, section: StoredConfigSection): T {
	return validateStoredConfig(schema, parseStoredConfigValue(raw, section), section);
}

function readStoredConfigOrDefault<T>(section: StoredConfigSection, decode: () => T, fallback: () => T): T {
	try {
		return decode();
	} catch (error) {
		Logger.error({error, section}, 'Invalid stored instance configuration, falling back to defaults');
		return fallback();
	}
}

function parseStoredConfigOrDefault<T>(schema: z.ZodType<T>, raw: string | null, section: StoredConfigSection): T {
	return readStoredConfigOrDefault(
		section,
		() => parseStoredConfig(schema, raw, section),
		() => parseStoredConfig(schema, null, section),
	);
}

function readStoredConfigValue(raw: string | null, section: StoredConfigSection): unknown {
	return readStoredConfigOrDefault(
		section,
		() => parseStoredConfigValue(raw, section),
		() => ({}),
	);
}

function checkStoredConfig(section: StoredConfigSection, decode: () => unknown): void {
	readStoredConfigOrDefault(section, decode, () => null);
}

export type AccountIdentityDecisionSource = 'new_instance' | 'existing_instance' | 'setup' | 'migration';

const SafeCounterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const UsernameMigrationConfigSchema = z
	.object({
		state: z.enum(['legacy', 'preparing', 'selecting']),
		epoch: SafeCounterSchema,
		preparing_at: z.iso.datetime().nullable().optional(),
		started_at: z.iso.datetime().nullable(),
		forced_at: z.iso.datetime().nullable(),
	})
	.superRefine((value, ctx) => {
		if (
			value.state === 'legacy' &&
			(value.preparing_at != null || value.started_at !== null || value.forced_at !== null)
		) {
			ctx.addIssue({code: 'custom', message: 'Legacy migration cannot contain active dates'});
		}
		if (value.state !== 'legacy' && (value.epoch === 0 || !value.preparing_at)) {
			ctx.addIssue({code: 'custom', message: 'Active migration requires a durable preparation time'});
		}
		if (value.state === 'preparing' && (value.started_at !== null || value.forced_at !== null)) {
			ctx.addIssue({code: 'custom', message: 'Preparing migration cannot contain selection dates'});
		}
		if (
			value.state === 'selecting' &&
			value.preparing_at &&
			value.started_at &&
			Date.parse(value.started_at) < Date.parse(value.preparing_at) + 60_000
		) {
			ctx.addIssue({code: 'custom', message: 'Selecting migration requires the preparation barrier'});
		}
		if (
			value.state === 'selecting' &&
			(value.started_at === null ||
				value.forced_at === null ||
				Date.parse(value.forced_at) !== Date.parse(value.started_at) + 7 * 24 * 60 * 60 * 1000)
		) {
			ctx.addIssue({code: 'custom', message: 'Selecting migration requires immutable seven-day dates'});
		}
	});
const UsernameTierSchema = z.enum(['locked', 'for_sale', 'public']);
const UsernamePolicyConfigSchema = z
	.object({
		revision: SafeCounterSchema,
		tiers: z.object({'1': UsernameTierSchema, '2': UsernameTierSchema, '3': UsernameTierSchema}),
		dictionary_gen: SafeCounterSchema,
		previous_dictionary_gen: SafeCounterSchema.default(0),
		dictionary_hash: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.nullable(),
		next_dictionary_gen: SafeCounterSchema,
		admission: z.object({global_per_second: SafeCounterSchema, paused: z.boolean()}),
		held_manifest: UsernameHeldManifestSchema.nullable().default(null),
	})
	.refine(
		(value) =>
			value.next_dictionary_gen > value.dictionary_gen &&
			(value.previous_dictionary_gen === 0 || value.previous_dictionary_gen < value.dictionary_gen) &&
			(value.dictionary_gen === 0) === (value.dictionary_hash === null),
		{message: 'Invalid dictionary generation pointer'},
	);
export type UsernamePolicyConfig = z.infer<typeof UsernamePolicyConfigSchema>;
export interface UsernameDictionaryGenerationReservation {
	generation: number;
	baseRevision: number;
	baseGeneration: number;
	baseHash: string | null;
	createdAt: string;
}
const UsernameDictionaryGenerationMetadataSchema = z.object({created_at: z.iso.datetime()});
export type UsernameDictionaryGenerationMetadata = z.infer<typeof UsernameDictionaryGenerationMetadataSchema>;
const UsernameDictionaryCleanupStateSchema = z.object({day: z.iso.date(), cursor: SafeCounterSchema.min(1)});
export type UsernameDictionaryCleanupState = z.infer<typeof UsernameDictionaryCleanupStateSchema>;
const UsernameMigrationScanSchema = z
	.object({
		epoch: SafeCounterSchema,
		cursor: z.string().nullable(),
		scanned: SafeCounterSchema,
		found: SafeCounterSchema,
		done_at: z.iso.datetime().nullable(),
	})
	.refine((value) => value.found <= value.scanned, {message: 'Found count exceeds scanned count'});
export type UsernameMigrationScan = z.infer<typeof UsernameMigrationScanSchema>;
const UsernameRepairStateSchema = z.record(z.string(), z.json());
export type UsernameRepairState = z.infer<typeof UsernameRepairStateSchema>;

function parseUsernamePolicyConfig(raw: string | null): UsernamePolicyConfig {
	return UsernamePolicyConfigSchema.parse(
		raw === null
			? {
					revision: 0,
					tiers: {'1': 'locked', '2': 'locked', '3': 'locked'},
					dictionary_gen: 0,
					dictionary_hash: null,
					next_dictionary_gen: 1,
					admission: {global_per_second: 0, paused: true},
				}
			: JSON.parse(raw),
	);
}

function migrationFromStored(stored: StoredAccountIdentityConfig | null): UsernameMigrationConfig {
	return stored?.username_migration ?? {state: 'legacy', epoch: 0, started_at: null, forced_at: null};
}

const StoredAccountIdentityConfigSchema = z.object({
	mode: z.enum([AccountIdentityModes.EMAIL, AccountIdentityModes.USERNAME]),
	tag_style: z.enum([TagStyles.NONE, 'zero_first', TagStyles.RANDOM]).optional(),
	unique_usernames: z.boolean().optional(),
	decided_at: z.string(),
	source: z.enum(['new_instance', 'existing_instance', 'setup', 'migration']),
	username_migration: UsernameMigrationConfigSchema.optional(),
	username_reserve_version: SafeCounterSchema.optional(),
	username_reserve_mutation_pending: z.boolean().optional(),
});

type StoredAccountIdentityConfig = z.infer<typeof StoredAccountIdentityConfigSchema>;

function parseStoredAccountIdentityConfig(raw: string | null): StoredAccountIdentityConfig | null {
	if (raw === null) return null;
	return validateStoredConfig(
		StoredAccountIdentityConfigSchema,
		parseStoredConfigValue(raw, 'account identity'),
		'account identity',
	);
}

function readStoredAccountIdentity(raw: string | null): StoredAccountIdentity | null {
	try {
		const stored = parseStoredAccountIdentityConfig(raw);
		return stored
			? {
					mode: stored.mode,
					tagStyle: readStoredTagStyle(stored),
					...(stored.username_migration ? {usernameMigration: stored.username_migration} : {}),
				}
			: null;
	} catch (error) {
		invalidateCachedAccountIdentity(error instanceof Error ? error : new Error('Invalid stored account identity'));
		throw error;
	}
}

function readStoredAccountIdentitySource(raw: string | null): AccountIdentityDecisionSource | null {
	return parseStoredAccountIdentityConfig(raw)?.source ?? null;
}

function readStoredTagStyle(stored: StoredAccountIdentityConfig): TagStyle {
	if (stored.mode === AccountIdentityModes.USERNAME) return TagStyles.NONE;
	if (stored.tag_style === 'zero_first') return TagStyles.NONE;
	if (stored.tag_style) return stored.tag_style;
	return stored.unique_usernames === true ? TagStyles.NONE : TagStyles.RANDOM;
}

function serialiseAccountIdentity(identity: StoredAccountIdentity, source: AccountIdentityDecisionSource): string {
	return JSON.stringify({
		mode: identity.mode,
		tag_style: identity.tagStyle,
		decided_at: new Date().toISOString(),
		source,
		...(identity.usernameMigration ? {username_migration: identity.usernameMigration} : {}),
	});
}

function decodeGatewayRolloutConfig(value: unknown): GatewayRolloutConfig {
	const input =
		isJsonRecord(value) &&
		!Object.hasOwn(value, 'rpc_request_timeout_ms') &&
		Object.hasOwn(value, 'nats_request_timeout_ms')
			? {...value, rpc_request_timeout_ms: value.nats_request_timeout_ms}
			: value;
	return validateStoredConfig(GatewayRolloutConfigSchema, input, 'gateway rollout');
}

function parseStoredGatewayRolloutConfig(raw: string | null): GatewayRolloutConfig {
	return decodeGatewayRolloutConfig(parseStoredConfigValue(raw, 'gateway rollout'));
}

const StoredPushRelayConfigSchema = PushRelayConfigSchema.extend({
	config_version: z.number().int().min(0).default(0),
});

function parseStoredPushRelayConfig(raw: string | null): LegacyPushServiceDeliveryWire {
	const {config_version, ...config} = salvageStoredConfig(
		StoredPushRelayConfigSchema,
		readStoredConfigValue(raw, 'push relay'),
		'push relay',
	);
	return toLegacyPushServiceDeliveryWire(config, config_version);
}

function parseStoredVoiceNoiseSuppressionConfig(raw: string | null): VoiceNoiseSuppressionConfig {
	return parseStoredConfigOrDefault(VoiceNoiseSuppressionConfigSchema, raw, 'voice noise suppression');
}

// A broken stored value falls back to the defaults, which keep rooms and games off.
function parseStoredVoiceRoomConfig(raw: string | null): VoiceRoomConfig {
	// Removing a manifest theme defaults the whole stored voice_room config; change its default theme before removal.
	return parseStoredConfigOrDefault(VoiceRoomConfigSchema, raw, 'voice room');
}

function toPushRelayConfig(wire: LegacyPushServiceDeliveryWire): PushRelayConfig {
	return {
		relay_consent_accepted: wire.relay_consent_accepted,
		relay_consent_accepted_at: wire.relay_consent_accepted_at,
		relay_consent_accepted_by: wire.relay_consent_accepted_by,
	};
}

function parseStoredDomainMigrationConfig(raw: string | null): DomainMigrationConfig {
	return parseStoredConfigOrDefault(DomainMigrationConfigSchema, raw, 'domain migration');
}

function parseStoredVoiceP2pConfig(raw: string | null): VoiceP2pConfig {
	return parseStoredConfigOrDefault(VoiceP2pConfigSchema, raw, 'voice p2p');
}

function parseStoredCaptchaConfig(raw: string | null): CaptchaConfig {
	return parseStoredConfigOrDefault(CaptchaConfigSchema, raw, 'captcha');
}

const StoredChannelThreadsVersionSchema = z.object({config_version: z.number().int().min(0)});

function parseStoredChannelThreadsConfig(raw: string | null): ChannelThreadsConfig {
	const stored = StoredChannelThreadsVersionSchema.safeParse(readStoredConfigValue(raw, 'channel threads'));
	return everyoneChannelThreadsConfig(stored.success ? stored.data.config_version : 0);
}

function parseStoredExperimentDeliveryConfig(raw: string | null): ExperimentDeliveryConfig {
	return parseStoredConfigOrDefault(ExperimentDeliveryConfigSchema, raw, 'experiment delivery');
}

function validateStoredCollection<T>(schema: z.ZodType<T>, value: unknown, section: StoredConfigSection): Array<T> {
	if (!Array.isArray(value)) {
		throw new Error(`Stored ${section} configuration must be an array`);
	}
	return Array.from(value, (entry, index) => validateStoredConfig(schema, entry, section, index));
}

function parseStoredCollection<T>(schema: z.ZodType<T>, raw: string | null, section: StoredConfigSection): Array<T> {
	return raw === null ? [] : validateStoredCollection(schema, parseStoredConfigValue(raw, section), section);
}

const StoredInstanceAppPublicSchema = InstanceAppPublicSchema.extend({
	branding: InstanceAppPublicSchema.shape.branding
		.extend({premium_product_name: z.string().max(40).nullable()})
		.partial()
		.optional(),
	setup: InstanceAppPublicSchema.shape.setup.pick({configured: true}).partial().optional(),
	legal: InstanceAppPublicSchema.shape.legal.partial().optional(),
	registration: InstanceAppPublicSchema.shape.registration.partial().optional(),
	localization: InstanceAppPublicSchema.shape.localization.unwrap().partial().optional(),
});

function parseStoredAppPublicConfig(raw: string | null): InstanceAppPublicConfig {
	return resolveAppPublicConfig(
		buildAppPublicConfig(
			salvageStoredConfig(StoredInstanceAppPublicSchema, readStoredConfigValue(raw, 'app public'), 'app public'),
		),
	);
}

function resolveAppPublicConfig(config: InstanceAppPublicConfig): InstanceAppPublicConfig {
	return {
		...config,
		branding: mapBrandingAssets(config.branding, (value) =>
			resolveBrandingAsset(value ?? null, Config.endpoints.media),
		),
	};
}

function toStoredBranding<T extends Partial<Record<BrandingAssetField, string | null>>>(branding: T): T {
	return mapBrandingAssets(branding, (value) => toStoredBrandingAsset(value, Config.endpoints.media));
}

function buildAppPublicConfig(config: z.infer<typeof StoredInstanceAppPublicSchema>): InstanceAppPublicConfig {
	const defaults = getDefaultAppPublicConfig();
	const {branding = {}, setup = {}, legal = {}, registration = {}, localization = {}} = config;
	return {
		branding: {
			product_name: normalizeOptionalString(branding.product_name) ?? defaults.branding.product_name,
			icon_url: normalizeOptionalPublicString(branding.icon_url, defaults.branding.icon_url),
			symbol_url: normalizeOptionalPublicString(branding.symbol_url, defaults.branding.symbol_url),
			logo_url: normalizeOptionalPublicString(branding.logo_url, defaults.branding.logo_url),
			wordmark_url: normalizeOptionalPublicString(branding.wordmark_url, defaults.branding.wordmark_url),
			favicon_url: normalizeOptionalPublicString(branding.favicon_url, defaults.branding.favicon_url),
			theme_color:
				branding.theme_color === undefined ? defaults.branding.theme_color : normalizeThemeColor(branding.theme_color),
			status_page_url: normalizeOptionalPublicString(branding.status_page_url, defaults.branding.status_page_url),
			status_page_incident_history_url: normalizeOptionalPublicString(
				branding.status_page_incident_history_url,
				defaults.branding.status_page_incident_history_url,
			),
			premium_product_name:
				normalizeOptionalString(branding.premium_product_name) ?? defaults.branding.premium_product_name,
			premium_info_url: normalizeOptionalPublicString(branding.premium_info_url, defaults.branding.premium_info_url),
		},
		setup: {
			configured: setup.configured ?? defaults.setup.configured,
		},
		legal: {
			terms_url: normalizeOptionalPublicString(legal.terms_url, defaults.legal.terms_url),
			privacy_url: normalizeOptionalPublicString(legal.privacy_url, defaults.legal.privacy_url),
			guidelines_url: normalizeOptionalPublicString(legal.guidelines_url, defaults.legal.guidelines_url),
			source_url: normalizeOptionalPublicString(legal.source_url, defaults.legal.source_url),
		},
		registration: {
			collect_date_of_birth: registration.collect_date_of_birth ?? defaults.registration.collect_date_of_birth,
		},
		localization: {
			default_locale: localization.default_locale ?? null,
			default_locale_time_zones: localization.default_locale_time_zones ?? [],
		},
	};
}

const InstancePolicyUpdateSchema = InstanceConfigUpdateRequest.shape.policy.unwrap().unwrap();
const InstancePolicyServiceUpdateSchema = InstancePolicyUpdateSchema.shape.services.unwrap().unwrap();
const StoredSnowflakeStringSchema = z
	.string()
	.refine((value) => value.length <= 19 && !/\D/.test(value) && SnowflakeType.safeParse(value).success);
const StoredInstancePolicySchema = z.object({
	deferred_phone_gate_enabled: z.boolean().default(false),
	single_community_enabled: InstancePolicyUpdateSchema.shape.single_community_enabled.default(false),
	single_community_guild_id: StoredSnowflakeStringSchema.nullable().default(null),
	direct_messages_disabled: InstancePolicyUpdateSchema.shape.direct_messages_disabled.default(false),
	direct_messages_locked: z.boolean().default(false),
	premium_mode: InstancePolicyUpdateSchema.shape.premium_mode.default('everyone'),
	premium_trial_days: InstancePolicyUpdateSchema.shape.premium_trial_days.default(0),
	official_apps: InstancePolicyUpdateSchema.shape.official_apps.default([]),
	guild_create_access: InstancePolicyUpdateSchema.shape.guild_create_access.default(true),
	gif_enabled: InstancePolicyServiceUpdateSchema.shape.gif_enabled.default(null),
	youtube_enabled: InstancePolicyServiceUpdateSchema.shape.youtube_enabled.default(null),
	bluesky_enabled: InstancePolicyServiceUpdateSchema.shape.bluesky_enabled.default(null),
}) satisfies z.ZodType<InstancePolicyConfig>;

function decodeInstancePolicyConfig(value: unknown): InstancePolicyConfig {
	return validateStoredConfig(StoredInstancePolicySchema, value, 'instance policy');
}

function parseStoredInstancePolicyConfig(raw: string | null): InstancePolicyConfig {
	return salvageStoredConfig(
		StoredInstancePolicySchema,
		readStoredConfigValue(raw, 'instance policy'),
		'instance policy',
	);
}

// Both sales start closed; the bounds are the admin request's.
const StoredShopConfigSchema = z.object({
	premium_sales_open: z.boolean().default(false),
	item_sales_open: z.boolean().default(false),
	premium_discount_percent: UpdateShopSettingsRequest.shape.premium_discount_percent.unwrap().default(0),
	visionary_on_sale: z.boolean().default(false),
	visionary_reward_item_ids: z.array(StoredSnowflakeStringSchema).max(10).default([]),
	early_plus_badge_id: StoredSnowflakeStringSchema.nullable().default(null),
	early_plus_open: z.boolean().default(false),
	early_plus_opened_once: z.boolean().default(false),
}) satisfies z.ZodType<ShopConfig>;

function parseStoredShopConfig(raw: string | null): ShopConfig {
	return salvageStoredConfig(StoredShopConfigSchema, readStoredConfigValue(raw, 'shop'), 'shop');
}

// The programme starts closed; the bounds are the admin requests'. At most 50 tiers keeps the blob and every
// evaluation's tier scan small.
const StoredReferralConfigSchema = z.object({
	enabled: z.boolean().default(false),
	min_active_days: UpdateReferralSettingsRequest.shape.min_active_days.unwrap().default(3),
	daily_valid_cap: UpdateReferralSettingsRequest.shape.daily_valid_cap.unwrap().default(50),
	ip_registration_limit: UpdateReferralSettingsRequest.shape.ip_registration_limit.unwrap().default(3),
	tiers: z
		.array(
			z.object({
				id: StoredSnowflakeStringSchema,
				threshold: CreateReferralTierRequest.shape.threshold,
				reward: ReferralTierReward,
				enabled: z.boolean(),
				created_at: z.iso.datetime(),
			}),
		)
		.max(50)
		.default([]),
}) satisfies z.ZodType<ReferralConfig>;

function parseStoredReferralConfig(raw: string | null): ReferralConfig {
	return salvageStoredConfig(StoredReferralConfigSchema, readStoredConfigValue(raw, 'referral'), 'referral');
}

const IntegrationUpdateSchema = InstanceConfigUpdateRequest.shape.integrations.unwrap().unwrap();
const EmailIntegrationUpdateSchema = IntegrationUpdateSchema.shape.email.unwrap().unwrap();
const SmtpIntegrationUpdateSchema = EmailIntegrationUpdateSchema.shape.smtp.unwrap().unwrap();
const StoredIntegrationStringSchema = z
	.string()
	.trim()
	.nullable()
	.default(null)
	.transform((value) => value || null);
const StoredNullableBooleanSchema = z.boolean().nullable().default(null);
const StoredBlueskyKeysSchema = z
	.array(z.object({kid: z.string().trim().min(1), private_key: StoredIntegrationStringSchema}))
	.default([])
	.refine((keys) => {
		const activeIds = new Set<string>();
		for (const key of keys) {
			if (key.private_key === null) continue;
			if (activeIds.has(key.kid)) return false;
			activeIds.add(key.kid);
		}
		return true;
	});
const StoredInstanceIntegrationsSchema = z.object({
	gif: z.object({klipy_api_key: StoredIntegrationStringSchema}).prefault({}),
	youtube: z.object({api_key: StoredIntegrationStringSchema}).prefault({}),
	captcha: z
		.object({
			provider: StoredCaptchaIntegrationProviderSchema.nullable().default(null),
			hcaptcha_site_key: StoredIntegrationStringSchema,
			hcaptcha_secret_key: StoredIntegrationStringSchema,
			turnstile_site_key: StoredIntegrationStringSchema,
			turnstile_secret_key: StoredIntegrationStringSchema,
		})
		.prefault({}),
	email: z
		.object({
			enabled: StoredNullableBooleanSchema,
			provider: EmailIntegrationUpdateSchema.shape.provider.default(null),
			from_email: StoredIntegrationStringSchema,
			from_name: StoredIntegrationStringSchema,
			smtp: z
				.object({
					host: StoredIntegrationStringSchema,
					port: SmtpIntegrationUpdateSchema.shape.port.default(null),
					username: StoredIntegrationStringSchema,
					password: StoredIntegrationStringSchema,
					tls_mode: SmtpIntegrationUpdateSchema.shape.tls_mode.default(null),
					secure: StoredNullableBooleanSchema,
				})
				.prefault({}),
			disable_new_ip_authorization: StoredNullableBooleanSchema,
		})
		.prefault({}),
	bluesky: z
		.object({
			enabled: StoredNullableBooleanSchema,
			client_name: StoredIntegrationStringSchema,
			client_uri: StoredIntegrationStringSchema,
			logo_uri: StoredIntegrationStringSchema,
			tos_uri: StoredIntegrationStringSchema,
			policy_uri: StoredIntegrationStringSchema,
			keys: StoredBlueskyKeysSchema,
		})
		.prefault({}),
}) satisfies z.ZodType<InstanceIntegrationsConfig>;

function decodeInstanceIntegrationsConfig(value: unknown): InstanceIntegrationsConfig {
	return validateStoredConfig(StoredInstanceIntegrationsSchema, value, 'integrations');
}

function parseStoredInstanceIntegrationsConfig(raw: string | null): InstanceIntegrationsConfig {
	return salvageStoredConfig(
		StoredInstanceIntegrationsSchema,
		readStoredConfigValue(raw, 'integrations'),
		'integrations',
	);
}

function decodeInstanceBillingConfig(value: unknown): InstanceBillingConfig {
	return validateStoredConfig(StoredBillingConfigSchema, value, 'billing');
}

function parseStoredInstanceBillingConfig(raw: string | null): InstanceBillingConfig {
	return salvageStoredConfig(StoredBillingConfigSchema, readStoredConfigValue(raw, 'billing'), 'billing');
}

function normalizeBillingPrices(
	prices: Record<string, InstanceBillingPriceSetPatch> | null,
): Record<string, InstanceBillingPriceSetPatch> | null {
	if (prices === null) return null;
	const entries = Object.entries(prices).map(([currency, set]): [string, InstanceBillingPriceSetPatch] => [
		currency,
		{
			monthly: set.monthly ?? null,
			yearly: set.yearly ?? null,
			gift_1_month: set.gift_1_month ?? null,
			gift_1_year: set.gift_1_year ?? null,
		},
	]);
	return entries.length === 0 ? null : Object.fromEntries(entries);
}

function secretIsSet(value: unknown): boolean {
	return typeof value === 'string' && value.trim().length > 0;
}

const AttachmentDecayUpdateSchema = InstanceConfigUpdateRequest.shape.media
	.unwrap()
	.unwrap()
	.shape.attachment_decay.unwrap()
	.unwrap();
const StoredAttachmentDecaySchema = z
	.object({
		enabled: AttachmentDecayUpdateSchema.shape.enabled.default(null),
		min_size_mb: AttachmentDecayUpdateSchema.shape.min_size_mb.default(null),
		max_size_mb: AttachmentDecayUpdateSchema.shape.max_size_mb.default(null),
		max_eligible_size_mb: AttachmentDecayUpdateSchema.shape.max_eligible_size_mb.default(null),
		min_lifetime_days: AttachmentDecayUpdateSchema.shape.min_lifetime_days.default(null),
		max_lifetime_days: AttachmentDecayUpdateSchema.shape.max_lifetime_days.default(null),
		curve: AttachmentDecayUpdateSchema.shape.curve.default(null),
		renew_threshold_days: AttachmentDecayUpdateSchema.shape.renew_threshold_days.default(null),
		renew_window_days: AttachmentDecayUpdateSchema.shape.renew_window_days.default(null),
	})
	.transform(normalizeAttachmentDecayBounds)
	.refine(
		(value) => {
			const minSizeMb = value.min_size_mb ?? DEFAULT_DECAY_CONSTANTS.MIN_MB;
			const maxSizeMb = computeAttachmentDecayMaxSize(minSizeMb, value.max_size_mb ?? DEFAULT_DECAY_CONSTANTS.MAX_MB);
			return Number.isFinite(maxSizeMb) && maxSizeMb > minSizeMb;
		},
		{path: ['min_size_mb']},
	);
const StoredInstanceMediaSchema = z.object({
	attachment_decay: StoredAttachmentDecaySchema.prefault({}),
}) satisfies z.ZodType<InstanceMediaConfig>;

function normalizeAttachmentDecayBounds(value: InstanceAttachmentDecayConfig): InstanceAttachmentDecayConfig {
	const minSizeMb = value.min_size_mb;
	let maxSizeMb = value.max_size_mb;
	let maxEligibleSizeMb = value.max_eligible_size_mb;
	const minLifetimeDays = value.min_lifetime_days;
	let maxLifetimeDays = value.max_lifetime_days;
	if (minSizeMb !== null && maxSizeMb !== null && maxSizeMb <= minSizeMb) {
		maxSizeMb = null;
	}
	if (maxSizeMb !== null && maxEligibleSizeMb !== null && maxEligibleSizeMb < maxSizeMb) {
		maxEligibleSizeMb = null;
	}
	if (minLifetimeDays !== null && maxLifetimeDays !== null && maxLifetimeDays < minLifetimeDays) {
		maxLifetimeDays = null;
	}
	return {
		...value,
		max_size_mb: maxSizeMb,
		max_eligible_size_mb: maxEligibleSizeMb,
		max_lifetime_days: maxLifetimeDays,
	};
}

function computeAttachmentDecayMaxSize(minSizeMb: number, configuredMaxSizeMb: number): number {
	if (configuredMaxSizeMb > minSizeMb) return configuredMaxSizeMb;
	const incrementedMin = minSizeMb + 1;
	const largerMin =
		incrementedMin > minSizeMb ? incrementedMin : Math.min(Number.MAX_VALUE, minSizeMb + minSizeMb * Number.EPSILON);
	return Math.max(DEFAULT_DECAY_CONSTANTS.MAX_MB, largerMin);
}

function decodeInstanceMediaConfig(value: unknown): InstanceMediaConfig {
	return validateStoredConfig(StoredInstanceMediaSchema, value, 'media');
}

function resolveEffectiveAttachmentDecayConfig(media: InstanceMediaConfig): InstanceAttachmentDecayEffectiveConfig {
	const attachmentDecay = media.attachment_decay;
	const minSizeMb = attachmentDecay.min_size_mb ?? DEFAULT_DECAY_CONSTANTS.MIN_MB;
	const configuredMaxSizeMb = attachmentDecay.max_size_mb ?? DEFAULT_DECAY_CONSTANTS.MAX_MB;
	const maxSizeMb = computeAttachmentDecayMaxSize(minSizeMb, configuredMaxSizeMb);
	const configuredMaxEligibleSizeMb = attachmentDecay.max_eligible_size_mb ?? DEFAULT_DECAY_CONSTANTS.PLAN_MB;
	const maxEligibleSizeMb = Math.max(maxSizeMb, configuredMaxEligibleSizeMb);
	const minLifetimeDays = attachmentDecay.min_lifetime_days ?? DEFAULT_DECAY_CONSTANTS.MIN_DAYS;
	const configuredMaxLifetimeDays = attachmentDecay.max_lifetime_days ?? DEFAULT_DECAY_CONSTANTS.MAX_DAYS;
	const maxLifetimeDays =
		configuredMaxLifetimeDays >= minLifetimeDays
			? configuredMaxLifetimeDays
			: Math.max(DEFAULT_DECAY_CONSTANTS.MAX_DAYS, minLifetimeDays);
	return {
		enabled: attachmentDecay.enabled ?? Config.attachmentDecayEnabled,
		min_size_mb: minSizeMb,
		max_size_mb: maxSizeMb,
		max_eligible_size_mb: maxEligibleSizeMb,
		min_lifetime_days: minLifetimeDays,
		max_lifetime_days: maxLifetimeDays,
		curve: attachmentDecay.curve ?? DEFAULT_DECAY_CONSTANTS.CURVE,
		renew_threshold_days: attachmentDecay.renew_threshold_days ?? DEFAULT_RENEWAL_CONSTANTS.RENEW_THRESHOLD_DAYS,
		renew_window_days: attachmentDecay.renew_window_days ?? DEFAULT_RENEWAL_CONSTANTS.RENEW_WINDOW_DAYS,
	};
}

function parseStoredInstanceMediaConfig(raw: string | null): InstanceMediaConfig {
	return decodeInstanceMediaConfig(parseStoredConfigValue(raw, 'media'));
}

type EffectiveSmtpConfig = NonNullable<APIConfig['email']['smtp']>;

interface SmtpTestConfig {
	smtp: EffectiveSmtpConfig;
	problem: string | null;
}

function storedSmtpTlsMode(smtp: InstanceEmailSmtpIntegrationConfig): SmtpTlsMode | null {
	return smtp.tls_mode ?? smtpTlsModeFromSecure(smtp.secure);
}

function resolveEffectiveSmtpConfig(smtp: InstanceEmailSmtpIntegrationConfig): EffectiveSmtpConfig {
	return {
		host: smtp.host ?? Config.email.smtp?.host ?? '',
		port: smtp.port ?? Config.email.smtp?.port ?? 587,
		username: smtp.username ?? Config.email.smtp?.username ?? '',
		password: smtp.password ?? Config.email.smtp?.password ?? '',
		tlsMode: storedSmtpTlsMode(smtp) ?? Config.email.smtp?.tlsMode ?? null,
	};
}

function describeIncompleteSmtpConfig(smtp: EffectiveSmtpConfig): string | null {
	if (!smtp.host.trim()) return 'No SMTP host is configured';
	if (!smtp.port) return 'No SMTP port is configured';
	if (!smtp.username.trim() || !smtp.password.trim()) return 'The SMTP username and password are both required';
	return null;
}

function hasCompleteSmtpConfig(config: APIConfig['email']): boolean {
	if (config.provider !== 'smtp' || !config.smtp) return false;
	return Boolean(config.fromEmail.trim()) && describeIncompleteSmtpConfig(config.smtp) === null;
}

const StoredRegistrationConfigSchema = InstanceRegistrationSchema.extend({
	mode: InstanceRegistrationSchema.shape.mode.default(DEFAULT_REGISTRATION_CONFIG.mode),
	admin_registration_urls_enabled: InstanceRegistrationSchema.shape.admin_registration_urls_enabled.default(
		DEFAULT_REGISTRATION_CONFIG.admin_registration_urls_enabled,
	),
});

function decodeRegistrationConfig(value: unknown): InstanceRegistrationConfig {
	const input =
		isJsonRecord(value) &&
		!Object.hasOwn(value, 'admin_registration_urls_enabled') &&
		Object.hasOwn(value, 'adminRegistrationUrlsEnabled')
			? {...value, admin_registration_urls_enabled: value.adminRegistrationUrlsEnabled}
			: value;
	return validateStoredConfig(StoredRegistrationConfigSchema, input, 'registration');
}

function parseStoredRegistrationConfig(raw: string | null): InstanceRegistrationConfig {
	return decodeRegistrationConfig(parseStoredConfigValue(raw, 'registration'));
}

const RegistrationUrlSchema = InstanceConfigResponse.shape.registration.shape.urls.element;
const StoredRegistrationTimestampSchema = z.iso
	.datetime({offset: true})
	.refine((value) => value === value.trim() && Number.isFinite(Date.parse(value)))
	.transform((value): string => new Date(value).toISOString())
	.pipe(RegistrationUrlSchema.shape.created_at);
const StoredNullableStringSchema = z
	.string()
	.nullable()
	.default(null)
	.transform((value) => (value === null || value.trim().length === 0 ? null : value));
const StoredRegistrationUrlIdSchema = z
	.string()
	.min(1)
	.max(128)
	.refine((value) => normalizeString(value) === value);
const StoredRegistrationUrlSchema = RegistrationUrlSchema.extend({
	id: StoredRegistrationUrlIdSchema,
	label: StoredNullableStringSchema,
	code_hash: z
		.string()
		.length(64)
		.regex(/^[a-f0-9]{64}$/),
	created_by_user_id: StoredSnowflakeStringSchema,
	created_at: StoredRegistrationTimestampSchema,
	expires_at: StoredRegistrationTimestampSchema.nullable().default(null),
	max_uses: RegistrationUrlSchema.shape.max_uses.default(null),
	use_count: RegistrationUrlSchema.shape.use_count.default(0),
	revoked_at: StoredRegistrationTimestampSchema.nullable().default(null),
	approval_required: RegistrationUrlSchema.shape.approval_required.default(false),
	last_used_at: StoredRegistrationTimestampSchema.nullable().default(null),
	last_used_by_user_id: StoredNullableStringSchema.pipe(StoredSnowflakeStringSchema.nullable()),
}) satisfies z.ZodType<InstanceRegistrationUrl>;
const StoredPendingRegistrationSchema = PendingRegistrationResponse.extend({
	user_id: StoredSnowflakeStringSchema,
	discriminator: PendingRegistrationResponse.shape.discriminator.default(0),
	global_name: StoredNullableStringSchema,
	email: StoredNullableStringSchema,
	requested_at: StoredRegistrationTimestampSchema,
	registration_url_id: StoredNullableStringSchema.pipe(StoredRegistrationUrlIdSchema.nullable()),
	client_ip: StoredNullableStringSchema,
	invite_code: StoredNullableStringSchema,
}) satisfies z.ZodType<InstancePendingRegistration>;

function isRegistrationUrlUsable(registrationUrl: InstanceRegistrationUrl, now: Date): boolean {
	if (registrationUrl.revoked_at) return false;
	if (registrationUrl.expires_at && Date.parse(registrationUrl.expires_at) <= now.getTime()) return false;
	if (registrationUrl.max_uses !== null && registrationUrl.use_count >= registrationUrl.max_uses) return false;
	return true;
}

function redactRegistrationUrl(registrationUrl: InstanceRegistrationUrl): InstanceRegistrationUrlPublic {
	const {code_hash: _codeHash, ...redacted} = registrationUrl;
	return redacted;
}

interface InstanceSsoFlags {
	enabled: boolean;
	enforced: boolean;
	autoProvision: boolean;
}

export interface InstanceSsoConfig extends InstanceSsoFlags {
	displayName: string | null;
	issuer: string | null;
	authorizationUrl: string | null;
	tokenUrl: string | null;
	userInfoUrl: string | null;
	jwksUrl: string | null;
	clientId: string | null;
	clientSecret?: string | null;
	clientSecretSet?: boolean;
	scope: string | null;
	allowedEmailDomains: Array<string>;
	redirectUri: string | null;
}

const MAX_SSO_ALLOWED_DOMAINS = 100;

function readStoredSsoBoolean(
	configs: ReadonlyMap<string, string>,
	key: 'sso_enabled' | 'sso_enforced' | 'sso_auto_provision',
	fallback: boolean,
	options?: {invalidFallback?: boolean; log?: boolean},
): boolean {
	const value = configs.get(key);
	if (value === undefined) return fallback;
	if (value === 'true') return true;
	if (value === 'false') return false;
	if (options?.log) {
		Logger.warn({key}, 'Invalid stored SSO flag, falling back to its default');
	}
	return options?.invalidFallback ?? fallback;
}

function readStoredSsoFlags(configs: ReadonlyMap<string, string>, log = false): InstanceSsoFlags {
	const enabled = readStoredSsoBoolean(configs, 'sso_enabled', false, {log});
	return {
		enabled,
		enforced: readStoredSsoBoolean(configs, 'sso_enforced', enabled, {invalidFallback: false, log}),
		autoProvision: readStoredSsoBoolean(configs, 'sso_auto_provision', true, {log}),
	};
}

function parseStoredSsoAllowedEmailDomains(raw: string | undefined, log = false): Array<string> {
	if (raw === undefined || raw.trim().length === 0) return [];
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		value = null;
	}
	const entries: ReadonlyArray<unknown> = Array.isArray(value) ? value : raw.split(',');
	const domains = new Set<string>();
	const unusable = new Set<string>();
	for (const entry of entries) {
		try {
			for (const domain of normalizeSsoAllowedEmailDomains([entry])) {
				domains.add(domain);
			}
		} catch {
			const text = String(entry).trim();
			if (text.length > 0) unusable.add(text);
		}
	}
	if (domains.size === 0 && unusable.size > 0) {
		if (log) {
			Logger.error(
				{unusable: unusable.size},
				'Every stored SSO allowed email domain is invalid, keeping them so the allowlist still matches nothing',
			);
		}
		return Array.from(unusable).slice(0, MAX_SSO_ALLOWED_DOMAINS);
	}
	if (log && unusable.size > 0) {
		Logger.warn({dropped: unusable.size}, 'Dropped invalid stored SSO allowed email domains');
	}
	if (log && domains.size > MAX_SSO_ALLOWED_DOMAINS) {
		Logger.warn(
			{dropped: domains.size - MAX_SSO_ALLOWED_DOMAINS},
			'Truncated the stored SSO allowed email domain list to its maximum length',
		);
	}
	return Array.from(domains).slice(0, MAX_SSO_ALLOWED_DOMAINS);
}

function readStoredSsoConfig(
	configs: ReadonlyMap<string, string>,
	options?: {includeSecret?: boolean},
): InstanceSsoConfig {
	const flags = readStoredSsoFlags(configs);
	const read = (key: string): string | null => {
		const v = configs.get(key);
		if (!v) return null;
		const trimmed = v.trim();
		return trimmed.length === 0 ? null : trimmed;
	};
	const allowedDomains = parseStoredSsoAllowedEmailDomains(configs.get('sso_allowed_domains'));
	const clientSecret = read('sso_client_secret');
	return {
		...flags,
		displayName: read('sso_display_name'),
		issuer: read('sso_issuer'),
		authorizationUrl: read('sso_authorization_url'),
		tokenUrl: read('sso_token_url'),
		userInfoUrl: read('sso_userinfo_url'),
		jwksUrl: read('sso_jwks_url'),
		clientId: read('sso_client_id'),
		clientSecret: options?.includeSecret ? clientSecret : undefined,
		clientSecretSet: Boolean(clientSecret),
		scope: read('sso_scope'),
		allowedEmailDomains: allowedDomains,
		redirectUri: null,
	};
}

interface SsoRowWrite {
	key: string;
	value: string | undefined;
	unset: string;
}

function ssoRow<T>(key: string, value: T | undefined, current: T, format: (value: T) => string): SsoRowWrite {
	return {key, value: value === undefined ? undefined : format(value), unset: format(current)};
}

function nextSsoRowValue(row: SsoRowWrite, raw: string | null): string | null {
	const value = row.value ?? raw ?? row.unset;
	return value === raw ? null : value;
}

function formatSsoBoolean(value: boolean): string {
	return value ? 'true' : 'false';
}

function formatSsoString(value: string | null): string {
	return value ?? '';
}

function formatSsoDomains(value: Array<string>): string {
	return JSON.stringify(value);
}

function normalizeSsoAllowedEmailDomainsForWrite(domains: Array<string>, enabled: boolean): Array<string> {
	try {
		return normalizeSsoAllowedEmailDomains(domains);
	} catch (error) {
		if (enabled) {
			throw error;
		}
		Logger.warn({error}, 'Clearing invalid SSO allowed domain config while SSO is disabled');
		return [];
	}
}

// Micup: one direct identity read per process at a time, shared by every concurrent caller.
let identityRefresh: Promise<string | null> | null = null;
let identityRefreshStartedAt = 0;

export class InstanceConfigRepository {
	static async isOfficialAppCandidate(applicationId: string): Promise<boolean> {
		if (
			applicationId === Config.instance.micupBotApplicationId ||
			applicationId === Config.instance.rosterBotApplicationId
		)
			return true;
		const row = await fetchOne<InstanceConfigurationRow>(FETCH_CONFIG_QUERY, {key: INSTANCE_POLICY_CONFIG_KEY});
		return parseStoredInstancePolicyConfig(row?.value ?? null).official_apps.some(
			(app) => app.application_id === applicationId,
		);
	}

	private readonly kvClient: IKVProvider | null;
	private configCache: InstanceConfigCache;
	private eligibilityCache: OfficialAppsEligibilityCache;
	private effectiveBlueskyConfig: BlueskyOAuthConfig | null = null;
	private effectiveBlueskyConfigSource: string | null = null;

	constructor(kvClient: IKVProvider | null = null) {
		this.kvClient = kvClient;
		this.configCache = this.createConfigCache();
		this.eligibilityCache = this.createEligibilityCache();
	}

	private createEligibilityCache(): OfficialAppsEligibilityCache {
		return new OfficialAppsEligibilityCache(this.kvClient, INSTANCE_CONFIG_REFRESH_CHANNEL, async () => {
			const policy = parseStoredInstancePolicyConfig(await this.fetchConfigFromDatabase(INSTANCE_POLICY_CONFIG_KEY));
			return [
				Config.instance.micupBotApplicationId,
				Config.instance.rosterBotApplicationId,
				...policy.official_apps.map((app) => app.application_id),
			].filter((id): id is string => id !== undefined);
		});
	}

	getOfficialAppEligibility(): Promise<ReadonlySet<string>> {
		return this.eligibilityCache.getEligible();
	}

	getCachedOfficialAppEligibility(): ReadonlySet<string> {
		return this.eligibilityCache.getCachedEligible();
	}

	private createConfigCache(previousShutdown?: Promise<void>): InstanceConfigCache {
		return new InstanceConfigCache(
			{
				provider: this.kvClient,
				channel: INSTANCE_CONFIG_REFRESH_CHANNEL,
				load: () => this.fetchAllConfigsFromDatabase(),
				onRefresh: (snapshot, loadedAt) => this.syncConfigCaches(snapshot, loadedAt),
			},
			previousShutdown,
		);
	}

	async initialize(): Promise<void> {
		const cache = this.configCache;
		const snapshot = await cache.getSnapshot();
		cache.assertActive();
		if (snapshot !== null) return;
		const fetchedAt = Date.now();
		const configs = await this.fetchAllConfigsFromDatabase();
		cache.assertActive();
		this.syncConfigCaches(configs, fetchedAt);
	}

	async getConfig(key: string): Promise<string | null> {
		const cache = this.configCache;
		const snapshot = await cache.getSnapshot();
		cache.assertActive();
		if (snapshot !== null) return snapshot.get(key) ?? null;
		if (key === ACCOUNT_IDENTITY_CONFIG_KEY) return this.refreshAccountIdentity();
		// Micup: without the refresh subscription, direct reads keep the identity snapshot at most one second old.
		const age = Date.now() - Math.max(getCachedAccountIdentityFetchedAt(), identityRefreshStartedAt);
		const due = age >= 1000 || age < 0;
		const [value] = await Promise.all([
			this.fetchConfigFromDatabase(key),
			due &&
				this.refreshAccountIdentity().catch((error) => {
					// Micup: identity writers refuse the aging snapshot; every other caller keeps the last known value.
					Logger.warn({error}, 'Account identity refresh failed');
				}),
		]);
		return value;
	}

	private refreshAccountIdentity(): Promise<string | null> {
		identityRefresh ??= (async () => {
			const fetchedAt = Date.now();
			identityRefreshStartedAt = fetchedAt;
			try {
				const raw = await this.fetchConfigFromDatabase(ACCOUNT_IDENTITY_CONFIG_KEY);
				try {
					setCachedAccountIdentity(readStoredAccountIdentity(raw), fetchedAt);
				} catch {
					// Micup: the parser has already failed the identity cache closed.
				}
				return raw;
			} finally {
				identityRefresh = null;
			}
		})();
		return identityRefresh;
	}

	async getAllConfigs(): Promise<Map<string, string>> {
		const cache = this.configCache;
		const snapshot = await cache.getSnapshot();
		cache.assertActive();
		return snapshot === null ? this.fetchAllConfigsFromDatabase() : new Map(snapshot);
	}

	setConfig(key: string, value: string): Promise<void> {
		return this.setConfigs([[key, value]]);
	}

	private async setConfigs(entries: Array<[string, string]>): Promise<void> {
		if (entries.length === 0) return;
		const cache = this.configCache;
		cache.assertActive();
		const results = await Promise.allSettled(
			entries.map(async ([key, value]) => {
				await this.writeConfig(key, value);
				if (!key.startsWith('username_dictionary_generation:') && key !== 'username_dictionary_cleanup')
					cache.update(key, value);
			}),
		);
		const errors: Array<unknown> = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
		if (results.some((result) => result.status === 'fulfilled')) {
			try {
				await this.publishRefresh(cache.sourceId);
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, 'Failed to write or publish instance config');
	}

	private async writeConfig(key: string, value: string): Promise<void> {
		await upsertOne(
			InstanceConfiguration.upsertAll({
				key,
				value,
				updated_at: new Date(),
			}),
		);
	}

	private async updateStoredConfig<T>(key: string, next: (raw: string | null) => T): Promise<T> {
		const cache = this.configCache;
		const {result} = await this.compareAndSetStoredValue(cache, key, (raw) => {
			const config = next(raw);
			return {value: JSON.stringify(config), result: config};
		});
		await this.publishRefresh(cache.sourceId);
		return result;
	}

	private async compareAndSetStoredValue<T>(
		cache: InstanceConfigCache,
		key: string,
		next: (raw: string | null) => StoredValueUpdate<T> | Promise<StoredValueUpdate<T>>,
		reconcileTimeout = false,
	): Promise<{result: T; written: boolean}> {
		await cache.getSnapshot();
		for (let attempt = 0; attempt < INSTANCE_CONFIG_WRITE_ATTEMPTS; attempt++) {
			cache.assertActive();
			const current = await this.fetchConfigForWrite(key);
			cache.assertActive();
			const {value, result} = await next(current);
			if (value === null) return {result, written: false};
			let applied: boolean;
			try {
				applied = await executeConditional(this.compareAndSetConfig(key, current, value));
			} catch (error) {
				if (!reconcileTimeout || (await this.fetchConfigForWrite(key)) !== value) throw error;
				applied = true;
			}
			if (applied) {
				if (!key.startsWith('username_dictionary_generation:') && key !== 'username_dictionary_cleanup')
					cache.update(key, value);
				return {result, written: true};
			}
		}
		Logger.error(
			{key, attempts: INSTANCE_CONFIG_WRITE_ATTEMPTS},
			'Instance config write lost to a concurrent write on every attempt',
		);
		throw new InstanceConfigWriteConflictError(key);
	}

	private compareAndSetConfig(key: string, current: string | null, value: string): PreparedQuery {
		const updatedAt = new Date();
		if (current === null) {
			return InstanceConfiguration.insertIfNotExists({key, value, updated_at: updatedAt});
		}
		return InstanceConfiguration.conditionalPatchByPk(
			{key},
			{value: Db.set(value), updated_at: Db.set(updatedAt)},
			{value: current},
		);
	}

	private async fetchConfigForWrite(key: string): Promise<string | null> {
		const [row] = await fetchMany<InstanceConfigurationRow>(FETCH_CONFIG_QUERY, {key}, {consistency: 'serial'});
		return row?.value ?? null;
	}

	private async fetchConfigFromDatabase(key: string): Promise<string | null> {
		const row = await fetchOne<InstanceConfigurationRow>(FETCH_CONFIG_QUERY, {key});
		return row?.value ?? null;
	}

	private async fetchAllConfigsFromDatabase(): Promise<Map<string, string>> {
		// Micup: TEMPORARY: Hot config reads include one row per admin generation; move metadata to a dedicated Cassandra table before 10,000 generations.
		const rows = await fetchMany<InstanceConfigurationRow>(FETCH_ALL_CONFIG_QUERY, {});
		const configs = new Map<string, string>();
		for (const row of rows) {
			if (
				row.value != null &&
				!row.key.startsWith('username_dictionary_generation:') &&
				row.key !== 'username_dictionary_cleanup'
			) {
				configs.set(row.key, row.value);
			}
		}
		return configs;
	}

	private syncConfigCaches(snapshot: ReadonlyMap<string, string>, fetchedAt: number): void {
		checkStoredConfig('gateway rollout', () =>
			parseStoredGatewayRolloutConfig(snapshot.get(GATEWAY_ROLLOUT_CONFIG_KEY) ?? null),
		);
		parseStoredVoiceNoiseSuppressionConfig(snapshot.get(VOICE_NOISE_SUPPRESSION_CONFIG_KEY) ?? null);
		parseStoredVoiceRoomConfig(snapshot.get(VOICE_ROOM_CONFIG_KEY) ?? null);
		parseStoredPushRelayConfig(snapshot.get(PUSH_RELAY_CONFIG_KEY) ?? null);
		parseStoredDomainMigrationConfig(snapshot.get(DOMAIN_MIGRATION_CONFIG_KEY) ?? null);
		parseStoredVoiceP2pConfig(snapshot.get(VOICE_P2P_CONFIG_KEY) ?? null);
		parseStoredCaptchaConfig(snapshot.get(CAPTCHA_CONFIG_KEY) ?? null);
		syncChannelThreadsConfig(snapshot.get(CHANNEL_THREADS_CONFIG_KEY) ?? null, parseStoredChannelThreadsConfig);
		parseStoredExperimentDeliveryConfig(snapshot.get(EXPERIMENT_DELIVERY_CONFIG_KEY) ?? null);
		const policy = parseStoredInstancePolicyConfig(snapshot.get(INSTANCE_POLICY_CONFIG_KEY) ?? null);
		setCachedDeferredPhoneGateEnabled(resolveDeferredPhoneGateEnabled(policy));
		checkStoredConfig('registration', () =>
			parseStoredRegistrationConfig(snapshot.get(REGISTRATION_CONFIG_KEY) ?? null),
		);
		checkStoredConfig('registration URLs', () =>
			parseStoredCollection(
				StoredRegistrationUrlSchema,
				snapshot.get(REGISTRATION_URLS_KEY) ?? null,
				'registration URLs',
			),
		);
		checkStoredConfig('pending registrations', () =>
			parseStoredCollection(
				StoredPendingRegistrationSchema,
				snapshot.get(REGISTRATION_PENDING_APPROVALS_KEY) ?? null,
				'pending registrations',
			),
		);
		checkStoredConfig('SSO flags', () => readStoredSsoFlags(snapshot, true));
		checkStoredConfig('SSO allowed domains', () =>
			parseStoredSsoAllowedEmailDomains(snapshot.get('sso_allowed_domains'), true),
		);
		checkStoredConfig('integrations', () =>
			parseStoredInstanceIntegrationsConfig(snapshot.get(INSTANCE_INTEGRATIONS_CONFIG_KEY) ?? null),
		);
		checkStoredConfig('media', () => parseStoredInstanceMediaConfig(snapshot.get(INSTANCE_MEDIA_CONFIG_KEY) ?? null));
		checkStoredConfig('shop', () => parseStoredShopConfig(snapshot.get(SHOP_CONFIG_KEY) ?? null));
		checkStoredConfig('referral', () => parseStoredReferralConfig(snapshot.get(REFERRAL_CONFIG_KEY) ?? null));
		setStoredBillingConfig(parseStoredInstanceBillingConfig(snapshot.get(INSTANCE_BILLING_CONFIG_KEY) ?? null));
		const appPublic = parseStoredAppPublicConfig(snapshot.get(APP_PUBLIC_CONFIG_KEY) ?? null);
		setCachedDateOfBirthCollection(appPublic.registration.collect_date_of_birth);
		setCachedConfiguredLegalUrls(appPublic.legal);
		setCachedProductName(appPublic.branding.product_name);
		setCachedAccountIdentity(readStoredAccountIdentity(snapshot.get(ACCOUNT_IDENTITY_CONFIG_KEY) ?? null), fetchedAt);
	}

	private async publishRefresh(sourceId: string): Promise<void> {
		if (!this.kvClient) {
			return;
		}
		await this.kvClient.publish(
			INSTANCE_CONFIG_REFRESH_CHANNEL,
			JSON.stringify({source_id: sourceId, type: 'refresh'}),
		);
	}

	shutdown(): Promise<void> {
		return Promise.all([this.configCache.shutdown(), this.eligibilityCache.shutdown()]).then(() => undefined);
	}

	clearCacheForTesting(): void {
		setCachedAccountIdentity(null);
		syncChannelThreadsConfig(null, parseStoredChannelThreadsConfig);
		const shutdown = this.shutdown();
		this.configCache = this.createConfigCache(shutdown);
		this.eligibilityCache = this.createEligibilityCache();
		void shutdown.catch((error) => {
			Logger.error({error}, 'Failed to clear instance config cache');
		});
	}

	async isAdminBootstrapped(): Promise<boolean> {
		return (await this.getConfig(ADMIN_BOOTSTRAP_KEY)) === 'true';
	}

	async confirmAdminBootstrapped(): Promise<boolean> {
		const cache = this.configCache;
		const stored = (await this.fetchConfigFromDatabase(ADMIN_BOOTSTRAP_KEY)) === 'true';
		if (stored !== (await this.isAdminBootstrapped())) cache.update(ADMIN_BOOTSTRAP_KEY, stored ? 'true' : 'false');
		return stored;
	}

	async claimAdminBootstrap(userId: UserID | null = null): Promise<boolean> {
		const cache = this.configCache;
		const {written} = await this.compareAndSetStoredValue(cache, ADMIN_BOOTSTRAP_KEY, (raw) => ({
			value: raw === 'true' ? null : 'true',
			result: undefined,
		}));
		if (!written) return false;
		await this.recordAdminBootstrapClaimant(cache, userId);
		await this.publishAdminBootstrapRefresh(cache.sourceId);
		return true;
	}

	private async recordAdminBootstrapClaimant(cache: InstanceConfigCache, userId: UserID | null): Promise<void> {
		const claimant = userId?.toString() ?? '';
		try {
			await this.compareAndSetStoredValue(cache, ADMIN_BOOTSTRAP_USER_ID_KEY, (raw) => ({
				value: (raw ?? '') === claimant ? null : claimant,
				result: undefined,
			}));
		} catch (error) {
			Logger.error({error}, 'Could not record which account claimed the admin bootstrap');
		}
	}

	async getUnconfirmedAdminBootstrapClaimant(): Promise<UserID | null> {
		const [bootstrapped, claimant] = await Promise.all([
			this.fetchConfigFromDatabase(ADMIN_BOOTSTRAP_KEY),
			this.fetchConfigFromDatabase(ADMIN_BOOTSTRAP_USER_ID_KEY),
		]);
		if (bootstrapped !== 'true' || !claimant || !/^\d+$/.test(claimant)) return null;
		return createUserID(BigInt(claimant));
	}

	async releaseAdminBootstrap(): Promise<void> {
		const cache = this.configCache;
		const {written} = await this.compareAndSetStoredValue(cache, ADMIN_BOOTSTRAP_KEY, (raw) => ({
			value: raw === 'true' ? 'false' : null,
			result: undefined,
		}));
		if (written) await this.publishAdminBootstrapRefresh(cache.sourceId);
	}

	private async publishAdminBootstrapRefresh(sourceId: string): Promise<void> {
		try {
			await this.publishRefresh(sourceId);
		} catch (error) {
			Logger.error(
				{error},
				'Could not publish the admin bootstrap change. Other API processes see it after the next instance config change or a restart',
			);
		}
	}

	async isSetupTokenGateOpen(): Promise<boolean> {
		return isSetupTokenEnforced(Config) && !(await this.isAdminBootstrapped());
	}

	async isSetupTokenRequired(): Promise<boolean> {
		return (await this.isSetupTokenGateOpen()) && !(await this.getAppPublicConfig()).setup.configured;
	}

	async createSetupTokenIfAbsent(): Promise<string | null> {
		const token = randomBase64Url(32);
		const {written} = await this.compareAndSetStoredValue(this.configCache, SETUP_TOKEN_HASH_KEY, (raw) => ({
			value: raw ? null : sha256Hex(token),
			result: undefined,
		}));
		return written ? token : null;
	}

	async verifySetupToken(presented: string | null | undefined): Promise<boolean> {
		const expectedHash = Config.instance.setup.token
			? sha256Hex(Config.instance.setup.token)
			: await this.fetchConfigFromDatabase(SETUP_TOKEN_HASH_KEY);
		return secretMatchesHash(presented, expectedHash);
	}

	async burnSetupToken(): Promise<void> {
		await this.compareAndSetStoredValue(this.configCache, SETUP_TOKEN_HASH_KEY, (raw) => ({
			value: raw ? '' : null,
			result: undefined,
		}));
	}

	async getAccountIdentity(): Promise<AccountIdentity> {
		const stored = readStoredAccountIdentity(await this.getConfig(ACCOUNT_IDENTITY_CONFIG_KEY));
		setCachedAccountIdentity(stored, getCachedAccountIdentityFetchedAt());
		return resolveAccountIdentity(stored);
	}

	async getAccountIdentityMode(): Promise<AccountIdentityMode> {
		return (await this.getAccountIdentity()).mode;
	}

	async readAccountIdentityConfig(): Promise<StoredAccountIdentityConfig | null> {
		return parseStoredAccountIdentityConfig(await this.fetchConfigForWrite(ACCOUNT_IDENTITY_CONFIG_KEY));
	}

	async getTagStyle(): Promise<TagStyle> {
		return (await this.getAccountIdentity()).tagStyle;
	}

	async getUsernameMigrationConfig(): Promise<UsernameMigrationConfig> {
		return migrationFromStored(parseStoredAccountIdentityConfig(await this.getConfig(ACCOUNT_IDENTITY_CONFIG_KEY)));
	}

	async readUsernameMigrationConfig(): Promise<UsernameMigrationConfig> {
		return migrationFromStored(
			parseStoredAccountIdentityConfig(await this.fetchConfigForWrite(ACCOUNT_IDENTITY_CONFIG_KEY)),
		);
	}

	async readUsernameMigrationGuildCapacity(): Promise<z.infer<typeof UsernameStoredGuildCapacitySchema> | null> {
		const raw = await this.fetchConfigForWrite('username_migration_guild_capacity');
		return raw === null ? null : UsernameStoredGuildCapacitySchema.parse(JSON.parse(raw));
	}

	async setUsernameMigrationGuildCapacity(
		declaration: z.infer<typeof UsernameStoredGuildCapacitySchema>,
	): Promise<void> {
		const value = UsernameStoredGuildCapacitySchema.parse(declaration);
		const age = Date.now() - Date.parse(value.observed_at);
		if (age < 0 || age >= 3_600_000) throw new Error('Guild capacity declaration is stale');
		await this.compareAndSetStoredValue(
			this.configCache,
			'username_migration_guild_capacity',
			async () => {
				const migration = await this.readUsernameMigrationConfig();
				if (migration.epoch !== value.epoch || !['preparing', 'selecting'].includes(migration.state))
					throw new Error('Guild capacity declaration requires the current active migration epoch');
				return {value: JSON.stringify(value), result: undefined};
			},
			true,
		);
	}

	async prepareUsernameMigration(proof: {processesReady: boolean}): Promise<UsernameMigrationConfig> {
		if (!Config.instance.selfHosted || proof.processesReady !== true)
			throw new Error('Migration processes are not ready');
		const cache = this.configCache;
		const {result, written} = await this.compareAndSetStoredValue(
			cache,
			ACCOUNT_IDENTITY_CONFIG_KEY,
			(raw) => {
				const stored = parseStoredAccountIdentityConfig(raw);
				if (!stored || stored.mode !== AccountIdentityModes.EMAIL) throw new Error('Migration requires email identity');
				const current = migrationFromStored(stored);
				if (current.state === 'selecting') throw new Error('Selecting migration cannot be prepared again');
				if (current.state === 'preparing') return {value: null, result: current};
				const next = UsernameMigrationConfigSchema.parse({
					state: 'preparing',
					epoch: current.epoch + 1,
					preparing_at: new Date(Date.now()).toISOString(),
					started_at: null,
					forced_at: null,
				});
				return {value: JSON.stringify({...stored, source: 'migration', username_migration: next}), result: next};
			},
			true,
		);
		if (written) await this.publishRefresh(cache.sourceId);
		await this.initializeUsernameMigrationScan(result.epoch);
		return result;
	}

	async startUsernameMigration(
		epoch: number,
		proof: {
			policyRevision: number;
			dictionaryGen: number;
			dictionaryHash: string;
			holdsReady: boolean;
			reserveVersion: number;
			capacityReady: boolean;
			mobilePublished: boolean;
		},
	): Promise<UsernameMigrationConfig> {
		if (
			!Config.instance.selfHosted ||
			proof.holdsReady !== true ||
			proof.capacityReady !== true ||
			proof.mobilePublished !== true
		)
			throw new Error('Migration prerequisites are not ready');
		SafeCounterSchema.parse(epoch);
		const cache = this.configCache;
		const {result, written} = await this.compareAndSetStoredValue(
			cache,
			ACCOUNT_IDENTITY_CONFIG_KEY,
			async (raw) => {
				const stored = parseStoredAccountIdentityConfig(raw);
				if (!stored || stored.mode !== AccountIdentityModes.EMAIL) throw new Error('Migration requires email identity');
				const current = migrationFromStored(stored);
				if (current.epoch !== epoch) throw new Error('Migration epoch changed');
				if (current.state === 'selecting') return {value: null, result: current};
				if (stored.username_reserve_mutation_pending || (stored.username_reserve_version ?? 0) !== proof.reserveVersion)
					throw new Error('Reservations changed after the start inspection');
				if (
					current.state !== 'preparing' ||
					!current.preparing_at ||
					Date.now() < Date.parse(current.preparing_at) + 60_000
				)
					throw new Error('Migration preparation barrier is not complete');
				const scan = await this.readUsernameMigrationScan();
				if (
					!scan ||
					scan.epoch !== epoch ||
					!scan.done_at ||
					scan.found !== 0 ||
					Date.parse(scan.done_at) < Date.parse(current.preparing_at) + 60_000 ||
					Date.parse(scan.done_at) > Date.now()
				)
					throw new Error('Migration scan is not complete');
				const policy = await this.readUsernamePolicyConfig();
				if (
					policy.revision !== proof.policyRevision ||
					policy.dictionary_gen < 1 ||
					policy.dictionary_gen !== proof.dictionaryGen ||
					policy.dictionary_hash !== proof.dictionaryHash ||
					policy.admission.global_per_second === 0 ||
					policy.admission.paused
				)
					throw new Error('Migration dictionary or admission is not ready');
				const started = Date.now();
				const next = UsernameMigrationConfigSchema.parse({
					...current,
					state: 'selecting',
					started_at: new Date(started).toISOString(),
					forced_at: new Date(started + 7 * 86400000).toISOString(),
				});
				return {
					value: JSON.stringify({...stored, tag_style: TagStyles.NONE, source: 'migration', username_migration: next}),
					result: next,
				};
			},
			true,
		);
		if (written) await this.publishRefresh(cache.sourceId);
		return result;
	}

	async rollbackUsernameMigration(epoch: number): Promise<UsernameMigrationConfig> {
		if (!Config.instance.selfHosted) throw new Error('Migration requires a self-hosted instance');
		SafeCounterSchema.parse(epoch);
		const cache = this.configCache;
		const {result, written} = await this.compareAndSetStoredValue(
			cache,
			ACCOUNT_IDENTITY_CONFIG_KEY,
			(raw) => {
				const stored = parseStoredAccountIdentityConfig(raw);
				const current = migrationFromStored(stored);
				if (!stored || current.epoch !== epoch || current.state !== 'preparing')
					throw new Error('Only the current preparing migration can be rolled back');
				const next = UsernameMigrationConfigSchema.parse({
					...current,
					state: 'legacy',
					preparing_at: null,
					started_at: null,
					forced_at: null,
				});
				return {value: JSON.stringify({...stored, username_migration: next}), result: next};
			},
			true,
		);
		if (written) await this.publishRefresh(cache.sourceId);
		return result;
	}

	async readUsernameReserveFence(): Promise<{version: number; pending: boolean}> {
		const stored = parseStoredAccountIdentityConfig(await this.fetchConfigForWrite(ACCOUNT_IDENTITY_CONFIG_KEY));
		return {
			version: stored?.username_reserve_version ?? 0,
			pending: stored?.username_reserve_mutation_pending === true,
		};
	}

	// Micup: a reservation change while preparing runs inside this fence; the start CAS requires it closed and unchanged.
	// The fence is read only through serial reads, so no cache refresh is broadcast.
	async openUsernameReserveMutation(): Promise<number | null> {
		const {result} = await this.compareAndSetStoredValue(
			this.configCache,
			ACCOUNT_IDENTITY_CONFIG_KEY,
			(raw) => {
				const stored = parseStoredAccountIdentityConfig(raw);
				if (!stored || migrationFromStored(stored).state !== 'preparing') return {value: null, result: null};
				const version = (stored.username_reserve_version ?? 0) + 1;
				return {
					value: JSON.stringify({
						...stored,
						username_reserve_version: version,
						username_reserve_mutation_pending: true,
					}),
					result: version,
				};
			},
			true,
		);
		return result;
	}

	async closeUsernameReserveMutation(version: number): Promise<void> {
		await this.compareAndSetStoredValue(
			this.configCache,
			ACCOUNT_IDENTITY_CONFIG_KEY,
			(raw) => {
				const stored = parseStoredAccountIdentityConfig(raw);
				if (stored?.username_reserve_version !== version || !stored.username_reserve_mutation_pending)
					return {value: null, result: undefined};
				return {value: JSON.stringify({...stored, username_reserve_mutation_pending: false}), result: undefined};
			},
			true,
		);
	}

	async getUsernamePolicyConfig(): Promise<UsernamePolicyConfig> {
		return parseUsernamePolicyConfig(await this.getConfig(USERNAME_POLICY_CONFIG_KEY));
	}

	async readUsernamePolicyConfig(): Promise<UsernamePolicyConfig> {
		return parseUsernamePolicyConfig(await this.fetchConfigForWrite(USERNAME_POLICY_CONFIG_KEY));
	}

	setUsernamePolicyConfig(
		patch: Partial<Pick<UsernamePolicyConfig, 'tiers' | 'admission' | 'held_manifest'>>,
	): Promise<UsernamePolicyConfig> {
		return this.updateStoredConfig(USERNAME_POLICY_CONFIG_KEY, (raw) => {
			const current = parseUsernamePolicyConfig(raw);
			return UsernamePolicyConfigSchema.parse({...current, ...patch, revision: current.revision + 1});
		});
	}

	async reserveUsernameDictionaryGeneration(): Promise<UsernameDictionaryGenerationReservation> {
		const cache = this.configCache;
		const {result} = await this.compareAndSetStoredValue(cache, USERNAME_POLICY_CONFIG_KEY, (raw) => {
			const current = parseUsernamePolicyConfig(raw);
			const next = UsernamePolicyConfigSchema.parse({...current, next_dictionary_gen: current.next_dictionary_gen + 1});
			return {
				value: JSON.stringify(next),
				result: {
					generation: current.next_dictionary_gen,
					baseRevision: current.revision,
					baseGeneration: current.dictionary_gen,
					baseHash: current.dictionary_hash,
					createdAt: new Date(Date.now()).toISOString(),
				},
			};
		});
		await this.compareAndSetStoredValue(
			cache,
			`username_dictionary_generation:${result.generation}`,
			(raw) => {
				if (raw !== null) throw new Error('Dictionary generation metadata already exists');
				return {value: JSON.stringify({created_at: result.createdAt}), result: undefined};
			},
			true,
		);
		await this.publishRefresh(cache.sourceId);
		return result;
	}

	async publishUsernameDictionaryGeneration(
		reservation: UsernameDictionaryGenerationReservation,
		hash: string,
	): Promise<boolean> {
		const cache = this.configCache;
		const {result, written} = await this.compareAndSetStoredValue(
			cache,
			USERNAME_POLICY_CONFIG_KEY,
			(raw) => {
				const current = parseUsernamePolicyConfig(raw);
				if (current.dictionary_gen === reservation.generation && current.dictionary_hash === hash) {
					return {value: null, result: true};
				}
				if (
					current.revision !== reservation.baseRevision ||
					current.dictionary_gen !== reservation.baseGeneration ||
					current.dictionary_hash !== reservation.baseHash
				) {
					return {value: null, result: false};
				}
				if (reservation.generation <= current.dictionary_gen || reservation.generation >= current.next_dictionary_gen) {
					throw new Error('Dictionary generation was not reserved');
				}
				const next = UsernamePolicyConfigSchema.parse({
					...current,
					previous_dictionary_gen: current.dictionary_gen,
					dictionary_gen: reservation.generation,
					dictionary_hash: hash,
					revision: current.revision + 1,
				});
				return {value: JSON.stringify(next), result: true};
			},
			true,
		);
		if (written) await this.publishRefresh(cache.sourceId);
		return result;
	}

	async readUsernameDictionaryGenerationMetadata(
		generation: number,
	): Promise<UsernameDictionaryGenerationMetadata | null> {
		SafeCounterSchema.min(1).parse(generation);
		const raw = await this.fetchConfigForWrite(`username_dictionary_generation:${generation}`);
		return raw === null ? null : UsernameDictionaryGenerationMetadataSchema.parse(JSON.parse(raw));
	}

	async fenceUsernameDictionaryGenerationCleanup(expected: {
		revision: number;
		dictionary_gen: number;
		previous_dictionary_gen: number;
	}): Promise<boolean> {
		const cache = this.configCache;
		const {result, written} = await this.compareAndSetStoredValue(
			cache,
			USERNAME_POLICY_CONFIG_KEY,
			(raw) => {
				const current = parseUsernamePolicyConfig(raw);
				if (
					current.revision !== expected.revision ||
					current.dictionary_gen !== expected.dictionary_gen ||
					current.previous_dictionary_gen !== expected.previous_dictionary_gen
				)
					return {value: null, result: false};
				const next = UsernamePolicyConfigSchema.parse({...current, revision: current.revision + 1});
				return {value: JSON.stringify(next), result: true};
			},
			true,
		);
		if (written) await this.publishRefresh(cache.sourceId);
		return result;
	}

	async readUsernameDictionaryCleanupState(): Promise<UsernameDictionaryCleanupState | null> {
		const raw = await this.fetchConfigForWrite('username_dictionary_cleanup');
		return raw === null ? null : UsernameDictionaryCleanupStateSchema.parse(JSON.parse(raw));
	}

	async compareAndSetUsernameDictionaryCleanupState(
		expected: UsernameDictionaryCleanupState | null,
		next: UsernameDictionaryCleanupState,
	): Promise<boolean> {
		if (expected) UsernameDictionaryCleanupStateSchema.parse(expected);
		UsernameDictionaryCleanupStateSchema.parse(next);
		const cache = this.configCache;
		const {result} = await this.compareAndSetStoredValue(
			cache,
			'username_dictionary_cleanup',
			(raw) => {
				const current = raw === null ? null : UsernameDictionaryCleanupStateSchema.parse(JSON.parse(raw));
				if (JSON.stringify(current) !== JSON.stringify(expected)) return {value: null, result: false};
				return {value: JSON.stringify(next), result: true};
			},
			true,
		);
		return result;
	}

	async readUsernameMigrationScan(): Promise<UsernameMigrationScan | null> {
		const raw = await this.fetchConfigForWrite(USERNAME_MIGRATION_SCAN_CONFIG_KEY);
		return raw === null ? null : UsernameMigrationScanSchema.parse(JSON.parse(raw));
	}

	async initializeUsernameMigrationScan(epoch: number): Promise<UsernameMigrationScan> {
		const cache = this.configCache;
		const {result, written} = await this.compareAndSetStoredValue(
			cache,
			USERNAME_MIGRATION_SCAN_CONFIG_KEY,
			async (raw) => {
				const migration = await this.readUsernameMigrationConfig();
				if (migration.state !== 'preparing' || migration.epoch !== epoch)
					throw new Error('Migration scan epoch is no longer preparing');
				const current = raw === null ? null : UsernameMigrationScanSchema.parse(JSON.parse(raw));
				if (current?.epoch === epoch) return {value: null, result: current};
				if (current && current.epoch > epoch) throw new Error('Cannot overwrite a newer migration scan');
				const next = UsernameMigrationScanSchema.parse({epoch, cursor: null, scanned: 0, found: 0, done_at: null});
				return {value: JSON.stringify(next), result: next};
			},
			true,
		);
		if (written) await this.publishRefresh(cache.sourceId);
		return result;
	}

	async compareAndSetUsernameMigrationScan(
		expected: UsernameMigrationScan,
		next: UsernameMigrationScan,
	): Promise<boolean> {
		UsernameMigrationScanSchema.parse(expected);
		UsernameMigrationScanSchema.parse(next);
		if (
			expected.epoch !== next.epoch ||
			next.scanned < expected.scanned ||
			next.found < expected.found ||
			expected.done_at !== null
		)
			throw new Error('Invalid migration scan progress');
		const cache = this.configCache;
		const {result, written} = await this.compareAndSetStoredValue(
			cache,
			USERNAME_MIGRATION_SCAN_CONFIG_KEY,
			async (raw) => {
				const migration = await this.readUsernameMigrationConfig();
				if (
					migration.state !== 'preparing' ||
					migration.epoch !== expected.epoch ||
					!migration.preparing_at ||
					Date.now() < Date.parse(migration.preparing_at) + 60_000
				)
					return {value: null, result: false};
				if (
					next.done_at &&
					(Date.parse(next.done_at) < Date.parse(migration.preparing_at) + 60_000 ||
						Date.parse(next.done_at) > Date.now())
				)
					throw new Error('Invalid migration scan completion time');
				const current = raw === null ? null : UsernameMigrationScanSchema.parse(JSON.parse(raw));
				if (JSON.stringify(current) !== JSON.stringify(expected)) return {value: null, result: false};
				return {value: JSON.stringify(next), result: true};
			},
			true,
		);
		if (written) await this.publishRefresh(cache.sourceId);
		return result;
	}

	async readUsernameRepairState(): Promise<UsernameRepairState | null> {
		const raw = await this.fetchConfigForWrite(USERNAME_REPAIR_STATE_CONFIG_KEY);
		return raw === null ? null : UsernameRepairStateSchema.parse(JSON.parse(raw));
	}

	async compareAndSetUsernameRepairState(
		expected: UsernameRepairState | null,
		next: UsernameRepairState,
	): Promise<boolean> {
		if (expected !== null) UsernameRepairStateSchema.parse(expected);
		UsernameRepairStateSchema.parse(next);
		const cache = this.configCache;
		const {result, written} = await this.compareAndSetStoredValue(
			cache,
			USERNAME_REPAIR_STATE_CONFIG_KEY,
			(raw) => {
				const current = raw === null ? null : UsernameRepairStateSchema.parse(JSON.parse(raw));
				if (JSON.stringify(current) !== JSON.stringify(expected)) return {value: null, result: false};
				return {value: JSON.stringify(next), result: true};
			},
			true,
		);
		if (written) await this.publishRefresh(cache.sourceId);
		return result;
	}

	async usesUniqueUsernames(): Promise<boolean> {
		return (await this.getTagStyle()) === TagStyles.NONE;
	}

	async isAccountIdentityLocked(): Promise<boolean> {
		if (!Config.instance.selfHosted) return true;
		if (Config.instance.setup.configured) return true;
		const source = readStoredAccountIdentitySource(await this.getConfig(ACCOUNT_IDENTITY_CONFIG_KEY));
		if (source === 'existing_instance' || source === 'migration') {
			return true;
		}
		const appPublic = await this.getAppPublicConfig();
		if (appPublic.setup.configured) return true;
		if (await this.isAdminBootstrapped()) return true;
		return await this.hasAnyUser();
	}

	async setAccountIdentityMode(
		mode: AccountIdentityMode,
		source: AccountIdentityDecisionSource,
		tagStyle: TagStyle = TagStyles.NONE,
	): Promise<void> {
		if (!Config.instance.selfHosted) {
			throw new Error('The account identity mode is fixed on the hosted service');
		}
		const identity: StoredAccountIdentity = {
			mode,
			tagStyle: mode === AccountIdentityModes.USERNAME ? TagStyles.NONE : tagStyle,
		};
		const value = serialiseAccountIdentity(identity, source);
		const cache = this.configCache;
		await this.compareAndSetStoredValue(cache, ACCOUNT_IDENTITY_CONFIG_KEY, (raw) => {
			const stored = parseStoredAccountIdentityConfig(raw);
			if (stored?.source === 'migration' || (stored?.username_migration && stored.username_migration.epoch > 0)) {
				throw new Error('Account identity setup cannot overwrite a username migration');
			}
			return {value, result: undefined};
		});
		setCachedAccountIdentity(identity);
		await this.publishRefresh(cache.sourceId);
	}

	async ensureAccountIdentityMode(): Promise<void> {
		if (!Config.instance.selfHosted) return;
		const cache = this.configCache;
		let identity: StoredAccountIdentity;
		let source: AccountIdentityDecisionSource;
		try {
			if ((await this.fetchConfigForWrite(ACCOUNT_IDENTITY_CONFIG_KEY)) !== null) return;
			const existing = await this.hasExistingInstanceSignals();
			const defaultMode = (await this.hasEmailDeliverySignal())
				? AccountIdentityModes.EMAIL
				: AccountIdentityModes.USERNAME;
			const mode = existing ? AccountIdentityModes.EMAIL : (Config.instance.accountIdentity ?? defaultMode);
			if (!existing && mode === AccountIdentityModes.USERNAME && Config.instance.tagStyle === TagStyles.RANDOM) {
				Logger.warn('FLUXER_TAG_STYLE=random only applies to email sign-in, username sign-in always uses no tags');
			}
			identity = {
				mode,
				tagStyle: existing
					? TagStyles.RANDOM
					: mode === AccountIdentityModes.USERNAME
						? TagStyles.NONE
						: (Config.instance.tagStyle ?? TagStyles.NONE),
			};
			source = existing ? 'existing_instance' : 'new_instance';
		} catch (error) {
			Logger.error({error}, 'Could not decide the account identity mode, leaving it on email until the next boot');
			return;
		}
		const value = serialiseAccountIdentity(identity, source);
		try {
			const {written} = await this.compareAndSetStoredValue(cache, ACCOUNT_IDENTITY_CONFIG_KEY, (raw) => ({
				value: raw === null ? value : null,
				result: undefined,
			}));
			if (!written) {
				setCachedAccountIdentity(
					readStoredAccountIdentity(await this.fetchConfigFromDatabase(ACCOUNT_IDENTITY_CONFIG_KEY)),
				);
				return;
			}
			setCachedAccountIdentity(identity);
			Logger.info({mode: identity.mode, tag_style: identity.tagStyle, source}, 'Stamped the account identity mode');
			await this.publishRefresh(cache.sourceId);
		} catch (error) {
			Logger.error({error}, 'Could not store the account identity mode, leaving it on email until the next boot');
		}
	}

	private async hasExistingInstanceSignals(): Promise<boolean> {
		if (Config.instance.setup.configured) return true;
		const [adminBootstrapped, appPublicRaw] = await Promise.all([
			this.fetchConfigFromDatabase(ADMIN_BOOTSTRAP_KEY),
			this.fetchConfigFromDatabase(APP_PUBLIC_CONFIG_KEY),
		]);
		if (adminBootstrapped === 'true') return true;
		const appPublic = parseStoredConfigValue(appPublicRaw, 'app public');
		const setupConfigured = isJsonRecord(appPublic) && isJsonRecord(appPublic.setup) && appPublic.setup.configured;
		if (setupConfigured === true) return true;
		return await this.hasAnyUser();
	}

	private async hasEmailDeliverySignal(): Promise<boolean> {
		if (Config.email.enabled) return true;
		const integrations = parseStoredConfigValue(
			await this.fetchConfigFromDatabase(INSTANCE_INTEGRATIONS_CONFIG_KEY),
			'integrations',
		);
		return isJsonRecord(integrations) && isJsonRecord(integrations.email) && integrations.email.enabled === true;
	}

	private async hasAnyUser(): Promise<boolean> {
		const rows = await fetchMany<{user_id: bigint}>(FETCH_ANY_USER_QUERY, {});
		return rows.length > 0;
	}

	async getGatewayRolloutConfig(options?: {authoritative?: boolean}): Promise<GatewayRolloutConfig> {
		this.configCache.assertActive();
		const raw = options?.authoritative
			? await this.fetchConfigForWrite(GATEWAY_ROLLOUT_CONFIG_KEY)
			: await this.fetchConfigFromDatabase(GATEWAY_ROLLOUT_CONFIG_KEY);
		this.configCache.assertActive();
		return parseStoredGatewayRolloutConfig(raw);
	}

	updateGatewayRolloutConfig(
		update: (current: GatewayRolloutConfig) => GatewayRolloutConfig,
	): Promise<GatewayRolloutConfig> {
		return this.updateStoredConfig(GATEWAY_ROLLOUT_CONFIG_KEY, (raw) => {
			const current = parseStoredGatewayRolloutConfig(raw);
			const next = update(current);
			return decodeGatewayRolloutConfig({
				...next,
				game_activity_epoch:
					current.game_activity_epoch + (next.game_activity_enabled === current.game_activity_enabled ? 0 : 1),
			});
		});
	}

	async getLegacyPushServiceDeliveryWire(): Promise<LegacyPushServiceDeliveryWire> {
		const raw = await this.getConfig(PUSH_RELAY_CONFIG_KEY);
		return parseStoredPushRelayConfig(raw);
	}

	async getPushRelayConfig(): Promise<PushRelayConfig> {
		return toPushRelayConfig(await this.getLegacyPushServiceDeliveryWire());
	}

	updatePushRelayConfig(update: (current: PushRelayConfig) => PushRelayConfig): Promise<LegacyPushServiceDeliveryWire> {
		return this.updateStoredConfig(PUSH_RELAY_CONFIG_KEY, (raw) => {
			const current = parseStoredPushRelayConfig(raw);
			const next = validateStoredConfig(PushRelayConfigSchema, update(toPushRelayConfig(current)), 'push relay');
			return toLegacyPushServiceDeliveryWire(next, current.config_version + 1);
		});
	}

	async getDomainMigrationConfig(): Promise<DomainMigrationConfig> {
		const raw = await this.getConfig(DOMAIN_MIGRATION_CONFIG_KEY);
		return parseStoredDomainMigrationConfig(raw);
	}

	async setDomainMigrationConfig(config: DomainMigrationConfig): Promise<void> {
		await this.updateDomainMigrationConfig(() => config);
	}

	updateDomainMigrationConfig(
		update: (current: DomainMigrationConfig) => DomainMigrationConfig,
	): Promise<DomainMigrationConfig> {
		return this.updateStoredConfig(DOMAIN_MIGRATION_CONFIG_KEY, (raw) =>
			validateStoredConfig(
				DomainMigrationConfigSchema,
				update(parseStoredDomainMigrationConfig(raw)),
				'domain migration',
			),
		);
	}

	async getVoiceNoiseSuppressionConfig(): Promise<VoiceNoiseSuppressionConfig> {
		const raw = await this.getConfig(VOICE_NOISE_SUPPRESSION_CONFIG_KEY);
		return parseStoredVoiceNoiseSuppressionConfig(raw);
	}

	async setVoiceNoiseSuppressionConfig(config: VoiceNoiseSuppressionConfig): Promise<void> {
		await this.updateVoiceNoiseSuppressionConfig(() => config);
	}

	updateVoiceNoiseSuppressionConfig(
		update: (current: VoiceNoiseSuppressionConfig) => VoiceNoiseSuppressionConfig,
	): Promise<VoiceNoiseSuppressionConfig> {
		return this.updateStoredConfig(VOICE_NOISE_SUPPRESSION_CONFIG_KEY, (raw) =>
			validateStoredConfig(
				VoiceNoiseSuppressionConfigSchema,
				update(parseStoredVoiceNoiseSuppressionConfig(raw)),
				'voice noise suppression',
			),
		);
	}

	async getVoiceRoomConfig(): Promise<VoiceRoomConfig> {
		return parseStoredVoiceRoomConfig(await this.getConfig(VOICE_ROOM_CONFIG_KEY));
	}

	updateVoiceRoomConfig(update: (current: VoiceRoomConfig) => VoiceRoomConfig): Promise<VoiceRoomConfig> {
		return this.updateStoredConfig(VOICE_ROOM_CONFIG_KEY, (raw) =>
			validateStoredConfig(VoiceRoomConfigSchema, update(parseStoredVoiceRoomConfig(raw)), 'voice room'),
		);
	}

	async getVoiceP2pConfig(): Promise<VoiceP2pConfig> {
		const raw = await this.getConfig(VOICE_P2P_CONFIG_KEY);
		return parseStoredVoiceP2pConfig(raw);
	}

	async setVoiceP2pConfig(config: VoiceP2pConfig): Promise<void> {
		await this.updateVoiceP2pConfig(() => config);
	}

	updateVoiceP2pConfig(update: (current: VoiceP2pConfig) => VoiceP2pConfig): Promise<VoiceP2pConfig> {
		return this.updateStoredConfig(VOICE_P2P_CONFIG_KEY, (raw) =>
			validateStoredConfig(VoiceP2pConfigSchema, update(parseStoredVoiceP2pConfig(raw)), 'voice p2p'),
		);
	}

	async getCaptchaConfig(): Promise<CaptchaConfig> {
		const raw = await this.getConfig(CAPTCHA_CONFIG_KEY);
		return parseStoredCaptchaConfig(raw);
	}

	updateCaptchaConfig(patch: CaptchaConfigUpdateRequest): Promise<CaptchaConfig> {
		return this.updateStoredConfig(CAPTCHA_CONFIG_KEY, (raw) =>
			validateStoredConfig(CaptchaConfigSchema, {...parseStoredCaptchaConfig(raw), ...patch}, 'captcha'),
		);
	}

	// Turnstile answers only while it is picked and both of its keys are stored; ALTCHA covers every other case.
	async getEffectiveCaptchaConfig(): Promise<InstanceCaptchaEffectiveConfig> {
		const [captcha, integrations] = await Promise.all([this.getCaptchaConfig(), this.getInstanceIntegrationsConfig()]);
		const {provider, turnstile_site_key: siteKey, turnstile_secret_key: secretKey} = integrations.captcha;
		if (captcha.enabled && provider === 'turnstile' && siteKey !== null && secretKey !== null) {
			return {...captcha, provider: 'turnstile', turnstile_site_key: siteKey, turnstile_secret_key: secretKey};
		}
		return {
			...captcha,
			provider: captcha.enabled ? 'altcha' : 'none',
			turnstile_site_key: null,
			turnstile_secret_key: null,
		};
	}

	async getChannelThreadsConfig(): Promise<ChannelThreadsConfig> {
		const raw = await this.getConfig(CHANNEL_THREADS_CONFIG_KEY);
		return syncChannelThreadsConfig(raw, parseStoredChannelThreadsConfig);
	}

	async getExperimentDeliveryConfig(): Promise<ExperimentDeliveryConfig> {
		const raw = await this.getConfig(EXPERIMENT_DELIVERY_CONFIG_KEY);
		return parseStoredExperimentDeliveryConfig(raw);
	}

	async setExperimentDeliveryConfig(config: ExperimentDeliveryConfig): Promise<void> {
		await this.updateExperimentDeliveryConfig(() => config);
	}

	updateExperimentDeliveryConfig(
		update: (current: ExperimentDeliveryConfig) => ExperimentDeliveryConfig,
	): Promise<ExperimentDeliveryConfig> {
		return this.updateStoredConfig(EXPERIMENT_DELIVERY_CONFIG_KEY, (raw) =>
			validateStoredConfig(
				ExperimentDeliveryConfigSchema,
				update(parseStoredExperimentDeliveryConfig(raw)),
				'experiment delivery',
			),
		);
	}

	async readLimitConfigInputs(): Promise<LimitConfigInputs> {
		const cache = this.configCache;
		cache.assertActive();
		const rows = await fetchMany<InstanceConfigurationRow>(FETCH_LIMIT_CONFIG_INPUTS_QUERY, {
			keys: [LIMIT_CONFIG_KEY, INSTANCE_POLICY_CONFIG_KEY],
		});
		cache.assertActive();
		const values = new Map(rows.map((row) => [row.key, row.value]));
		const policyRaw = values.get(INSTANCE_POLICY_CONFIG_KEY) ?? null;
		const policy = parseStoredInstancePolicyConfig(policyRaw);
		return {
			config: parseStoredLimitConfig(values.get(LIMIT_CONFIG_KEY) ?? null),
			premiumMode: policy.premium_mode,
		};
	}

	async setLimitConfig(config: StoredLimitConfig): Promise<void> {
		await this.setConfig(LIMIT_CONFIG_KEY, JSON.stringify(config));
	}

	async getAppPublicConfig(): Promise<InstanceAppPublicConfig> {
		const raw = await this.getConfig(APP_PUBLIC_CONFIG_KEY);
		const config = parseStoredAppPublicConfig(raw);
		setCachedDateOfBirthCollection(config.registration.collect_date_of_birth);
		setCachedConfiguredLegalUrls(config.legal);
		setCachedProductName(config.branding.product_name);
		return config;
	}

	async setAppPublicConfig(config: {
		branding?: InstanceBrandingPatch;
		setup?: Partial<InstanceAppPublicConfig['setup']>;
		legal?: Partial<InstanceAppPublicConfig['legal']>;
		registration?: Partial<InstanceAppPublicConfig['registration']>;
		localization?: Partial<NonNullable<InstanceAppPublicConfig['localization']>>;
	}): Promise<InstanceAppPublicConfig> {
		const cache = this.configCache;
		const {result: next} = await this.compareAndSetStoredValue(cache, APP_PUBLIC_CONFIG_KEY, (raw) => {
			const stored = salvageStoredConfig(
				StoredInstanceAppPublicSchema,
				readStoredConfigValue(raw, 'app public'),
				'app public',
			);
			const current = buildAppPublicConfig(stored);
			const premiumProductName =
				config.branding?.premium_product_name !== undefined
					? config.branding.premium_product_name
					: normalizeOptionalString(stored.branding?.premium_product_name);
			const merged = validateStoredConfig(
				StoredInstanceAppPublicSchema,
				{
					branding: {
						...toStoredBranding(current.branding),
						...toStoredBranding(config.branding ?? {}),
						premium_product_name: premiumProductName,
					},
					setup: {
						...current.setup,
						...(config.setup ?? {}),
					},
					legal: {
						...current.legal,
						...(config.legal ?? {}),
					},
					registration: {
						...current.registration,
						...(config.registration ?? {}),
					},
					localization: {...current.localization, ...(config.localization ?? {})},
				},
				'app public',
			);
			return {value: JSON.stringify(merged), result: resolveAppPublicConfig(buildAppPublicConfig(merged))};
		});
		await this.publishRefresh(cache.sourceId);
		setCachedDateOfBirthCollection(next.registration.collect_date_of_birth);
		setCachedConfiguredLegalUrls(next.legal);
		setCachedProductName(next.branding.product_name);
		return next;
	}

	async normalizeStoredBrandingAssets(storageService: IStorageService): Promise<number> {
		const cache = this.configCache;
		await cache.getSnapshot();
		cache.assertActive();
		const raw = await this.fetchConfigFromDatabase(APP_PUBLIC_CONFIG_KEY);
		if (raw === null) return 0;
		const stored = salvageStoredConfig(
			StoredInstanceAppPublicSchema,
			readStoredConfigValue(raw, 'app public'),
			'app public',
		);
		const rewrites = new Map<string, string>();
		for (const field of BRANDING_ASSET_FIELDS) {
			const value = stored.branding?.[field];
			if (typeof value !== 'string' || isBrandingAssetReference(value) || rewrites.has(value)) continue;
			const reference = toStoredBrandingAsset(value, Config.endpoints.media);
			if (reference !== value && typeof reference === 'string') {
				rewrites.set(value, reference);
				continue;
			}
			const candidate = brandingAssetReferenceFromAnyUrl(value);
			if (candidate === null) continue;
			const metadata = await storageService.getObjectMetadata(
				Config.s3.buckets.cdn,
				brandingAssetStorageKey(candidate),
			);
			if (metadata !== null) {
				rewrites.set(value, candidate);
			}
		}
		if (rewrites.size === 0) return 0;
		const {result} = await this.compareAndSetStoredValue(cache, APP_PUBLIC_CONFIG_KEY, (current) => {
			const latest = salvageStoredConfig(
				StoredInstanceAppPublicSchema,
				readStoredConfigValue(current, 'app public'),
				'app public',
			);
			if (!latest.branding) return {value: null, result: 0};
			let changed = 0;
			const branding = mapBrandingAssets(latest.branding, (value) => {
				const rewrite = typeof value === 'string' ? rewrites.get(value) : undefined;
				if (rewrite === undefined) return value;
				changed++;
				return rewrite;
			});
			if (changed === 0) return {value: null, result: 0};
			const next = validateStoredConfig(StoredInstanceAppPublicSchema, {...latest, branding}, 'app public');
			return {value: JSON.stringify(next), result: changed};
		});
		if (result > 0) {
			await this.publishRefresh(cache.sourceId);
		}
		return result;
	}

	async getInstancePolicyConfig(): Promise<InstancePolicyConfig> {
		const raw = await this.getConfig(INSTANCE_POLICY_CONFIG_KEY);
		const policy = parseStoredInstancePolicyConfig(raw);
		setCachedDeferredPhoneGateEnabled(resolveDeferredPhoneGateEnabled(policy));
		return policy;
	}

	async readStoredInstancePolicyConfig(): Promise<InstancePolicyConfig> {
		const cache = this.configCache;
		cache.assertActive();
		const raw = await this.fetchConfigFromDatabase(INSTANCE_POLICY_CONFIG_KEY);
		cache.assertActive();
		return parseStoredInstancePolicyConfig(raw);
	}

	setInstancePolicyConfig(config: Partial<InstancePolicyConfig>): Promise<InstancePolicyConfig> {
		return this.updateInstancePolicyConfig(() => config);
	}

	async updateInstancePolicyConfig(
		plan: (current: InstancePolicyConfig) => Partial<InstancePolicyConfig>,
	): Promise<InstancePolicyConfig> {
		const cache = this.configCache;
		const {result: next, written} = await this.compareAndSetStoredValue(cache, INSTANCE_POLICY_CONFIG_KEY, (raw) => {
			const current = parseStoredInstancePolicyConfig(raw);
			const patch = plan(current);
			const config = decodeInstancePolicyConfig({...current, ...patch});
			return {value: Object.keys(patch).length === 0 ? null : JSON.stringify(config), result: config};
		});
		if (written) await this.publishRefresh(cache.sourceId);
		setCachedDeferredPhoneGateEnabled(resolveDeferredPhoneGateEnabled(next));
		return next;
	}

	// Catalog and quote: the pubsub-refreshed snapshot.
	async getShopConfig(): Promise<ShopConfig> {
		return parseStoredShopConfig(await this.getConfig(SHOP_CONFIG_KEY));
	}

	// Order creation and the admin page: straight from the table.
	async readStoredShopConfig(): Promise<ShopConfig> {
		const cache = this.configCache;
		cache.assertActive();
		const raw = await this.fetchConfigFromDatabase(SHOP_CONFIG_KEY);
		cache.assertActive();
		return parseStoredShopConfig(raw);
	}

	// plan runs inside the compare-and-set loop and may run again after a lost write; an error it throws ends the update.
	async updateShopConfig(plan: (current: ShopConfig) => Partial<ShopConfig>): Promise<ShopConfig> {
		const cache = this.configCache;
		const {result: next, written} = await this.compareAndSetStoredValue(cache, SHOP_CONFIG_KEY, (raw) => {
			const current = parseStoredShopConfig(raw);
			const patch = plan(current);
			const config = validateStoredConfig(StoredShopConfigSchema, {...current, ...patch}, 'shop');
			return {value: Object.keys(patch).length === 0 ? null : JSON.stringify(config), result: config};
		});
		if (written) await this.publishRefresh(cache.sourceId);
		return next;
	}

	// Registration and the user's own page: the pubsub-refreshed snapshot.
	async getReferralConfig(): Promise<ReferralConfig> {
		return parseStoredReferralConfig(await this.getConfig(REFERRAL_CONFIG_KEY));
	}

	// The admin page and tier changes: straight from the table.
	async readStoredReferralConfig(): Promise<ReferralConfig> {
		const cache = this.configCache;
		cache.assertActive();
		const raw = await this.fetchConfigFromDatabase(REFERRAL_CONFIG_KEY);
		cache.assertActive();
		return parseStoredReferralConfig(raw);
	}

	// plan runs inside the compare-and-set loop like updateShopConfig's.
	async updateReferralConfig(plan: (current: ReferralConfig) => Partial<ReferralConfig>): Promise<ReferralConfig> {
		const cache = this.configCache;
		const {result: next, written} = await this.compareAndSetStoredValue(cache, REFERRAL_CONFIG_KEY, (raw) => {
			const current = parseStoredReferralConfig(raw);
			const patch = plan(current);
			const config = validateStoredConfig(StoredReferralConfigSchema, {...current, ...patch}, 'referral');
			return {value: Object.keys(patch).length === 0 ? null : JSON.stringify(config), result: config};
		});
		if (written) await this.publishRefresh(cache.sourceId);
		return next;
	}

	async getInstanceIntegrationsConfig(): Promise<InstanceIntegrationsConfig> {
		const raw = await this.getConfig(INSTANCE_INTEGRATIONS_CONFIG_KEY);
		return parseStoredInstanceIntegrationsConfig(raw);
	}

	setInstanceIntegrationsConfig(config: InstanceIntegrationsConfigPatch): Promise<InstanceIntegrationsConfig> {
		return this.updateStoredConfig(INSTANCE_INTEGRATIONS_CONFIG_KEY, (raw) => {
			const current = parseStoredInstanceIntegrationsConfig(raw);
			return decodeInstanceIntegrationsConfig({
				gif: {
					...current.gif,
					...(config.gif ?? {}),
				},
				youtube: {
					...current.youtube,
					...(config.youtube ?? {}),
				},
				captcha: {
					...current.captcha,
					...(config.captcha ?? {}),
				},
				email: {
					...current.email,
					...(config.email ?? {}),
					smtp: {
						...current.email.smtp,
						...(config.email?.smtp ?? {}),
						...(config.email?.smtp?.tls_mode === undefined ? {} : {secure: null}),
					},
				},
				bluesky: {
					...current.bluesky,
					...(config.bluesky ?? {}),
					keys: config.bluesky?.keys ?? current.bluesky.keys,
				},
			});
		});
	}

	async getInstanceMediaConfig(): Promise<InstanceMediaConfig> {
		const raw = await this.getConfig(INSTANCE_MEDIA_CONFIG_KEY);
		return parseStoredInstanceMediaConfig(raw);
	}

	setInstanceMediaConfig(config: InstanceMediaConfigPatch): Promise<InstanceMediaConfig> {
		return this.updateStoredConfig(INSTANCE_MEDIA_CONFIG_KEY, (raw) => {
			const current = parseStoredInstanceMediaConfig(raw);
			return decodeInstanceMediaConfig({
				attachment_decay: {
					...current.attachment_decay,
					...(config.attachment_decay ?? {}),
				},
			});
		});
	}

	async getEffectiveAttachmentDecayConfig(): Promise<InstanceAttachmentDecayEffectiveConfig> {
		return resolveEffectiveAttachmentDecayConfig(await this.getInstanceMediaConfig());
	}

	async fetchStoredEffectiveAttachmentDecayConfig(): Promise<InstanceAttachmentDecayEffectiveConfig> {
		const raw = await this.fetchConfigFromDatabase(INSTANCE_MEDIA_CONFIG_KEY);
		return resolveEffectiveAttachmentDecayConfig(parseStoredInstanceMediaConfig(raw));
	}

	async getInstanceMediaAdminConfig(): Promise<InstanceMediaAdminConfig> {
		const [media, attachmentDecay] = await Promise.all([
			this.getInstanceMediaConfig(),
			this.getEffectiveAttachmentDecayConfig(),
		]);
		return {
			attachment_decay: {
				...media.attachment_decay,
				effective: attachmentDecay,
			},
		};
	}

	async getEffectiveGifConfig(): Promise<InstanceGifEffectiveConfig> {
		const integrations = await this.getInstanceIntegrationsConfig();
		const klipyApiKey = integrations.gif.klipy_api_key ?? normalizeOptionalString(Config.klipy.apiKey);
		return {
			klipy_api_key: klipyApiKey,
			active_api_key: klipyApiKey,
			available: Boolean(klipyApiKey),
		};
	}

	async getEffectiveYoutubeApiKey(): Promise<string | null> {
		const integrations = await this.getInstanceIntegrationsConfig();
		return integrations.youtube.api_key ?? normalizeOptionalString(Config.youtube.apiKey);
	}

	async getSmtpTestConfig(draft: InstanceEmailSmtpTestRequest): Promise<SmtpTestConfig> {
		const saved = (await this.getInstanceIntegrationsConfig()).email.smtp;
		const current = resolveEffectiveSmtpConfig(saved);
		if (Object.values(draft).every((value) => value === undefined)) {
			return {smtp: current, problem: await this.getEmailSendBlocker()};
		}
		const retargeted =
			(draft.host != null && draft.host.toLowerCase() !== current.host.toLowerCase()) ||
			(draft.username != null && draft.username !== current.username);
		const smtp: EffectiveSmtpConfig = {
			host: draft.host ?? current.host,
			port: draft.port ?? current.port,
			username: draft.username ?? current.username,
			password: draft.password ?? (retargeted ? '' : current.password),
			tlsMode: draft.tls_mode === undefined ? current.tlsMode : (draft.tls_mode ?? Config.email.smtp?.tlsMode ?? null),
		};
		if (retargeted && !smtp.password) {
			return {smtp, problem: 'Enter the SMTP password to test a different host or username'};
		}
		return {smtp, problem: describeIncompleteSmtpConfig(smtp)};
	}

	private async resolveEmailConfig(): Promise<{email: APIConfig['email']; usernameMode: boolean}> {
		const integrations = await this.getInstanceIntegrationsConfig();
		const provider = integrations.email.provider ?? Config.email.provider;
		const fromEmail = integrations.email.from_email ?? Config.email.fromEmail;
		const fromName = integrations.email.from_name ?? Config.email.fromName;
		const smtp = provider === 'smtp' ? resolveEffectiveSmtpConfig(integrations.email.smtp) : undefined;
		const email: APIConfig['email'] = {
			...Config.email,
			enabled: integrations.email.enabled ?? Config.email.enabled,
			provider,
			fromEmail,
			fromName,
			smtp,
		};
		const usernameMode = (await this.getAccountIdentityMode()) === AccountIdentityModes.USERNAME;
		return {email, usernameMode};
	}

	private async getEmailSendBlocker(): Promise<string | null> {
		const {email, usernameMode} = await this.resolveEmailConfig();
		if (usernameMode) return 'Email is off while accounts sign in with usernames';
		if (!email.enabled) return 'Email is turned off';
		if (email.provider !== 'smtp' || !email.smtp) return 'The email provider is not SMTP';
		if (!email.fromEmail.trim()) return 'No from address is set';
		return describeIncompleteSmtpConfig(email.smtp);
	}

	async getEffectiveEmailConfig(): Promise<APIConfig['email']> {
		const {email, usernameMode} = await this.resolveEmailConfig();
		return {
			...email,
			enabled: !usernameMode && email.enabled && hasCompleteSmtpConfig(email),
		};
	}

	async isEmailEnabled(): Promise<boolean> {
		return (await this.getEffectiveEmailConfig()).enabled;
	}

	async getEffectiveBlueskyConfig(): Promise<BlueskyOAuthConfig> {
		const raw = await this.getConfig(INSTANCE_INTEGRATIONS_CONFIG_KEY);
		const memoized = this.effectiveBlueskyConfig;
		if (memoized && this.effectiveBlueskyConfigSource === raw) {
			return memoized;
		}
		const integrations = parseStoredInstanceIntegrationsConfig(raw);
		const runtimeKeys = integrations.bluesky.keys.flatMap((key): Array<BlueskyOAuthKeyConfig> => {
			if (!key.private_key) return [];
			return [{kid: key.kid, private_key: key.private_key}];
		});
		const keys = runtimeKeys.length > 0 ? runtimeKeys : Config.auth.bluesky.keys;
		const enabled = (integrations.bluesky.enabled ?? Config.auth.bluesky.enabled) && keys.length > 0;
		const effective: BlueskyOAuthConfig = {
			...Config.auth.bluesky,
			enabled,
			client_name: integrations.bluesky.client_name ?? Config.auth.bluesky.client_name,
			client_uri: integrations.bluesky.client_uri ?? Config.auth.bluesky.client_uri,
			logo_uri: integrations.bluesky.logo_uri ?? Config.auth.bluesky.logo_uri,
			tos_uri: integrations.bluesky.tos_uri ?? Config.auth.bluesky.tos_uri,
			policy_uri: integrations.bluesky.policy_uri ?? Config.auth.bluesky.policy_uri,
			keys,
		};
		this.effectiveBlueskyConfigSource = raw;
		this.effectiveBlueskyConfig = effective;
		return effective;
	}

	async getInstanceIntegrationsAdminConfig(): Promise<InstanceIntegrationsAdminConfig> {
		const [integrations, gif, youtubeApiKey, captcha, email, bluesky] = await Promise.all([
			this.getInstanceIntegrationsConfig(),
			this.getEffectiveGifConfig(),
			this.getEffectiveYoutubeApiKey(),
			this.getEffectiveCaptchaConfig(),
			this.getEffectiveEmailConfig(),
			this.getEffectiveBlueskyConfig(),
		]);
		return {
			gif: {
				klipy_api_key_set: secretIsSet(integrations.gif.klipy_api_key) || secretIsSet(Config.klipy.apiKey),
				effective_available: gif.available,
			},
			youtube: {
				api_key_set: secretIsSet(integrations.youtube.api_key) || secretIsSet(Config.youtube.apiKey),
				effective_available: Boolean(youtubeApiKey),
			},
			captcha: {
				provider: integrations.captcha.provider,
				effective_provider: captcha.provider,
				turnstile_site_key: integrations.captcha.turnstile_site_key,
				turnstile_secret_key_set: secretIsSet(integrations.captcha.turnstile_secret_key),
				effective_enabled: captcha.enabled,
			},
			email: {
				enabled: integrations.email.enabled,
				effective_enabled: email.enabled,
				provider: integrations.email.provider,
				effective_provider: email.provider,
				from_email: email.fromEmail || null,
				from_name: email.fromName || null,
				smtp: {
					host: email.smtp?.host || null,
					port: email.smtp?.port ?? null,
					username: email.smtp?.username || null,
					password_set: secretIsSet(integrations.email.smtp.password) || secretIsSet(Config.email.smtp?.password),
					tls_mode: storedSmtpTlsMode(integrations.email.smtp),
					effective_tls_mode: email.smtp ? resolveSmtpTlsMode(email.smtp.tlsMode, email.smtp.port) : null,
				},
				disable_new_ip_authorization: integrations.email.disable_new_ip_authorization ?? false,
				effective_disable_new_ip_authorization: integrations.email.disable_new_ip_authorization || !email.enabled,
			},
			bluesky: {
				enabled: integrations.bluesky.enabled,
				effective_enabled: bluesky.enabled,
				client_name: bluesky.client_name || null,
				client_uri: bluesky.client_uri || null,
				logo_uri: bluesky.logo_uri || null,
				tos_uri: bluesky.tos_uri || null,
				policy_uri: bluesky.policy_uri || null,
				key_count: bluesky.keys.length,
			},
		};
	}

	async getInstanceBillingConfig(): Promise<InstanceBillingConfig> {
		const raw = await this.getConfig(INSTANCE_BILLING_CONFIG_KEY);
		const config = parseStoredInstanceBillingConfig(raw);
		setStoredBillingConfig(config);
		return config;
	}

	async readStoredInstanceBillingConfig(): Promise<InstanceBillingConfig> {
		const cache = this.configCache;
		cache.assertActive();
		const raw = await this.fetchConfigFromDatabase(INSTANCE_BILLING_CONFIG_KEY);
		cache.assertActive();
		return parseStoredInstanceBillingConfig(raw);
	}

	async setInstanceBillingConfig(patch: InstanceBillingConfigPatch): Promise<InstanceBillingConfig> {
		const next = await this.updateStoredConfig(INSTANCE_BILLING_CONFIG_KEY, (raw) => {
			const current = parseStoredInstanceBillingConfig(raw);
			return decodeInstanceBillingConfig({
				enabled: patch.enabled === undefined ? current.enabled : patch.enabled,
				stripe_secret_key: patch.stripe_secret_key === undefined ? current.stripe_secret_key : patch.stripe_secret_key,
				stripe_webhook_secret:
					patch.stripe_webhook_secret === undefined ? current.stripe_webhook_secret : patch.stripe_webhook_secret,
				automatic_tax: patch.automatic_tax === undefined ? current.automatic_tax : patch.automatic_tax,
				tax_id_collection: patch.tax_id_collection === undefined ? current.tax_id_collection : patch.tax_id_collection,
				terms_consent_required:
					patch.terms_consent_required === undefined ? current.terms_consent_required : patch.terms_consent_required,
				default_currency: patch.default_currency === undefined ? current.default_currency : patch.default_currency,
				prices: patch.prices === undefined ? current.prices : normalizeBillingPrices(patch.prices),
				country_currencies:
					patch.country_currencies === undefined ? current.country_currencies : patch.country_currencies,
				legacy_prices: patch.legacy_prices === undefined ? current.legacy_prices : patch.legacy_prices,
			});
		});
		setStoredBillingConfig(next);
		return next;
	}

	async getInstanceBillingAdminConfig(): Promise<InstanceBillingAdminConfig> {
		const stored = await this.getInstanceBillingConfig();
		const effective = getEffectiveBillingConfig();
		return {
			enabled: stored.enabled,
			effective_enabled: effective.enabled,
			stripe_secret_key_set: effective.secretKey !== null,
			stripe_webhook_secret_set: effective.webhookSecret !== null,
			stripe_secret_key_stored: secretIsSet(stored.stripe_secret_key),
			stripe_webhook_secret_stored: secretIsSet(stored.stripe_webhook_secret),
			automatic_tax: stored.automatic_tax,
			tax_id_collection: stored.tax_id_collection,
			terms_consent_required: stored.terms_consent_required,
			effective_automatic_tax: effective.automaticTax,
			effective_tax_id_collection: effective.taxIdCollection,
			effective_terms_consent_required: effective.termsConsentRequired,
			default_currency: stored.default_currency,
			prices: stored.prices,
			country_currencies: stored.country_currencies,
			legacy_prices: stored.legacy_prices,
			billing_active: isBillingActive(effective),
			stripe_serviceable: isStripeServiceable(effective),
			catalog_mode: effective.catalogMode,
			webhook_url: `${Config.endpoints.apiPublic.replace(/\/+$/, '')}/stripe/webhook`,
		};
	}

	async getInstanceCommunityPublicConfig(): Promise<InstanceCommunity> {
		const policy = await this.getInstancePolicyConfig();
		return {
			single_community: policy.single_community_enabled,
			single_community_guild_id: policy.single_community_enabled ? policy.single_community_guild_id : null,
			direct_messages_disabled: policy.direct_messages_disabled,
			guild_create_access: policy.guild_create_access,
		};
	}

	async getResolvedServicesConfig(): Promise<InstanceServices> {
		const [policy, gif, youtubeApiKey, bluesky] = await Promise.all([
			this.getInstancePolicyConfig(),
			this.getEffectiveGifConfig(),
			this.getEffectiveYoutubeApiKey(),
			this.getEffectiveBlueskyConfig(),
		]);
		return {
			gif_enabled: policy.gif_enabled ?? gif.available,
			youtube_enabled: policy.youtube_enabled ?? Boolean(youtubeApiKey),
			bluesky_enabled: policy.bluesky_enabled ?? bluesky.enabled,
		};
	}

	async getRegistrationConfig(): Promise<InstanceRegistrationConfig> {
		const raw = await this.getConfig(REGISTRATION_CONFIG_KEY);
		return parseStoredRegistrationConfig(raw);
	}

	setRegistrationConfig(config: Partial<InstanceRegistrationConfig>): Promise<InstanceRegistrationConfig> {
		return this.updateStoredConfig(REGISTRATION_CONFIG_KEY, (raw) => {
			const current = parseStoredRegistrationConfig(raw);
			return decodeRegistrationConfig({
				mode: config.mode ?? current.mode,
				admin_registration_urls_enabled:
					config.admin_registration_urls_enabled ?? current.admin_registration_urls_enabled,
			});
		});
	}

	async getRegistrationPublicConfig(): Promise<InstanceRegistrationConfig> {
		return this.getRegistrationConfig();
	}

	async getRegistrationUrls(): Promise<Array<InstanceRegistrationUrl>> {
		const raw = await this.getConfig(REGISTRATION_URLS_KEY);
		return parseStoredCollection(StoredRegistrationUrlSchema, raw, 'registration URLs');
	}

	async getRegistrationUrlsForAdmin(): Promise<Array<InstanceRegistrationUrlPublic>> {
		return (await this.getRegistrationUrls())
			.toSorted((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
			.map(redactRegistrationUrl);
	}

	async createRegistrationUrl(params: {
		label: string | null;
		createdByUserId: string;
		expiresAt: Date | null;
		maxUses: number | null;
		approvalRequired: boolean;
	}): Promise<{registrationUrl: InstanceRegistrationUrlPublic; code: string}> {
		const id = crypto.randomUUID();
		const code = id;
		const registrationUrl: InstanceRegistrationUrl = {
			id,
			label: params.label,
			code_hash: this.hashRegistrationUrlCode(code),
			created_by_user_id: params.createdByUserId,
			created_at: new Date().toISOString(),
			expires_at: params.expiresAt?.toISOString() ?? null,
			max_uses: params.maxUses,
			use_count: 0,
			revoked_at: null,
			approval_required: params.approvalRequired,
			last_used_at: null,
			last_used_by_user_id: null,
		};
		await this.updateStoredConfig(REGISTRATION_URLS_KEY, (raw) =>
			validateStoredCollection(
				StoredRegistrationUrlSchema,
				[registrationUrl, ...parseStoredCollection(StoredRegistrationUrlSchema, raw, 'registration URLs')],
				'registration URLs',
			),
		);
		return {registrationUrl: redactRegistrationUrl(registrationUrl), code};
	}

	async revokeRegistrationUrl(id: string): Promise<void> {
		const now = new Date().toISOString();
		await this.updateStoredConfig(REGISTRATION_URLS_KEY, (raw) =>
			parseStoredCollection(StoredRegistrationUrlSchema, raw, 'registration URLs').map((registrationUrl) =>
				registrationUrl.id === id && !registrationUrl.revoked_at
					? {...registrationUrl, revoked_at: now}
					: registrationUrl,
			),
		);
	}

	async resolveRegistrationUrlCode(code: string): Promise<InstanceRegistrationUrl | null> {
		const normalizedCode = code.trim();
		if (!normalizedCode) return null;
		const hash = this.hashRegistrationUrlCode(normalizedCode);
		const now = new Date();
		return (
			(await this.fetchRegistrationUrlDefinitions()).find(
				(registrationUrl) =>
					(registrationUrl.id === normalizedCode || registrationUrl.code_hash === hash) &&
					isRegistrationUrlUsable(registrationUrl, now),
			) ?? null
		);
	}

	async claimRegistrationUrlUse(registrationUrlId: string, userId: string): Promise<RegistrationUrlClaim | null> {
		const cache = this.configCache;
		let claimed: {result: RegistrationUrlClaim | null; written: boolean};
		try {
			claimed = await this.compareAndSetStoredValue<RegistrationUrlClaim | null>(
				cache,
				REGISTRATION_URLS_KEY,
				(raw) => {
					const registrationUrls = parseStoredCollection(StoredRegistrationUrlSchema, raw, 'registration URLs');
					const now = new Date();
					const claimable = registrationUrls.find(
						(registrationUrl) =>
							registrationUrl.id === registrationUrlId && isRegistrationUrlUsable(registrationUrl, now),
					);
					if (!claimable) return {value: null, result: null};
					const next = registrationUrls.map((registrationUrl) =>
						registrationUrl === claimable
							? {
									...registrationUrl,
									use_count: registrationUrl.use_count + 1,
									last_used_at: now.toISOString(),
									last_used_by_user_id: userId,
								}
							: registrationUrl,
					);
					return {
						value: JSON.stringify(validateStoredCollection(StoredRegistrationUrlSchema, next, 'registration URLs')),
						result: {registration_url_id: registrationUrlId, user_id: userId},
					};
				},
			);
		} catch (error) {
			if (error instanceof InstanceConfigWriteConflictError) throw new ServiceUnavailableError();
			throw error;
		}
		if (claimed.written) await this.publishRefresh(cache.sourceId);
		return claimed.result;
	}

	async releaseRegistrationUrlUse(claim: RegistrationUrlClaim): Promise<void> {
		const cache = this.configCache;
		try {
			const {written} = await this.compareAndSetStoredValue<null>(cache, REGISTRATION_URLS_KEY, (raw) => {
				const registrationUrls = parseStoredCollection(StoredRegistrationUrlSchema, raw, 'registration URLs');
				const released = registrationUrls.find(
					(registrationUrl) => registrationUrl.id === claim.registration_url_id && registrationUrl.use_count > 0,
				);
				if (!released) return {value: null, result: null};
				const next = registrationUrls.map((registrationUrl) =>
					registrationUrl === released
						? {...registrationUrl, use_count: registrationUrl.use_count - 1}
						: registrationUrl,
				);
				return {value: JSON.stringify(next), result: null};
			});
			if (written) await this.publishRefresh(cache.sourceId);
		} catch (error) {
			Logger.warn(
				{registrationUrlId: claim.registration_url_id, userId: claim.user_id, error},
				'Releasing a registration URL use failed',
			);
		}
	}

	async getPendingRegistrations(): Promise<Array<InstancePendingRegistration>> {
		const raw = await this.getConfig(REGISTRATION_PENDING_APPROVALS_KEY);
		return parseStoredCollection(StoredPendingRegistrationSchema, raw, 'pending registrations').toSorted(
			(a, b) => Date.parse(a.requested_at) - Date.parse(b.requested_at),
		);
	}

	async addPendingRegistration(pendingRegistration: InstancePendingRegistration): Promise<void> {
		await this.updateStoredConfig(REGISTRATION_PENDING_APPROVALS_KEY, (raw) =>
			validateStoredCollection(
				StoredPendingRegistrationSchema,
				[
					pendingRegistration,
					...parseStoredCollection(StoredPendingRegistrationSchema, raw, 'pending registrations').filter(
						(entry) => entry.user_id !== pendingRegistration.user_id,
					),
				],
				'pending registrations',
			),
		);
	}

	async removePendingRegistration(userId: string): Promise<void> {
		await this.updateStoredConfig(REGISTRATION_PENDING_APPROVALS_KEY, (raw) =>
			parseStoredCollection(StoredPendingRegistrationSchema, raw, 'pending registrations').filter(
				(entry) => entry.user_id !== userId,
			),
		);
	}

	async getSsoConfig(options?: {includeSecret?: boolean}): Promise<InstanceSsoConfig> {
		return readStoredSsoConfig(await this.getAllConfigs(), options);
	}

	async setSsoConfig(config: Partial<InstanceSsoConfig>): Promise<InstanceSsoConfig> {
		const configs = await this.getAllConfigs();
		const current = readStoredSsoConfig(configs, {includeSecret: true});
		const enabled = config.enabled ?? current.enabled;
		const allowedEmailDomains =
			config.allowedEmailDomains === undefined
				? undefined
				: normalizeSsoAllowedEmailDomainsForWrite(config.allowedEmailDomains, enabled);
		const rows: Array<SsoRowWrite> = [
			ssoRow('sso_enabled', config.enabled, current.enabled, formatSsoBoolean),
			ssoRow('sso_enforced', config.enforced, current.enforced, formatSsoBoolean),
			ssoRow('sso_display_name', config.displayName, current.displayName, formatSsoString),
			ssoRow('sso_issuer', config.issuer, current.issuer, formatSsoString),
			ssoRow('sso_authorization_url', config.authorizationUrl, current.authorizationUrl, formatSsoString),
			ssoRow('sso_token_url', config.tokenUrl, current.tokenUrl, formatSsoString),
			ssoRow('sso_userinfo_url', config.userInfoUrl, current.userInfoUrl, formatSsoString),
			ssoRow('sso_jwks_url', config.jwksUrl, current.jwksUrl, formatSsoString),
			ssoRow('sso_client_id', config.clientId, current.clientId, formatSsoString),
			ssoRow('sso_scope', config.scope, current.scope, formatSsoString),
			ssoRow('sso_allowed_domains', allowedEmailDomains, current.allowedEmailDomains, formatSsoDomains),
			ssoRow('sso_auto_provision', config.autoProvision, current.autoProvision, formatSsoBoolean),
			ssoRow('sso_redirect_uri', undefined, null, formatSsoString),
		];
		if (config.clientSecret !== undefined) {
			rows.push(ssoRow('sso_client_secret', config.clientSecret, current.clientSecret ?? null, formatSsoString));
		}
		const cache = this.configCache;
		const results = await Promise.allSettled(
			rows
				.filter((row) => row.value !== undefined || !configs.has(row.key))
				.map((row) =>
					this.compareAndSetStoredValue(cache, row.key, (raw) => ({value: nextSsoRowValue(row, raw), result: null})),
				),
		);
		const errors: Array<unknown> = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
		if (results.some((result) => result.status === 'fulfilled' && result.value.written)) {
			try {
				await this.publishRefresh(cache.sourceId);
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, 'Failed to write or publish the SSO config');
		return this.getSsoConfig({includeSecret: true});
	}

	private async fetchRegistrationUrlDefinitions(): Promise<Array<InstanceRegistrationUrl>> {
		const raw = await this.fetchConfigFromDatabase(REGISTRATION_URLS_KEY);
		return parseStoredCollection(StoredRegistrationUrlSchema, raw, 'registration URLs');
	}

	private hashRegistrationUrlCode(code: string): string {
		return crypto.createHash('sha256').update(code).digest('hex');
	}
}

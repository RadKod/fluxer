// SPDX-License-Identifier: AGPL-3.0-or-later

import {AdminRepository} from '@app/api/admin/AdminRepository';
import {AdminApiKeyRepository} from '@app/api/admin/repositories/AdminApiKeyRepository';
import {AdminArchiveRepository} from '@app/api/admin/repositories/AdminArchiveRepository';
import {AdminApiKeyService} from '@app/api/admin/services/AdminApiKeyService';
import {AdminArchiveService} from '@app/api/admin/services/AdminArchiveService';
import {createGuildID, type GuildID, type UserID} from '@app/api/BrandedTypes';
import {BadgeRepository} from '@app/api/badge/BadgeRepository';
import {BadgeService} from '@app/api/badge/BadgeService';
import {EarlyPlusBadgeService} from '@app/api/badge/EarlyPlusBadgeService';
import {PioneerRepository} from '@app/api/badge/PioneerRepository';
import {PioneerService} from '@app/api/badge/PioneerService';
import {createKvIpInfoLookupBudget} from '@app/api/ban/IpInfoBudget';
import {Config} from '@app/api/Config';
import {ChannelRepository} from '@app/api/channel/ChannelRepository';
import {AttachmentUploadTraceRepository} from '@app/api/channel/repositories/message/AttachmentUploadTraceRepository';
import {ChannelAuthService} from '@app/api/channel/services/channel_data/ChannelAuthService';
import {
	MessageComponentService,
	type MessageComponentServiceDeps,
} from '@app/api/channel/services/interaction/MessageComponentService';
import {createMessageReactionUserCounterFlusher} from '@app/api/channel/services/interaction/MessageReactionUserCounter';
import {StreamPreviewService} from '@app/api/channel/services/StreamPreviewService';
import type {APIConfig} from '@app/api/config/APIConfig';
import {ConnectionRepository} from '@app/api/connection/ConnectionRepository';
import {CosmeticRepository} from '@app/api/cosmetics/CosmeticRepository';
import {CosmeticService} from '@app/api/cosmetics/CosmeticService';
import {DonationRepository} from '@app/api/donation/DonationRepository';
import {createEmailProvider} from '@app/api/email/EmailProviderFactory';
import {EnforcementDecisionRepository} from '@app/api/enforcement/EnforcementDecisionRepository';
import {FavoriteMemeRepository} from '@app/api/favorite_meme/FavoriteMemeRepository';
import {FeedDiscoverRepository} from '@app/api/feed/discover/FeedDiscoverRepository';
import {createFeedTrendCounterFlusher, FeedTrendService} from '@app/api/feed/discover/FeedTrendService';
import {sendFeedAuthorDm} from '@app/api/feed/FeedAuthorDm';
import {FeedPostService} from '@app/api/feed/FeedPostService';
import {FeedRepository} from '@app/api/feed/FeedRepository';
import {FeedTimelineService} from '@app/api/feed/FeedTimelineService';
import {createFeedInteractionCounterFlushers} from '@app/api/feed/interaction/FeedInteractionCounters';
import {FeedInteractionRepository} from '@app/api/feed/interaction/FeedInteractionRepository';
import {FeedInteractionService} from '@app/api/feed/interaction/FeedInteractionService';
import {FeedNotificationRepository} from '@app/api/feed/notification/FeedNotificationRepository';
import {FeedNotificationService} from '@app/api/feed/notification/FeedNotificationService';
import {feedSuggestionCache} from '@app/api/feed/suggest/FeedSuggestionCache';
import {FeedSuggestionRepository} from '@app/api/feed/suggest/FeedSuggestionRepository';
import {FeedSuggestionService} from '@app/api/feed/suggest/FeedSuggestionService';
import {BunnyStreamClient} from '@app/api/feed/video/BunnyStreamClient';
import {FeedVideoRepository} from '@app/api/feed/video/FeedVideoRepository';
import {FeedVideoScanner} from '@app/api/feed/video/FeedVideoScanner';
import {deferLongWaits, FeedVideoService} from '@app/api/feed/video/FeedVideoService';
import {FeedViewService} from '@app/api/feed/views/FeedViewService';
import {createFollowCounterFlushers} from '@app/api/follow/FollowCounters';
import {FollowRepository} from '@app/api/follow/FollowRepository';
import {FollowService} from '@app/api/follow/FollowService';
import {GatewayRequestService} from '@app/api/gateway/GatewayRequestService';
import {createNatsGifProvider} from '@app/api/gif/NatsGifProvider';
import {createGuildBoostCounterFlushers} from '@app/api/guild/boost/GuildBoostCounters';
import {GuildBoostRepository} from '@app/api/guild/boost/GuildBoostRepository';
import {GuildBoostService} from '@app/api/guild/boost/GuildBoostService';
import {GuildAuditLogService} from '@app/api/guild/GuildAuditLogService';
import {createMicupBotLevels} from '@app/api/guild/micupbot/MicupBotLevels';
import {notifyMicupBotMemberLeave} from '@app/api/guild/micupbot/MicupBotMemberHooks';
import {MicupBotRepository} from '@app/api/guild/micupbot/MicupBotRepository';
import {
	type MicupBotSettingsDependencies,
	MicupBotSettingsService,
} from '@app/api/guild/micupbot/MicupBotSettingsService';
import {createMicupBotXpCounterFlusher} from '@app/api/guild/micupbot/MicupBotXpCounters';
import {GuildDiscoveryRepository} from '@app/api/guild/repositories/GuildDiscoveryRepository';
import {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import {GuildRosterRepository} from '@app/api/guild/roster/GuildRosterRepository';
import {GuildRosterSettingsService} from '@app/api/guild/roster/GuildRosterSettingsService';
import {GuildDiscoveryService} from '@app/api/guild/services/GuildDiscoveryService';
import {GuildSoundboardPlayService} from '@app/api/guild/soundboard/GuildSoundboardPlayService';
import {GuildSoundboardRepository} from '@app/api/guild/soundboard/GuildSoundboardRepository';
import {GuildSoundboardService} from '@app/api/guild/soundboard/GuildSoundboardService';
import {AssetDeletionQueue} from '@app/api/infrastructure/AssetDeletionQueue';
import {AvatarService} from '@app/api/infrastructure/AvatarService';
import {CachePurgeQueue, type IPurgeQueue, NoopPurgeQueue} from '@app/api/infrastructure/CachePurgeQueue';
import {DisabledLiveKitService} from '@app/api/infrastructure/DisabledLiveKitService';
import {DisabledVirusScanService} from '@app/api/infrastructure/DisabledVirusScanService';
import {DiscriminatorService} from '@app/api/infrastructure/DiscriminatorService';
import {EmailDnsValidationService} from '@app/api/infrastructure/EmailDnsValidationService';
import {EmbedService} from '@app/api/infrastructure/EmbedService';
import {EntityAssetService} from '@app/api/infrastructure/EntityAssetService';
import {ErrorI18nService} from '@app/api/infrastructure/ErrorI18nService';
import type {IAssetDeletionQueue} from '@app/api/infrastructure/IAssetDeletionQueue';
import type {IStorageService} from '@app/api/infrastructure/IStorageService';
import type {IUnfurlerService} from '@app/api/infrastructure/IUnfurlerService';
import {KVAccountDeletionQueueService} from '@app/api/infrastructure/KVAccountDeletionQueueService';
import {KVActivityTracker} from '@app/api/infrastructure/KVActivityTracker';
import {KVBulkMessageDeletionQueueService} from '@app/api/infrastructure/KVBulkMessageDeletionQueueService';
import {type CounterFlusher, KVCounterService} from '@app/api/infrastructure/KVCounterService';
import {KVThreadAutoArchiveQueueService} from '@app/api/infrastructure/KVThreadAutoArchiveQueueService';
import {NatsUnfurlerService} from '@app/api/infrastructure/NatsUnfurlerService';
import {PremiumStateReconciliationQueueService} from '@app/api/infrastructure/PremiumStateReconciliationQueueService';
import {createStorageService} from '@app/api/infrastructure/StorageServiceFactory';
import {UserCacheService} from '@app/api/infrastructure/UserCacheService';
import {createUsersServiceClient} from '@app/api/infrastructure/UsersServiceClient';
import {VirusScanService} from '@app/api/infrastructure/VirusScanService';
import {type ContactEmails, resolveContactEmails} from '@app/api/instance/ContactEmails';
import {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {NatsConfigPublisher} from '@app/api/instance/NatsConfigPublisher';
import {getInstanceProductName} from '@app/api/instance/ProductName';
import {ensureSetupToken} from '@app/api/instance/SetupToken';
import {InviteRepository} from '@app/api/invite/InviteRepository';
import {Logger} from '@app/api/Logger';
import {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {
	acquireSnowflakeService,
	getGatewayService,
	getKVClient,
	getLiveKitServiceInstance,
	getMediaService,
	getSnowflakeService,
	getWorkerService,
	releaseSnowflakeService,
	type SnowflakeServiceHandle,
} from '@app/api/middleware/ServiceRegistry';
import {clearSingletonsForTesting, singleton} from '@app/api/middleware/Singleton';
import {BotAuthService} from '@app/api/oauth/BotAuthService';
import {BotMfaMirrorService} from '@app/api/oauth/BotMfaMirrorService';
import {ApplicationRepository} from '@app/api/oauth/repositories/ApplicationRepository';
import {OAuth2TokenRepository} from '@app/api/oauth/repositories/OAuth2TokenRepository';
import {PayriffClient} from '@app/api/payriff/PayriffClient';
import {PayriffRateLimiter} from '@app/api/payriff/PayriffRateLimiter';
import {PremiumLedgerRepository} from '@app/api/premium/ledger/PremiumLedgerRepository';
import {PremiumLedgerService} from '@app/api/premium/ledger/PremiumLedgerService';
import {PremiumTrialRepository} from '@app/api/premium/trial/PremiumTrialRepository';
import {PremiumTrialService} from '@app/api/premium/trial/PremiumTrialService';
import {VisionaryRepository} from '@app/api/premium/visionary/VisionaryRepository';
import {VisionaryService} from '@app/api/premium/visionary/VisionaryService';
import {ReadStateRepository} from '@app/api/read_state/ReadStateRepository';
import {ReadStateRequestService} from '@app/api/read_state/ReadStateRequestService';
import {ReadStateService} from '@app/api/read_state/ReadStateService';
import {ReferralAdminService} from '@app/api/referral/ReferralAdminService';
import {createReferralCounterFlushers} from '@app/api/referral/ReferralCounters';
import {ReferralRepository} from '@app/api/referral/ReferralRepository';
import {ReferralRewardService} from '@app/api/referral/ReferralRewardService';
import {ReferralService} from '@app/api/referral/ReferralService';
import {ReportRepository} from '@app/api/report/ReportRepository';
import {CassandraRegistrationEventsRepository} from '@app/api/risk/RegistrationEventsRepository';
import {getGuildSearchService} from '@app/api/SearchFactory';
import {ShopCatalogService} from '@app/api/shop/ShopCatalogService';
import {ShopOrderRepository} from '@app/api/shop/ShopOrderRepository';
import {ShopOrderService} from '@app/api/shop/ShopOrderService';
import {ShopPriceRepository} from '@app/api/shop/ShopPriceRepository';
import {AppStoreServerApiClient} from '@app/api/store_billing/app_store/AppStoreServerApiClient';
import {GooglePlayAccessTokenProvider} from '@app/api/store_billing/google_play/GooglePlayAccessTokenProvider';
import {GooglePlayDeveloperApiClient} from '@app/api/store_billing/google_play/GooglePlayDeveloperApiClient';
import {GooglePlayPushVerifier} from '@app/api/store_billing/google_play/GooglePlayPushVerifier';
import {StoreBillingRepository} from '@app/api/store_billing/StoreBillingRepository';
import {TableGameRepository} from '@app/api/table_game/TableGameRepository';
import {TableGameService} from '@app/api/table_game/TableGameService';
import {ThemeService} from '@app/api/theme/ThemeService';
import {EntranceSoundPlayService} from '@app/api/user/entrance_sound/EntranceSoundPlayService';
import {EntranceSoundRepository} from '@app/api/user/entrance_sound/EntranceSoundRepository';
import {EntranceSoundService} from '@app/api/user/entrance_sound/EntranceSoundService';
import {ProfileAccessCache} from '@app/api/user/profile/ProfileAccessCache';
import {EmailChangeRepository} from '@app/api/user/repositories/auth/EmailChangeRepository';
import {PasswordChangeRepository} from '@app/api/user/repositories/auth/PasswordChangeRepository';
import {UserContactChangeLogRepository} from '@app/api/user/repositories/UserContactChangeLogRepository';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import {VisionarySlotRepository} from '@app/api/user/repositories/VisionarySlotRepository';
import {GameActivityPolicyService} from '@app/api/user/services/GameActivityPolicyService';
import {ProfileAccessService} from '@app/api/user/services/ProfileAccessService';
import {UserActivityBuffer} from '@app/api/user/services/UserActivityBuffer';
import {UserContactChangeLogService} from '@app/api/user/services/UserContactChangeLogService';
import {awaitAll} from '@app/api/utils/ConcurrencyUtils';
import {UserPermissionUtils} from '@app/api/utils/UserPermissionUtils';
import {VoiceP2pConnectionReportRepository} from '@app/api/voice/VoiceP2pConnectionReportRepository';
import {VoiceRepository} from '@app/api/voice/VoiceRepository';
import {VoiceSeatRepository} from '@app/api/voice_seat/VoiceSeatRepository';
import {VoiceSeatService} from '@app/api/voice_seat/VoiceSeatService';
import {SweegoWebhookService} from '@app/api/webhook/SweegoWebhookService';
import {WebhookRepository} from '@app/api/webhook/WebhookRepository';
import type {InstanceBranding} from '@fluxer/schema/src/domains/instance/InstanceSchemas';
import type {ICacheService} from '@pkgs/cache/src/ICacheService';
import {KVCacheProvider} from '@pkgs/cache/src/providers/KVCacheProvider';
import type {EmailConfig, UserBouncedEmailChecker} from '@pkgs/email/src/EmailProviderTypes';
import {EmailService} from '@pkgs/email/src/EmailService';
import type {IEmailService} from '@pkgs/email/src/IEmailService';
import {TestEmailService} from '@pkgs/email/src/TestEmailService';
import {createIpInfoService, createUnavailableIpInfoService, type IpInfoService} from '@pkgs/geoip/src/IpInfoService';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';
import {NatsConnectionManager} from '@pkgs/nats/src/NatsConnectionManager';
import {RateLimitService} from '@pkgs/rate_limit/src/RateLimitService';
import type {IVirusScanService} from '@pkgs/virus_scan/src/IVirusScanService';

export const getUserRepository = singleton(() => new UserRepository(getKVClient()));
export const getGuildRepository = singleton(() => new GuildRepository());
export const getChannelRepository = singleton(() => new ChannelRepository());
export const getInviteRepository = singleton(() => new InviteRepository());
export const getWebhookRepository = singleton(() => new WebhookRepository());
export const getReadStateRepository = singleton(() => new ReadStateRepository());
export const getFavoriteMemeRepository = singleton(() => new FavoriteMemeRepository());
export const getConnectionRepository = singleton(() => new ConnectionRepository());
export const getReportRepository = singleton(() => new ReportRepository());
export const getEnforcementDecisionRepository = singleton(() => new EnforcementDecisionRepository());
export const getVoiceP2pConnectionReportRepository = singleton(() => new VoiceP2pConnectionReportRepository());
export const getAdminRepository = singleton(() => new AdminRepository());
export const getAdminArchiveRepository = singleton(() => new AdminArchiveRepository());
export const getVoiceRepository = singleton(() => new VoiceRepository());
export const getApplicationRepository = singleton(() => new ApplicationRepository());
export const getOAuth2TokenRepository = singleton(() => new OAuth2TokenRepository());
export const getGuildDiscoveryRepository = singleton(() => new GuildDiscoveryRepository());
export const getEmailChangeRepository = singleton(() => new EmailChangeRepository());
export const getPasswordChangeRepository = singleton(() => new PasswordChangeRepository());
const getUserContactChangeLogRepository = singleton(() => new UserContactChangeLogRepository());
export const getDonationRepository = singleton(() => new DonationRepository());
export const getRegistrationEventsRepository = singleton(() => new CassandraRegistrationEventsRepository());

export const getPremiumLedgerRepository = singleton(() => new PremiumLedgerRepository());

export function getPremiumLedgerService(): PremiumLedgerService {
	return new PremiumLedgerService({
		repository: getPremiumLedgerRepository(),
		userRepository: getUserRepository(),
		kvClient: getKVClient(),
		workerService: getWorkerService(),
		gatewayService: getGatewayService(),
		userCacheService: getUserCacheService(),
		visionaryRepository: getVisionaryRepository(),
	});
}

const getPremiumTrialRepository = singleton(() => new PremiumTrialRepository());

export function getPremiumTrialService(): PremiumTrialService {
	return new PremiumTrialService({
		repository: getPremiumTrialRepository(),
		ledgerService: getPremiumLedgerService(),
		ledgerRepository: getPremiumLedgerRepository(),
		instanceConfigRepository: getInstanceConfigRepository(),
		adminRepository: getAdminRepository(),
		kvClient: getKVClient(),
	});
}

export const getStoreBillingRepository = singleton(() => new StoreBillingRepository());
export const getAppStoreServerApiClient = singleton(() => new AppStoreServerApiClient());
const getGooglePlayAccessTokenProvider = singleton(() => new GooglePlayAccessTokenProvider());
export const getGooglePlayDeveloperApiClient = singleton(
	() => new GooglePlayDeveloperApiClient({accessTokenProvider: getGooglePlayAccessTokenProvider()}),
);
export const getGooglePlayPushVerifier = singleton(() => new GooglePlayPushVerifier());
const getAdminApiKeyRepository = singleton(() => new AdminApiKeyRepository());
let instanceConfigRepositoryInstance: InstanceConfigRepository | null = null;
export const getInstanceConfigRepository = singleton(
	() => {
		const repository = new InstanceConfigRepository(getKVClient());
		instanceConfigRepositoryInstance = repository;
		return repository;
	},
	(repository) => {
		if (instanceConfigRepositoryInstance === repository) instanceConfigRepositoryInstance = null;
		void repository.shutdown().catch((error) => {
			Logger.error({error}, 'Failed to shut down instance config repository');
		});
	},
);

export async function shutdownInstanceConfigRepository(): Promise<void> {
	await instanceConfigRepositoryInstance?.shutdown();
}

export const getNatsConfigPublisher = singleton(
	() =>
		new NatsConfigPublisher(
			new NatsConnectionManager({
				url: Config.nats.coreUrl,
				token: Config.nats.authToken || undefined,
				name: 'fluxer-api-config',
			}),
		),
);

export const getVisionarySlotRepository = singleton(() => new VisionarySlotRepository());
export const getCacheService: () => ICacheService = singleton(() => new KVCacheProvider({client: getKVClient()}));
let injectedIpInfoService: IpInfoService | undefined;
export function setInjectedIpInfoService(service: IpInfoService | undefined): void {
	injectedIpInfoService = service;
}
const getConfiguredIpInfoService = singleton(() =>
	Config.risk.ipinfoApiKey
		? createIpInfoService({
				apiKey: Config.risk.ipinfoApiKey,
				cache: getCacheService(),
				budget: createKvIpInfoLookupBudget({getKvClient: getKVClient}),
			})
		: createUnavailableIpInfoService(),
);
export function getIpInfoService(): IpInfoService {
	return injectedIpInfoService ?? getConfiguredIpInfoService();
}
export const getRateLimitService = singleton(() => new RateLimitService(getKVClient()));
export const getEmailDnsValidationService = singleton(() => new EmailDnsValidationService());

function createEmailServiceForConfig(
	emailConfigSource: APIConfig['email'],
	contactEmails: ContactEmails,
	productName: string,
	bouncedEmailChecker: UserBouncedEmailChecker,
	branding: InstanceBranding | null,
): IEmailService {
	const emailConfig: EmailConfig = {
		enabled: emailConfigSource.enabled,
		fromEmail: emailConfigSource.fromEmail,
		fromName: emailConfigSource.fromName.trim() || productName,
		replyTo: emailConfigSource.replyToEmail || null,
		appBaseUrl: emailConfigSource.appBaseUrl,
		appealsEmail: contactEmails.appealsEmail,
		safetyEmail: contactEmails.safetyEmail,
		supportEmail: contactEmails.supportEmail,
		productName,
		html: branding && {
			productName: branding.product_name,
			logoUrl: branding.icon_url ?? branding.logo_url,
			headerColor: branding.theme_color,
			footer: emailConfigSource.htmlFooter,
		},
	};
	return new EmailService(emailConfig, createEmailProvider(emailConfigSource), bouncedEmailChecker);
}

export function createRuntimeEmailService(
	bouncedEmailChecker: UserBouncedEmailChecker,
	getRepository: () => InstanceConfigRepository = getInstanceConfigRepository,
): IEmailService {
	return new Proxy({} as IEmailService, {
		get(_target, property) {
			return async (...args: Array<unknown>): Promise<boolean> => {
				const instanceConfigRepository = getRepository();
				const [emailConfig, appPublic] = await Promise.all([
					instanceConfigRepository.getEffectiveEmailConfig(),
					instanceConfigRepository.getAppPublicConfig(),
				]);
				const delegate = createEmailServiceForConfig(
					emailConfig,
					resolveContactEmails(),
					getInstanceProductName(),
					bouncedEmailChecker,
					emailConfig.htmlEnabled ? appPublic.branding : null,
				);
				const method = delegate[property as keyof IEmailService];
				if (typeof method !== 'function') {
					throw new Error(`Unknown email service method: ${String(property)}`);
				}
				return (method as (this: IEmailService, ...methodArgs: Array<unknown>) => Promise<boolean>).apply(
					delegate,
					args,
				);
			};
		},
	});
}

let _injectedStorageService: IStorageService | undefined;

export function setInjectedStorageService(service: IStorageService | undefined): void {
	_injectedStorageService = service;
}

export const getStorageService: () => IStorageService = (() => {
	const fallback = singleton(() => createStorageService());
	return () => _injectedStorageService ?? fallback();
})();
export const getErrorI18nService = singleton(() => new ErrorI18nService());
let limitConfigServiceInstance: LimitConfigService | null = null;
export const getLimitConfigService = singleton(
	() => {
		const service = new LimitConfigService(getInstanceConfigRepository(), getCacheService(), getKVClient());
		limitConfigServiceInstance = service;
		return service;
	},
	(service) => {
		const shutdown = limitConfigServiceInstance === service ? shutdownServiceSingletons() : service.shutdown();
		if (limitConfigServiceInstance === service) {
			limitConfigServiceInstance = null;
		}
		void shutdown.catch((err) => {
			Logger.error({err}, 'Failed to shut down service singletons');
		});
	},
);
export const getPurgeQueue: () => IPurgeQueue = singleton(() =>
	Config.cachePurge.adapter === 'none' ? new NoopPurgeQueue() : new CachePurgeQueue(getKVClient()),
);
export const getAssetDeletionQueue: () => IAssetDeletionQueue = singleton(() => new AssetDeletionQueue(getKVClient()));

let bulkMessageDeletionQueueClient: IKVProvider | null = null;
let bulkMessageDeletionQueue: KVBulkMessageDeletionQueueService | null = null;

export function getKVBulkMessageDeletionQueue(): KVBulkMessageDeletionQueueService {
	const kvClient = getKVClient();
	if (!bulkMessageDeletionQueue || bulkMessageDeletionQueueClient !== kvClient) {
		bulkMessageDeletionQueue = new KVBulkMessageDeletionQueueService(kvClient, getUserRepository());
		bulkMessageDeletionQueueClient = kvClient;
	}
	return bulkMessageDeletionQueue;
}

let threadAutoArchiveQueueClient: IKVProvider | null = null;
let threadAutoArchiveQueue: KVThreadAutoArchiveQueueService | null = null;

export function getKVThreadAutoArchiveQueue(): KVThreadAutoArchiveQueueService {
	const kvClient = getKVClient();
	if (!threadAutoArchiveQueue || threadAutoArchiveQueueClient !== kvClient) {
		threadAutoArchiveQueue = new KVThreadAutoArchiveQueueService(kvClient);
		threadAutoArchiveQueueClient = kvClient;
	}
	return threadAutoArchiveQueue;
}

let premiumStateQueueClient: IKVProvider | null = null;
let premiumStateQueue: PremiumStateReconciliationQueueService | null = null;

export function getPremiumStateReconciliationQueueService(): PremiumStateReconciliationQueueService {
	const kvClient = getKVClient();
	if (!premiumStateQueue || premiumStateQueueClient !== kvClient) {
		premiumStateQueue = new PremiumStateReconciliationQueueService(kvClient);
		premiumStateQueueClient = kvClient;
	}
	return premiumStateQueue;
}

let activityTrackerClient: IKVProvider | null = null;
let activityTracker: KVActivityTracker | null = null;

export function getKVActivityTracker(): KVActivityTracker {
	const kvClient = getKVClient();
	if (!activityTracker || activityTrackerClient !== kvClient) {
		activityTracker = new KVActivityTracker(kvClient);
		activityTrackerClient = kvClient;
	}
	return activityTracker;
}

let activityBufferClient: IKVProvider | null = null;
let activityBuffer: UserActivityBuffer | null = null;

export function getUserActivityBuffer(): UserActivityBuffer {
	const kvClient = getKVClient();
	if (!activityBuffer || activityBufferClient !== kvClient) {
		activityBuffer = new UserActivityBuffer(kvClient);
		activityBufferClient = kvClient;
	}
	return activityBuffer;
}

export const GUILD_MEMBER_COUNT_COUNTER = 'guild_member_count';
const GUILD_MEMBER_RECOUNT_PAGE_SIZE = 5000;

function createGuildMemberCountFlusher(guildRepository: GuildRepository): CounterFlusher {
	return {
		namespace: GUILD_MEMBER_COUNT_COUNTER,
		async readBase(id) {
			return (await guildRepository.findMemberCount(createGuildID(BigInt(id)))) ?? 0;
		},
		async flush(id, value) {
			const guildId = createGuildID(BigInt(id));
			const memberCount = Math.max(0, value);
			const stored = await guildRepository.findMemberCount(guildId);
			// A missing row means the guild was deleted; writing would resurrect it as a partial row.
			if (stored !== null && stored !== memberCount) {
				await guildRepository.setMemberCount(guildId, memberCount);
			}
		},
		async recount(id) {
			const guildId = createGuildID(BigInt(id));
			let count = 0;
			let after: UserID | undefined;
			for (;;) {
				const page = await guildRepository.listMembersPaginated(guildId, GUILD_MEMBER_RECOUNT_PAGE_SIZE, after);
				count += page.length;
				if (page.length < GUILD_MEMBER_RECOUNT_PAGE_SIZE) {
					return count;
				}
				after = page[page.length - 1]!.userId;
			}
		},
	};
}

let counterServiceClient: IKVProvider | null = null;
let counterService: KVCounterService | null = null;

export function getKVCounterService(): KVCounterService {
	const kvClient = getKVClient();
	if (!counterService || counterServiceClient !== kvClient) {
		counterService = new KVCounterService(kvClient);
		counterService.register(createGuildMemberCountFlusher(getGuildRepository()));
		counterService.register(createMessageReactionUserCounterFlusher(getChannelRepository()));
		for (const flusher of [
			...createFollowCounterFlushers(getFollowRepository()),
			...createGuildBoostCounterFlushers(getGuildBoostRepository()),
			...createFeedInteractionCounterFlushers(getFeedInteractionRepository()),
			createFeedTrendCounterFlusher(new FeedDiscoverRepository(kvClient)),
			...createReferralCounterFlushers(getReferralRepository()),
			createMicupBotXpCounterFlusher(getMicupBotRepository()),
		]) {
			counterService.register(flusher);
		}
		counterServiceClient = kvClient;
	}
	return counterService;
}

/**
 * Deletes a guild member row and decrements member_count only when this call removed the row, so racing
 * removals of the same member (kick + kick, ban + leave, repeated leaves) count once.
 */
export async function removeGuildMemberCounted(
	guildRepository: Pick<GuildRepository, 'getMember' | 'deleteMember'>,
	guildId: GuildID,
	userId: UserID,
): Promise<boolean> {
	const counters = getKVCounterService();
	const id = guildId.toString();
	let temporary = false;
	const removed = await counters.withSubjectLock(GUILD_MEMBER_COUNT_COUNTER, id, userId.toString(), async () => {
		const member = await guildRepository.getMember(guildId, userId);
		temporary = member?.isTemporary ?? false;
		if (!member) {
			return false;
		}
		await guildRepository.deleteMember(guildId, userId);
		await counters.add(GUILD_MEMBER_COUNT_COUNTER, id, -1);
		return true;
	});
	// a member who leaves, is kicked or banned stops boosting. Never throws (a failed cleanup goes to
	// the removeMemberBoosts job), so the gateway leave and GUILD_MEMBER_REMOVE after this call always happen.
	await getGuildBoostService().removeMemberBoostsOrQueue(guildId, userId);
	notifyMicupBotMemberLeave({guildId, userId, removed, temporary});
	return removed;
}

let accountDeletionQueueClient: IKVProvider | null = null;
let accountDeletionQueue: KVAccountDeletionQueueService | null = null;

export function getKVAccountDeletionQueue(): KVAccountDeletionQueueService {
	const kvClient = getKVClient();
	if (!accountDeletionQueue || accountDeletionQueueClient !== kvClient) {
		accountDeletionQueue = new KVAccountDeletionQueueService(kvClient, getUserRepository());
		accountDeletionQueueClient = kvClient;
	}
	return accountDeletionQueue;
}

export const getThemeService = singleton(() => new ThemeService(getStorageService()));
export const getAttachmentUploadTraceRepository = singleton(() => new AttachmentUploadTraceRepository());

export const getVirusScanServiceInstance: () => IVirusScanService = singleton(() => {
	const VirusScanServiceClass = Config.clamav.enabled ? VirusScanService : DisabledVirusScanService;
	const service = new VirusScanServiceClass(getCacheService());
	return service;
});

export const getEmailService: () => IEmailService = singleton(() => {
	if (Config.dev.testModeEnabled) return new TestEmailService();
	const userRepository = getUserRepository();
	const bouncedEmailChecker: UserBouncedEmailChecker = {
		isEmailBounced: async (email: string) => {
			const user = await userRepository.findByEmail(email);
			return user?.emailBounced ?? false;
		},
	};
	return createRuntimeEmailService(bouncedEmailChecker);
});
let _injectedUnfurlerService: IUnfurlerService | undefined;

export function setInjectedUnfurlerService(service: IUnfurlerService | undefined): void {
	_injectedUnfurlerService = service;
}

const getDefaultUnfurlerService = singleton(() => {
	const instanceConfigRepository = getInstanceConfigRepository();
	const manager = new NatsConnectionManager({
		url: Config.nats.coreUrl,
		token: Config.nats.authToken || undefined,
		name: 'fluxer-api-unfurl',
	});
	void manager.connect().catch((error) => {
		Logger.error({error}, '[nats-unfurl] Failed to establish NATS connection');
	});
	return new NatsUnfurlerService(
		manager,
		async () => instanceConfigRepository.getEffectiveYoutubeApiKey(),
		async () => (await instanceConfigRepository.getEffectiveGifConfig()).klipy_api_key,
	);
});

export function getUnfurlerService(): IUnfurlerService {
	return _injectedUnfurlerService ?? getDefaultUnfurlerService();
}

export const getEmbedService = singleton(
	() => new EmbedService(getUnfurlerService(), getMediaService(), getWorkerService()),
);
export const getReadStateService = singleton(() => new ReadStateService(getReadStateRepository(), getGatewayService()));
export const getDiscriminatorService = singleton(
	() => new DiscriminatorService(getUserRepository(), getCacheService(), getLimitConfigService()),
);
export const getBotAuthService = singleton(() => new BotAuthService(getApplicationRepository(), getUserRepository()));
export const getBotMfaMirrorService = singleton(
	() => new BotMfaMirrorService(getApplicationRepository(), getUserRepository(), getGatewayService()),
);
export const getGifService = singleton(() => {
	const instanceConfigRepository = getInstanceConfigRepository();
	return createNatsGifProvider(async () => (await instanceConfigRepository.getEffectiveGifConfig()).klipy_api_key);
});
export const getGuildAuditLogService = singleton(
	() => new GuildAuditLogService(getGuildRepository(), getSnowflakeService(), getWorkerService(), getGatewayService()),
);
export const getUserPermissionUtils = singleton(
	() => new UserPermissionUtils(getUserRepository(), getGuildRepository()),
);
export const getContactChangeLogService = singleton(
	() => new UserContactChangeLogService(getUserContactChangeLogRepository()),
);
export const getSweegoWebhookService = singleton(
	() => new SweegoWebhookService(getUserRepository(), getGatewayService()),
);
export const getStreamPreviewService = singleton(
	() => new StreamPreviewService(getStorageService(), getCacheService()),
);
export const getAvatarService = singleton(
	() => new AvatarService(getStorageService(), getMediaService(), getLimitConfigService()),
);
export const getEntityAssetService = singleton(
	() =>
		new EntityAssetService(getStorageService(), getMediaService(), getAssetDeletionQueue(), getLimitConfigService()),
);
export const getAdminApiKeyService = singleton(
	() => new AdminApiKeyService(getAdminApiKeyRepository(), getSnowflakeService()),
);
export const getAdminArchiveService = singleton(
	() =>
		new AdminArchiveService(
			getAdminArchiveRepository(),
			getUserRepository(),
			getGuildRepository(),
			getStorageService(),
			getSnowflakeService(),
			getWorkerService(),
		),
);
const getEntranceSoundRepository = singleton(() => new EntranceSoundRepository());
const getGuildSoundboardRepository = singleton(() => new GuildSoundboardRepository());
export const getGuildSoundboardService = singleton(
	() =>
		new GuildSoundboardService(
			getGuildSoundboardRepository(),
			getStorageService(),
			getMediaService(),
			getLimitConfigService(),
			getGatewayService(),
		),
);
export const getGuildSoundboardPlayService = singleton(
	() =>
		new GuildSoundboardPlayService(
			getGuildSoundboardRepository(),
			getGatewayService(),
			getChannelRepository().channelData,
			getRateLimitService(),
		),
);
export const getEntranceSoundService = singleton(
	() =>
		new EntranceSoundService(
			getEntranceSoundRepository(),
			getStorageService(),
			getMediaService(),
			getLimitConfigService(),
		),
);
export const getEntranceSoundPlayService = singleton(
	() => new EntranceSoundPlayService(getEntranceSoundService(), getGatewayService(), getChannelRepository()),
);
export const getGatewayRequestService = singleton(() => new GatewayRequestService(getBotAuthService()));
export const getGuildDiscoveryService = singleton(
	() =>
		new GuildDiscoveryService(
			getGuildDiscoveryRepository(),
			getGuildRepository(),
			getGatewayService(),
			getGuildSearchService(),
			getChannelRepository().channelData,
		),
);
export const getReadStateRequestService = singleton(() => new ReadStateRequestService(getReadStateService()));
export const getUserCacheService = singleton(() => createUserCacheService());

export function createUserCacheService(): UserCacheService {
	return new UserCacheService(createUsersServiceClient());
}

// Micup feature services; the worker tasks of the same features reuse these repositories.
export const getCosmeticRepository = singleton(() => new CosmeticRepository());
export const getCosmeticService = singleton(
	() =>
		new CosmeticService({
			repository: getCosmeticRepository(),
			userRepository: getUserRepository(),
			userCacheService: getUserCacheService(),
			gatewayService: getGatewayService(),
			workerService: getWorkerService(),
			entityAssetService: getEntityAssetService(),
			snowflakeService: getSnowflakeService(),
		}),
);
export const getShopPriceRepository = singleton(() => new ShopPriceRepository());
export const getShopOrderRepository = singleton(() => new ShopOrderRepository());
export const getPayriffClient = singleton(
	() => new PayriffClient({secretKey: Config.payriff.secretKey, baseUrl: Config.payriff.baseUrl, timeoutMs: 10_000}),
);
export const getPayriffRateLimiter = singleton(() => new PayriffRateLimiter({kvClient: getKVClient()}));
export const getShopCatalogService = singleton(
	() =>
		new ShopCatalogService({
			priceRepository: getShopPriceRepository(),
			badgeRepository: getBadgeRepository(),
			cosmeticService: getCosmeticService(),
			cosmeticRepository: getCosmeticRepository(),
			instanceConfigRepository: getInstanceConfigRepository(),
			premiumLedgerRepository: getPremiumLedgerRepository(),
			kvClient: getKVClient(),
			visionaryStock: getVisionaryService(),
			snowflakeService: getSnowflakeService(),
		}),
);
export const getVisionaryRepository = singleton(() => new VisionaryRepository());
export const getVisionaryService = singleton(
	() =>
		new VisionaryService({
			repository: getVisionaryRepository(),
			userRepository: getUserRepository(),
			userCacheService: getUserCacheService(),
			gatewayService: getGatewayService(),
			kvClient: getKVClient(),
			premiumLedgerService: getPremiumLedgerService(),
			cosmeticService: getCosmeticService(),
			cosmeticRepository: getCosmeticRepository(),
			instanceConfigRepository: getInstanceConfigRepository(),
		}),
);
export const getShopOrderService = singleton(
	() =>
		new ShopOrderService({
			orderRepository: getShopOrderRepository(),
			catalogService: getShopCatalogService(),
			payriffClient: getPayriffClient(),
			rateLimiter: getPayriffRateLimiter(),
			cosmeticService: getCosmeticService(),
			premiumLedgerService: getPremiumLedgerService(),
			visionaryService: getVisionaryService(),
			earlyPlusBadgeService: getEarlyPlusBadgeService(),
			userRepository: getUserRepository(),
			kvClient: getKVClient(),
			workerService: getWorkerService(),
			snowflakeService: getSnowflakeService(),
		}),
);
export const getReferralRepository = singleton(() => new ReferralRepository());
export const getReferralService = singleton(
	() =>
		new ReferralService({
			repository: getReferralRepository(),
			instanceConfigRepository: getInstanceConfigRepository(),
			kvCounterService: getKVCounterService(),
		}),
);
export const getReferralRewardService = singleton(
	() =>
		new ReferralRewardService({
			repository: getReferralRepository(),
			instanceConfigRepository: getInstanceConfigRepository(),
			kvCounterService: getKVCounterService(),
			kvClient: getKVClient(),
			userRepository: getUserRepository(),
			registrationEventsRepository: getRegistrationEventsRepository(),
			cosmeticService: getCosmeticService(),
			premiumLedgerService: getPremiumLedgerService(),
			workerService: getWorkerService(),
		}),
);
export const getReferralAdminService = singleton(
	() =>
		new ReferralAdminService({
			repository: getReferralRepository(),
			instanceConfigRepository: getInstanceConfigRepository(),
			cosmeticService: getCosmeticService(),
			userRepository: getUserRepository(),
			workerService: getWorkerService(),
			emailService: getEmailService(),
			snowflakeService: getSnowflakeService(),
		}),
);
const getVoiceRoomChannelAuthService = singleton(
	() => new ChannelAuthService(getChannelRepository(), getUserRepository(), getGuildRepository(), getGatewayService()),
);
export const getVoiceSeatRepository = singleton(() => new VoiceSeatRepository(getKVClient()));
export const getVoiceSeatService = singleton(
	() =>
		new VoiceSeatService({
			repository: getVoiceSeatRepository(),
			instanceConfigRepository: getInstanceConfigRepository(),
			channelAuthService: getVoiceRoomChannelAuthService(),
			gatewayService: getGatewayService(),
			liveKitService: getLiveKitServiceInstance() ?? new DisabledLiveKitService(),
		}),
);
export const getTableGameRepository = singleton(() => new TableGameRepository(getKVClient()));
export const getTableGameService = singleton(
	() =>
		new TableGameService({
			repository: getTableGameRepository(),
			instanceConfigRepository: getInstanceConfigRepository(),
			channelAuthService: getVoiceRoomChannelAuthService(),
			gatewayService: getGatewayService(),
			voiceSeatService: getVoiceSeatService(),
			channelRepository: getChannelRepository().channelData,
		}),
);
export const getBadgeRepository = singleton(() => new BadgeRepository());
export const getBadgeService = singleton(
	() =>
		new BadgeService({
			repository: getBadgeRepository(),
			storageService: getStorageService(),
			mediaService: getMediaService(),
			snowflakeService: getSnowflakeService(),
		}),
);
export const getPioneerRepository = singleton(() => new PioneerRepository());
export const getPioneerService = singleton(
	() =>
		new PioneerService({
			repository: getPioneerRepository(),
			badgeRepository: getBadgeRepository(),
			userRepository: getUserRepository(),
			kvClient: getKVClient(),
			workerService: getWorkerService(),
		}),
);
export const getEarlyPlusBadgeService = singleton(
	() =>
		new EarlyPlusBadgeService({
			badgeRepository: getBadgeRepository(),
			instanceConfigRepository: getInstanceConfigRepository(),
			orderRepository: getShopOrderRepository(),
			userRepository: getUserRepository(),
			visionaryService: getVisionaryService(),
		}),
);
export const getMicupBotRepository = singleton(() => new MicupBotRepository());
export function getMicupBotSettingsService(
	services: Pick<MicupBotSettingsDependencies, 'guildService' | 'channelService'>,
): MicupBotSettingsService {
	return new MicupBotSettingsService({
		repository: getMicupBotRepository(),
		guildRepository: getGuildRepository(),
		channelRepository: getChannelRepository(),
		gatewayService: getGatewayService(),
		limitConfigService: getLimitConfigService(),
		cacheService: getCacheService(),
		kvClient: getKVClient(),
		snowflakeService: getSnowflakeService(),
		userCacheService: getUserCacheService(),
		...services,
		userRepository: getUserRepository(),
		workerService: () => getWorkerService(),
	});
}
export const getMicupBotLevels = singleton(() =>
	createMicupBotLevels({
		kvClient: getKVClient(),
		counterService: getKVCounterService(),
		repository: getMicupBotRepository(),
		workerService: () => getWorkerService(),
	}),
);
export function getMessageComponentService(
	services: Pick<MessageComponentServiceDeps, 'channelService'>,
): MessageComponentService {
	return new MessageComponentService(getGatewayService(), {channelRepository: getChannelRepository(), ...services});
}
export const getGuildRosterRepository = singleton(() => new GuildRosterRepository());
export const getGuildRosterSettingsService = singleton(
	() =>
		new GuildRosterSettingsService({
			repository: getGuildRosterRepository(),
			limitConfigService: getLimitConfigService(),
			snowflakeService: getSnowflakeService(),
			gatewayService: getGatewayService(),
			guildRepository: getGuildRepository(),
			channelRepository: getChannelRepository(),
		}),
);
export const getGuildBoostRepository = singleton(() => new GuildBoostRepository());
export const getGuildBoostService = singleton(
	() =>
		new GuildBoostService({
			repository: getGuildBoostRepository(),
			guildRepository: getGuildRepository(),
			kvClient: getKVClient(),
			workerService: getWorkerService(),
			gatewayService: getGatewayService(),
			limitConfigService: getLimitConfigService(),
			snowflakeService: getSnowflakeService(),
			kvCounterService: getKVCounterService(),
			cacheService: getCacheService(),
			userRepository: getUserRepository(),
			userCacheService: getUserCacheService(),
			inviteRepository: getInviteRepository(),
			premiumLedgerRepository: getPremiumLedgerRepository(),
		}),
);
export const getFollowRepository = singleton(() => new FollowRepository(getKVClient()));
export const getFollowService = singleton(
	() =>
		new FollowService({
			repository: getFollowRepository(),
			userRepository: getUserRepository(),
			userCacheService: getUserCacheService(),
			gatewayService: getGatewayService(),
			kvCounterService: getKVCounterService(),
			limitConfigService: getLimitConfigService(),
			snowflakeService: getSnowflakeService(),
			notificationService: getFeedNotificationService(),
		}),
);
export const getFeedRepository = singleton(() => new FeedRepository(getKVClient()));
export const getProfileAccessCache = singleton(() => new ProfileAccessCache(getKVClient()));
// the profile access rule outside a request, for the owner level the Keşfet build reads, through
// the 60 s owner side record: `cache` is a ProfileAccessService dependency; passed as a
// variable, so this line needs no change when that lands.
export const getProfileAccessService = singleton(() => {
	const users = getUserRepository();
	const deps = {
		users,
		settings: users,
		relationships: users,
		channels: users,
		follows: getFollowRepository(),
		cache: getProfileAccessCache(),
	};
	return new ProfileAccessService(deps);
});

export const getGameActivityPolicyService = singleton(
	() => new GameActivityPolicyService({users: getUserRepository(), gateway: getGatewayService()}),
);
export const getFeedDiscoverRepository = singleton(() => new FeedDiscoverRepository(getKVClient()));
export const getFeedTrendService = singleton(
	() => new FeedTrendService({repository: getFeedDiscoverRepository(), kvCounterService: getKVCounterService()}),
);
export const getFeedPostService = singleton(
	() =>
		new FeedPostService({
			repository: getFeedRepository(),
			followRepository: getFollowRepository(),
			userRepository: getUserRepository(),
			kvCounterService: getKVCounterService(),
			workerService: getWorkerService(),
			snowflakeService: getSnowflakeService(),
			limitConfigService: getLimitConfigService(),
			storageService: getStorageService(),
			mediaService: getMediaService(),
			virusScanService: getVirusScanServiceInstance(),
			attachmentUploadTraceRepository: getAttachmentUploadTraceRepository(),
			purgeQueue: getPurgeQueue(),
			interactionRepository: getFeedInteractionRepository(),
			trendService: getFeedTrendService(),
			videoRepository: getFeedVideoRepository(),
		}),
);
export const getFeedTimelineService = singleton(
	() =>
		new FeedTimelineService({
			repository: getFeedRepository(),
			followRepository: getFollowRepository(),
			userRepository: getUserRepository(),
			userCacheService: getUserCacheService(),
			interactionService: getFeedInteractionService(),
			discoverRepository: getFeedDiscoverRepository(),
			limitConfigService: getLimitConfigService(),
			mediaService: getMediaService(),
			profiles: {getProfileAudience: (targetId) => getProfileAccessService().audienceOf(targetId)},
		}),
);
export const getFeedSuggestionService = singleton(
	() =>
		new FeedSuggestionService({
			repository: new FeedSuggestionRepository(getKVClient()),
			followRepository: getFollowRepository(),
			userRepository: getUserRepository(),
			kvCounterService: getKVCounterService(),
			limitConfigService: getLimitConfigService(),
			discover: getFeedTimelineService().discover,
			guildSearch: getGuildSearchService,
			gatewayService: getGatewayService(),
			workerService: getWorkerService(),
			cache: feedSuggestionCache,
		}),
);
export const getFeedInteractionRepository = singleton(() => new FeedInteractionRepository(getKVClient()));
export const getFeedInteractionService = singleton(
	() =>
		new FeedInteractionService({
			repository: getFeedInteractionRepository(),
			feedRepository: getFeedRepository(),
			kvCounterService: getKVCounterService(),
			workerService: getWorkerService(),
			snowflakeService: getSnowflakeService(),
			userCacheService: getUserCacheService(),
			limitConfigService: getLimitConfigService(),
			notificationService: getFeedNotificationService(),
		}),
);
export const getFeedNotificationRepository = singleton(() => new FeedNotificationRepository());
export const getFeedNotificationService = singleton(
	() =>
		new FeedNotificationService({
			repository: getFeedNotificationRepository(),
			feedRepository: getFeedRepository(),
			feedPostService: getFeedPostService(),
			gatewayService: getGatewayService(),
			kvClient: getKVClient(),
			userCacheService: getUserCacheService(),
			userRepository: getUserRepository(),
			snowflakeService: getSnowflakeService(),
			workerService: getWorkerService(),
		}),
);
export const getBunnyStreamClient = singleton(() => new BunnyStreamClient(Config.bunnyStream));
export const getFeedVideoRepository = singleton(() => new FeedVideoRepository(getKVClient()));
export const getFeedVideoService = singleton(
	() =>
		new FeedVideoService({
			repository: getFeedVideoRepository(),
			client: getBunnyStreamClient(),
			scanner: new FeedVideoScanner({client: getBunnyStreamClient(), media: getMediaService()}),
			settings: () => Config.bunnyStream,
			posts: getFeedPostService(),
			feedRepository: getFeedRepository(),
			worker: deferLongWaits(getWorkerService(), getFeedVideoRepository()),
			snowflake: getSnowflakeService(),
			limits: getLimitConfigService(),
			users: getUserRepository(),
			storage: getStorageService(),
			purgeQueue: getPurgeQueue(),
			notifyAuthor: (authorId, key) =>
				sendFeedAuthorDm({users: getUserRepository(), worker: getWorkerService()}, authorId, key),
		}),
);

// Holds up to a few seconds of views, so it is written out when the singletons shut down, before KV and Cassandra close.
let feedViewService: FeedViewService | null = null;

export function getFeedViewService(): FeedViewService {
	feedViewService ??= new FeedViewService({
		kv: getKVClient(),
		counters: getKVCounterService(),
		enabled: () => getFeedInteractionService().viewsEnabled(),
	});
	return feedViewService;
}

interface ServiceSingletonInitializationOwner {
	stopping: boolean;
	snowflake: SnowflakeServiceHandle;
	limitConfigService: LimitConfigService | null;
}

let serviceSingletonInitializationOwner: ServiceSingletonInitializationOwner | null = null;
let serviceSingletonInitializationPromise: Promise<void> | null = null;
let serviceSingletonShutdownPromise: Promise<void> | null = null;

function assertServiceSingletonInitializationActive(owner: ServiceSingletonInitializationOwner): void {
	if (owner.stopping) {
		throw new Error('Service singleton initialization was stopped');
	}
}

export async function initializeServiceSingletons(): Promise<void> {
	if (serviceSingletonShutdownPromise) {
		throw new Error('Service singletons are shutting down');
	}
	if (!serviceSingletonInitializationPromise) {
		const owner: ServiceSingletonInitializationOwner = {
			stopping: false,
			snowflake: acquireSnowflakeService(),
			limitConfigService: null,
		};
		serviceSingletonInitializationOwner = owner;
		serviceSingletonInitializationPromise = (async () => {
			await owner.snowflake.service.initialize();
			assertServiceSingletonInitializationActive(owner);
			const limitConfigService = getLimitConfigService();
			owner.limitConfigService = limitConfigService;
			await getInstanceConfigRepository().initialize();
			assertServiceSingletonInitializationActive(owner);
			await getInstanceConfigRepository().ensureAccountIdentityMode();
			assertServiceSingletonInitializationActive(owner);
			await ensureSetupToken(
				getInstanceConfigRepository(),
				async (userId) => (await getUserRepository().findUnique(userId)) !== null,
			);
			assertServiceSingletonInitializationActive(owner);
			await limitConfigService.initialize();
			assertServiceSingletonInitializationActive(owner);
			limitConfigService.setAsGlobalInstance();
		})();
	}
	const initialization = serviceSingletonInitializationPromise;
	try {
		await initialization;
	} catch (error) {
		if (serviceSingletonInitializationPromise === initialization) {
			try {
				await shutdownServiceSingletons();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], 'Service singleton initialization and cleanup failed');
			}
		}
		throw error;
	}
}

export async function shutdownServiceSingletons(): Promise<void> {
	const views = feedViewService;
	feedViewService = null;
	// Started, not awaited, so the steps below still read the singletons at once, as upstream does (a test reset clears
	// them right after this call); every way out waits for it, so the views are written before KV and Cassandra close.
	const viewsWritten = Promise.resolve(views?.shutdown()).catch((error) => {
		Logger.error({error}, 'Failed to write the buffered feed views');
	});
	if (serviceSingletonShutdownPromise) {
		await viewsWritten;
		return await serviceSingletonShutdownPromise;
	}
	const initialization = serviceSingletonInitializationPromise;
	const owner = serviceSingletonInitializationOwner;
	const service = owner?.limitConfigService ?? limitConfigServiceInstance;
	if (!initialization && !owner && !service) return await viewsWritten;
	if (owner) owner.stopping = true;
	const shutdown = awaitAll(
		[
			viewsWritten,
			Promise.resolve().then(() => service?.shutdown()),
			(async () => {
				await Promise.allSettled([initialization]);
				if (owner) await releaseSnowflakeService(owner.snowflake);
			})(),
		],
		'Failed to shut down service singletons',
	);
	serviceSingletonShutdownPromise = shutdown;
	try {
		await shutdown;
	} finally {
		if (serviceSingletonInitializationPromise === initialization) {
			serviceSingletonInitializationPromise = null;
		}
		if (serviceSingletonInitializationOwner === owner) {
			serviceSingletonInitializationOwner = null;
		}
		if (serviceSingletonShutdownPromise === shutdown) {
			serviceSingletonShutdownPromise = null;
		}
	}
}

export function resetServiceSingletonsForTesting(): void {
	void shutdownServiceSingletons().catch((error) => {
		Logger.error({error}, 'Failed to reset service singletons');
	});
	activityTracker?.shutdown();
	clearSingletonsForTesting();
	bulkMessageDeletionQueue = null;
	bulkMessageDeletionQueueClient = null;
	premiumStateQueue = null;
	premiumStateQueueClient = null;
	activityTracker = null;
	activityTrackerClient = null;
	activityBuffer = null;
	activityBufferClient = null;
	counterService = null;
	counterServiceClient = null;
	feedViewService = null;
	accountDeletionQueue = null;
	accountDeletionQueueClient = null;
}

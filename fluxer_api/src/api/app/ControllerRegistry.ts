// SPDX-License-Identifier: AGPL-3.0-or-later

import {registerAdminControllers} from '@app/api/admin/controllers/index';
import {AttachmentController} from '@app/api/attachment/AttachmentController';
import {AuthController} from '@app/api/auth/AuthController';
import {OriginHandoffController} from '@app/api/auth/OriginHandoffController';
import {PasskeyBridgeController} from '@app/api/auth/PasskeyBridgeController';
import {registerBadgeProfileExtension} from '@app/api/badge/BadgeProfileProvider';
import {BlueskyOAuthController} from '@app/api/bluesky/BlueskyOAuthController';
import {registerChannelControllers} from '@app/api/channel/controllers/index';
import type {APIConfig} from '@app/api/config/APIConfig';
import {ConnectionController} from '@app/api/connection/ConnectionController';
import {CosmeticController} from '@app/api/cosmetics/CosmeticController';
import {registerCosmeticProfileExtension} from '@app/api/cosmetics/CosmeticProfileProvider';
import {DonationController} from '@app/api/donation/DonationController';
import {DownloadController} from '@app/api/download/DownloadController';
import {ExperimentController} from '@app/api/experiment/ExperimentController';
import {FavoriteGifController} from '@app/api/favorite_gif/FavoriteGifController';
import {FavoriteMemeController} from '@app/api/favorite_meme/FavoriteMemeController';
import {FeedPostController} from '@app/api/feed/FeedPostController';
import {FeedInteractionController} from '@app/api/feed/interaction/FeedInteractionController';
import {FeedReportController} from '@app/api/feed/moderation/FeedReportController';
import {FeedNotificationController} from '@app/api/feed/notification/FeedNotificationController';
import {FeedSuggestionController} from '@app/api/feed/suggest/FeedSuggestionController';
import {FeedVideoController} from '@app/api/feed/video/FeedVideoController';
import {FeedViewController} from '@app/api/feed/views/FeedViewController';
import {FollowController} from '@app/api/follow/FollowController';
import {registerFollowProfileExtension} from '@app/api/follow/FollowProfileProvider';
import {GatewayController} from '@app/api/gateway/GatewayController';
import {GeolocationController} from '@app/api/geolocation/GeolocationController';
import {GifController} from '@app/api/gif/GifController';
import {GuildBoostController} from '@app/api/guild/boost/GuildBoostController';
import {GuildController} from '@app/api/guild/controllers/index';
import {MicupBotController} from '@app/api/guild/micupbot/MicupBotController';
import {GuildRosterController} from '@app/api/guild/roster/GuildRosterController';
import {GuildSoundboardController} from '@app/api/guild/soundboard/GuildSoundboardController';
import {InstanceController} from '@app/api/instance/InstanceController';
import {InviteController} from '@app/api/invite/InviteController';
import {OAuth2ApplicationsController} from '@app/api/oauth/OAuth2ApplicationsController';
import {OAuth2Controller} from '@app/api/oauth/OAuth2Controller';
import {OpenAPIController} from '@app/api/openapi/OpenAPIController';
import {PayriffCallbackController} from '@app/api/payriff/PayriffCallbackController';
import {PremiumController} from '@app/api/premium/PremiumController';
import {ReadStateController} from '@app/api/read_state/ReadStateController';
import {ReferralController} from '@app/api/referral/ReferralController';
import {ReportController} from '@app/api/report/ReportController';
import {InternalRpcController} from '@app/api/rpc/InternalRpcController';
import {SearchController} from '@app/api/search/controllers/SearchController';
import {ShopCatalogController} from '@app/api/shop/ShopCatalogController';
import {ShopCodeController} from '@app/api/shop/ShopCodeController';
import {ShopOrderController} from '@app/api/shop/ShopOrderController';
import {StoreBillingController} from '@app/api/store_billing/StoreBillingController';
import {GiftCodeRoutes, StripeController} from '@app/api/stripe/StripeController';
import {TableGameController} from '@app/api/table_game/TableGameController';
import {TestHarnessController} from '@app/api/test/TestHarnessController';
import {ThemeController} from '@app/api/theme/ThemeController';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {UnfurlController} from '@app/api/unfurl/UnfurlController';
import {UserController} from '@app/api/user/controllers/UserController';
import {registerMicupUserLifecycleHooks} from '@app/api/user/lifecycle/MicupUserLifecycleHooks';
import {VoiceP2pConnectionReportController} from '@app/api/voice/VoiceP2pConnectionReportController';
import {VoiceSeatController} from '@app/api/voice_seat/VoiceSeatController';
import {WebhookController} from '@app/api/webhook/WebhookController';

export function registerControllers(routes: HonoApp, config: APIConfig): void {
	InternalRpcController(routes);
	GatewayController(routes);
	GeolocationController(routes);
	registerAdminControllers(routes);
	AuthController(routes);
	OriginHandoffController(routes);
	PasskeyBridgeController(routes);
	AttachmentController(routes);
	registerChannelControllers(routes);
	ConnectionController(routes);
	BlueskyOAuthController(routes);
	InstanceController(routes);
	OpenAPIController(routes);
	DownloadController(routes);
	ExperimentController(routes);
	FavoriteGifController(routes);
	FavoriteMemeController(routes);
	InviteController(routes);
	ReadStateController(routes);
	ReportController(routes);
	GuildController(routes);
	GuildSoundboardController(routes);
	SearchController(routes);
	GifController(routes);
	ThemeController(routes);
	UnfurlController(routes);
	if (config.dev.testModeEnabled || config.nodeEnv === 'development') {
		TestHarnessController(routes);
	}
	UserController(routes);
	VoiceP2pConnectionReportController(routes);
	StoreBillingController(routes);
	WebhookController(routes);
	OAuth2Controller(routes);
	OAuth2ApplicationsController(routes);
	PremiumController(routes);
	registerMicupControllers(routes);
	if (!config.instance.selfHosted) {
		DonationController(routes);
		StripeController(routes);
	} else {
		GiftCodeRoutes(routes);
	}
}

// Micup features. The admin controllers join registerAdminControllers and its audit coverage cases
// once their handlers write audit logs.
function registerMicupControllers(routes: HonoApp): void {
	CosmeticController(routes);
	GuildBoostController(routes);
	GuildRosterController(routes);
	MicupBotController(routes);
	FollowController(routes);
	FeedPostController(routes);
	FeedInteractionController(routes);
	FeedNotificationController(routes);
	FeedReportController(routes);
	ShopCatalogController(routes);
	ShopOrderController(routes);
	ShopCodeController(routes);
	PayriffCallbackController(routes);
	FeedVideoController(routes);
	FeedViewController(routes);
	FeedSuggestionController(routes);
	ReferralController(routes);
	VoiceSeatController(routes);
	TableGameController(routes);
	registerCosmeticProfileExtension();
	registerBadgeProfileExtension();
	registerFollowProfileExtension();
	registerMicupUserLifecycleHooks();
}

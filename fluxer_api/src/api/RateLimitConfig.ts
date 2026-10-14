// SPDX-License-Identifier: AGPL-3.0-or-later

import {AdminRateLimitConfigs} from '@app/api/rate_limit_configs/AdminRateLimitConfig';
import {AuthRateLimitConfigs} from '@app/api/rate_limit_configs/AuthRateLimitConfig';
import {BadgeRateLimitConfigs} from '@app/api/rate_limit_configs/BadgeRateLimitConfig';
import {ChannelRateLimitConfigs} from '@app/api/rate_limit_configs/ChannelRateLimitConfig';
import {CosmeticRateLimitConfigs} from '@app/api/rate_limit_configs/CosmeticRateLimitConfig';
import {DiscoveryRateLimitConfigs} from '@app/api/rate_limit_configs/DiscoveryRateLimitConfig';
import {DonationRateLimitConfigs} from '@app/api/rate_limit_configs/DonationRateLimitConfig';
import {FeedRateLimitConfigs} from '@app/api/rate_limit_configs/FeedRateLimitConfig';
import {FollowRateLimitConfigs} from '@app/api/rate_limit_configs/FollowRateLimitConfig';
import {GuildBoostRateLimitConfigs} from '@app/api/rate_limit_configs/GuildBoostRateLimitConfig';
import {GuildRateLimitConfigs} from '@app/api/rate_limit_configs/GuildRateLimitConfig';
import {GuildRosterRateLimitConfigs} from '@app/api/rate_limit_configs/GuildRosterRateLimitConfig';
import {IntegrationRateLimitConfigs} from '@app/api/rate_limit_configs/IntegrationRateLimitConfig';
import {InviteRateLimitConfigs} from '@app/api/rate_limit_configs/InviteRateLimitConfig';
import {MessageComponentRateLimitConfigs} from '@app/api/rate_limit_configs/MessageComponentRateLimitConfig';
import {MicupBotRateLimitConfigs} from '@app/api/rate_limit_configs/MicupBotRateLimitConfig';
import {MiscRateLimitConfigs} from '@app/api/rate_limit_configs/MiscRateLimitConfig';
import {OAuthRateLimitConfigs} from '@app/api/rate_limit_configs/OAuthRateLimitConfig';
import {PremiumTrialRateLimitConfigs} from '@app/api/rate_limit_configs/PremiumTrialRateLimitConfig';
import type {RateLimitSection} from '@app/api/rate_limit_configs/RateLimitHelpers';
import {mergeRateLimitSections} from '@app/api/rate_limit_configs/RateLimitHelpers';
import {ReferralRateLimitConfigs} from '@app/api/rate_limit_configs/ReferralRateLimitConfig';
import {ShopRateLimitConfigs} from '@app/api/rate_limit_configs/ShopRateLimitConfig';
import {StoreBillingRateLimitConfigs} from '@app/api/rate_limit_configs/StoreBillingRateLimitConfig';
import {UserRateLimitConfigs} from '@app/api/rate_limit_configs/UserRateLimitConfig';
import {VoiceRoomRateLimitConfigs} from '@app/api/rate_limit_configs/VoiceRoomRateLimitConfig';
import {WebhookRateLimitConfigs} from '@app/api/rate_limit_configs/WebhookRateLimitConfig';

const rateLimitSections = [
	AuthRateLimitConfigs,
	OAuthRateLimitConfigs,
	UserRateLimitConfigs,
	ChannelRateLimitConfigs,
	DiscoveryRateLimitConfigs,
	DonationRateLimitConfigs,
	GuildRateLimitConfigs,
	InviteRateLimitConfigs,
	WebhookRateLimitConfigs,
	IntegrationRateLimitConfigs,
	StoreBillingRateLimitConfigs,
	AdminRateLimitConfigs,
	MiscRateLimitConfigs,
	PremiumTrialRateLimitConfigs,
	FollowRateLimitConfigs,
	BadgeRateLimitConfigs,
	FeedRateLimitConfigs,
	CosmeticRateLimitConfigs,
	GuildBoostRateLimitConfigs,
	GuildRosterRateLimitConfigs,
	MicupBotRateLimitConfigs,
	MessageComponentRateLimitConfigs,
	ShopRateLimitConfigs,
	ReferralRateLimitConfigs,
	VoiceRoomRateLimitConfigs,
] satisfies ReadonlyArray<RateLimitSection>;
export const RateLimitConfigs = mergeRateLimitSections(...rateLimitSections);

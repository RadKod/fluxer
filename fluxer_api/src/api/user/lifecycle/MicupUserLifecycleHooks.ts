// SPDX-License-Identifier: AGPL-3.0-or-later

import {registerBadgeUserLifecycleHooks} from '@app/api/badge/BadgeUserLifecycleHooks';
import {registerCosmeticUserLifecycleHooks} from '@app/api/cosmetics/CosmeticUserLifecycleHooks';
import {registerFeedUserLifecycleHooks} from '@app/api/feed/FeedUserLifecycleHooks';
import {registerFollowUserLifecycleHooks} from '@app/api/follow/FollowUserLifecycleHooks';
import {registerGuildBoostUserLifecycleHooks} from '@app/api/guild/boost/GuildBoostUserLifecycleHooks';
import {registerMicupBotUserLifecycleHooks} from '@app/api/guild/micupbot/MicupBotUserLifecycleHooks';
import {registerReferralUserLifecycleHooks} from '@app/api/referral/ReferralUserLifecycleHooks';
import {registerShopUserLifecycleHooks} from '@app/api/shop/ShopUserLifecycleHooks';
import {registerProfileUserLifecycleHooks} from '@app/api/user/profile/ProfileUserLifecycleHooks';

// Micup: account deletion and the data export run in the worker, blocking runs in the API, so ControllerRegistry and
// WorkerMain both call this; registering a hook name twice keeps one hook.
export function registerMicupUserLifecycleHooks(): void {
	registerCosmeticUserLifecycleHooks();
	registerBadgeUserLifecycleHooks();
	registerGuildBoostUserLifecycleHooks();
	registerFollowUserLifecycleHooks();
	registerFeedUserLifecycleHooks();
	registerShopUserLifecycleHooks();
	registerReferralUserLifecycleHooks();
	registerMicupBotUserLifecycleHooks();
	registerProfileUserLifecycleHooks();
}

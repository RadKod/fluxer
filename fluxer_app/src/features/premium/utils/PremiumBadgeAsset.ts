// SPDX-License-Identifier: AGPL-3.0-or-later

import crownUrl from '@app/media/images/micup-premium-badge.png';

// Micup: the premium badge icon of the premium and shop pages is the crown next to the name (PremiumUserBadge), bundled
// with the app. PremiumBadgeAsset.test.ts fails if the crown moves to another file without this one.
export const premiumBadgeUrl = (): string => crownUrl;

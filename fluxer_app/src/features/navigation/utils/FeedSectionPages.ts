// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';

// Micup: premium, the shop and the bots are pages of both the DM list and the feed sidebar. Opened while the feed is
// shown they open beside the feed (Routes.FEED_PREMIUM…), from anywhere else beside the DM list, so a link inside
// one of them (premium to the shop, a shop set) keeps the sidebar it was opened from.
const FEED_SECTION_PAGES = new Map<string, string>([
	[Routes.PREMIUM, Routes.FEED_PREMIUM],
	[Routes.SHOP, Routes.FEED_SHOP],
	[Routes.BOTS, Routes.FEED_BOTS],
]);

export function resolveSectionPagePath(path: string, currentPathname: string): string {
	if (!Routes.isFeedRoute(currentPathname)) return path;
	const end = path.search(/[?#]/);
	const pathname = end < 0 ? path : path.slice(0, end);
	const feedPathname = FEED_SECTION_PAGES.get(pathname);
	return feedPathname ? feedPathname + path.slice(pathname.length) : path;
}

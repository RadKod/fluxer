// SPDX-License-Identifier: AGPL-3.0-or-later

// Google Analytics sees the route template (`/channels/:guildId/:channelId`), never the real path: ids, invite
// and gift codes, SSO codes and `#token=` links stay on the device. Only campaign parameters survive.
const CAMPAIGN_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id'] as const;
const MAX_CAMPAIGN_VALUE_LENGTH = 100;
const UNKNOWN_PATH = '/__unknown';

export interface AnalyticsPage {
	path: string;
	location: string;
	title: string;
}

interface AnalyticsRouteState {
	location: URL;
	matches: ReadonlyArray<{route: {id: string; path?: string}}>;
}

export function analyticsPage({location, matches}: AnalyticsRouteState): AnalyticsPage {
	const route = matches[matches.length - 1]?.route;
	const path = route?.path ?? UNKNOWN_PATH;
	const url = new URL(path, location.origin);
	for (const key of CAMPAIGN_PARAMS) {
		const value = location.searchParams.get(key);
		if (value) url.searchParams.set(key, value.slice(0, MAX_CAMPAIGN_VALUE_LENGTH));
	}
	return {path, location: url.href, title: route?.id ?? 'unknown'};
}

export function analyticsReferrer(referrer: string): string {
	try {
		const origin = new URL(referrer).origin;
		return origin === 'null' ? '' : origin;
	} catch {
		return '';
	}
}

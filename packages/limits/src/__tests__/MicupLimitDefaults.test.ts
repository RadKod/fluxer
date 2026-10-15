// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	LIMIT_KEY_METADATA,
	LIMIT_KEY_SCOPES,
	LIMIT_KEYS,
	type LimitKey,
} from '@fluxer/constants/src/LimitConfigMetadata';
import {DEFAULT_FREE_LIMITS, DEFAULT_PREMIUM_LIMITS} from '@fluxer/limits/src/LimitDefaults';
import {describe, expect, test} from 'vitest';

const MICUP_KEYS = [
	'feature_feed',
	'feature_feed_discover',
	'feature_feed_discover_media',
	'feature_feed_discover_video',
	'feature_feed_reply_notifications',
	'feature_feed_suggestions',
	'feature_feed_video',
	'feature_feed_views',
	'feature_guild_roster',
	'feature_mature_content_settings',
	'feature_micupbot',
	'feature_name_style',
	'feature_profile_theme',
	'feed_fanout_max_followers',
	'feed_fanout_max_posts_per_day',
	'feed_fanout_min_followers',
	'feed_suggestions_min_followers',
	'max_boost_slots',
	'max_comments_per_post',
	'max_feed_posts_per_day',
	'max_following',
] as const satisfies ReadonlyArray<LimitKey>;

function pick(limits: Record<LimitKey, number>): Record<string, number> {
	return Object.fromEntries(MICUP_KEYS.map((key) => [key, limits[key]]));
}

describe('sanalyer limit keys', () => {
	test('registers every key with user scope metadata', () => {
		for (const key of MICUP_KEYS) {
			expect(LIMIT_KEYS).toContain(key);
			expect(LIMIT_KEY_SCOPES[key]).toBe('user');
			expect(LIMIT_KEY_METADATA[key].key).toBe(key);
		}
	});

	test('keeps the suggestion follower floor at least 1 in its metadata', () => {
		expect(LIMIT_KEY_METADATA.feed_suggestions_min_followers).toMatchObject({min: 1});
	});

	test('free accounts get the feed and following caps but no boost slots', () => {
		expect(pick(DEFAULT_FREE_LIMITS)).toEqual({
			feature_feed: 1,
			feature_feed_discover: 1,
			feature_feed_discover_media: 0,
			feature_feed_discover_video: 0,
			feature_feed_reply_notifications: 0,
			feature_feed_suggestions: 0,
			feature_feed_video: 0,
			feature_feed_views: 0,
			feature_guild_roster: 0,
			feature_mature_content_settings: 0,
			feature_micupbot: 0,
			feature_name_style: 0,
			feature_profile_theme: 0,
			feed_fanout_max_followers: 10_000,
			feed_fanout_max_posts_per_day: 10,
			feed_fanout_min_followers: 8000,
			feed_suggestions_min_followers: 2,
			max_boost_slots: 0,
			max_comments_per_post: 10_000,
			max_feed_posts_per_day: 50,
			max_following: 2000,
		});
	});

	test('premium accounts get two boost slots and the same feed caps', () => {
		expect(pick(DEFAULT_PREMIUM_LIMITS)).toEqual({
			feature_feed: 1,
			feature_feed_discover: 1,
			feature_feed_discover_media: 0,
			feature_feed_discover_video: 0,
			feature_feed_reply_notifications: 0,
			feature_feed_suggestions: 0,
			feature_feed_video: 0,
			feature_feed_views: 0,
			feature_guild_roster: 0,
			feature_mature_content_settings: 0,
			feature_micupbot: 0,
			feature_name_style: 1,
			feature_profile_theme: 1,
			feed_fanout_max_followers: 10_000,
			feed_fanout_max_posts_per_day: 10,
			feed_fanout_min_followers: 8000,
			feed_suggestions_min_followers: 2,
			max_boost_slots: 2,
			max_comments_per_post: 10_000,
			max_feed_posts_per_day: 50,
			max_following: 2000,
		});
	});
});

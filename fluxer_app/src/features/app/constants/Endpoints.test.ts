// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {Endpoints} from '@app/features/app/constants/Endpoints';
import {describe, expect, it} from 'vitest';

const spec = JSON.parse(
	readFileSync(new URL('../../../../../fluxer_api/src/api/openapi/openapi.json', import.meta.url), 'utf8'),
) as {paths: Record<string, unknown>};
const withoutParamNames = (path: string) => path.replace(/\{[^}]+\}/g, '{}');
const apiPaths = new Set(Object.keys(spec.paths).map(withoutParamNames));
const P = '{}';

describe('sanalyer endpoints', () => {
	it('builds guild-scoped community bot endpoints', () => {
		expect(Endpoints.GUILD_MICUPBOT_SETTINGS('123')).toBe('/guilds/123/micupbot/settings');
		expect(Endpoints.GUILD_MICUPBOT_AUTOMOD('123')).toBe('/guilds/123/micupbot/automod');
		expect(Endpoints.GUILD_MICUPBOT_REACTION_ROLES('123')).toBe('/guilds/123/micupbot/reaction-roles');
		expect(Endpoints.GUILD_MICUPBOT_REACTION_ROLE('123', '456')).toBe('/guilds/123/micupbot/reaction-roles/456');
		expect(Endpoints.GUILD_MICUPBOT_LEVEL_REWARDS('123')).toBe('/guilds/123/micupbot/level-rewards');
		expect(Endpoints.GUILD_MICUPBOT_LEADERBOARD('123')).toBe('/guilds/123/micupbot/leaderboard');
		expect(Endpoints.GUILD_MICUPBOT_WARNINGS('123', '456')).toBe('/guilds/123/micupbot/warnings/456');
		expect(Endpoints.GUILD_MICUPBOT_WARNING('123', '456', '789')).toBe('/guilds/123/micupbot/warnings/456/789');
	});
	it('builds guild-scoped roster event endpoints', () => {
		expect(Endpoints.GUILD_ROSTER_EVENTS('123')).toBe('/guilds/123/roster-events');
		expect(Endpoints.GUILD_ROSTER_EVENT('123', '456')).toBe('/guilds/123/roster-events/456');
	});
	it('builds the message button click endpoint', () => {
		expect(Endpoints.CHANNEL_MESSAGE_COMPONENTS('123', '456')).toBe('/channels/123/messages/456/components');
	});
	it('name only routes the API serves', () => {
		const endpoints = [
			Endpoints.COSMETICS_CATALOG,
			Endpoints.USER_COSMETICS,
			Endpoints.USER_COSMETICS_EQUIPPED,
			Endpoints.GUILD_BOOSTS(P),
			Endpoints.GUILD_BOOST(P, P),
			Endpoints.USER_BOOST_SLOTS,
			Endpoints.USER_FOLLOW(P),
			Endpoints.USER_FOLLOWERS(P),
			Endpoints.USER_FOLLOWING(P),
			Endpoints.USER_FOLLOWER(P),
			Endpoints.USER_FEED_POSTS(P),
			Endpoints.FEED_ATTACHMENTS,
			Endpoints.FEED_POSTS,
			Endpoints.FEED_POST(P),
			Endpoints.FEED_HOME,
			Endpoints.FEED_POST_LIKE(P),
			Endpoints.FEED_POST_LIKES(P),
			Endpoints.FEED_POST_COMMENTS(P),
			Endpoints.FEED_POST_COMMENT(P, P),
			Endpoints.FEED_NOTIFICATIONS,
			Endpoints.REPORT_FEED_POST,
			Endpoints.REPORT_FEED_COMMENT,
			Endpoints.PREMIUM_TRIAL,
			Endpoints.USER_REFERRAL,
			Endpoints.CHANNEL_MESSAGE_COMPONENTS(P, P),
			Endpoints.CHANNEL_VOICE_SEAT(P),
			Endpoints.CHANNEL_TABLE_GAMES(P),
			Endpoints.CHANNEL_TABLE_GAME(P, P),
			Endpoints.CHANNEL_TABLE_GAME_PLAYERS_ME(P, P),
			Endpoints.CHANNEL_TABLE_GAME_ACTIONS(P, P),
			Endpoints.CHANNEL_TABLE_GAME_SPECTATORS_ME(P, P),
		];
		expect(endpoints.filter((endpoint) => !apiPaths.has(endpoint))).toEqual([]);
	});
});

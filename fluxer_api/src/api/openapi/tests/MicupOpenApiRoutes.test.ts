// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

// The Micup HTTP contract shared by feature routes.
const PUBLIC_OPERATIONS = [
	'get /guilds/{guild_id}/micupbot/settings',
	'patch /guilds/{guild_id}/micupbot/settings',
	'get /guilds/{guild_id}/micupbot/automod',
	'put /guilds/{guild_id}/micupbot/automod',
	'get /guilds/{guild_id}/micupbot/reaction-roles',
	'post /guilds/{guild_id}/micupbot/reaction-roles',
	'delete /guilds/{guild_id}/micupbot/reaction-roles/{message_id}',
	'get /guilds/{guild_id}/micupbot/level-rewards',
	'put /guilds/{guild_id}/micupbot/level-rewards',
	'get /guilds/{guild_id}/micupbot/leaderboard',
	'get /guilds/{guild_id}/micupbot/warnings/{user_id}',
	'delete /guilds/{guild_id}/micupbot/warnings/{user_id}',
	'delete /guilds/{guild_id}/micupbot/warnings/{user_id}/{warning_id}',

	'get /guilds/{guild_id}/roster-events',
	'post /guilds/{guild_id}/roster-events',
	'patch /guilds/{guild_id}/roster-events/{event_id}',
	'delete /guilds/{guild_id}/roster-events/{event_id}',
	'get /cosmetics/catalog',
	'get /users/@me/cosmetics',
	'put /users/@me/cosmetics/equipped',
	'get /guilds/{guild_id}/boosts',
	'put /guilds/{guild_id}/boosts',
	'delete /guilds/{guild_id}/boosts/{boost_id}',
	'get /users/@me/boost-slots',
	'put /users/{user_id}/follow',
	'delete /users/{user_id}/follow',
	'get /users/{user_id}/followers',
	'get /users/{user_id}/following',
	'delete /users/@me/followers/{user_id}',
	'post /feed/attachments',
	'post /feed/posts',
	'get /feed/posts/{post_id}',
	'delete /feed/posts/{post_id}',
	'get /feed/home',
	'get /feed/discover',
	'get /feed/suggestions',
	'get /users/{user_id}/posts',
	'put /feed/posts/{post_id}/like',
	'delete /feed/posts/{post_id}/like',
	'put /feed/posts/{post_id}/poll/vote',
	'get /feed/posts/{post_id}/likes',
	'get /feed/posts/{post_id}/comments',
	'post /feed/posts/{post_id}/comments',
	'delete /feed/posts/{post_id}/comments/{comment_id}',
	'get /feed/notifications',
	'post /feed/notifications/ack',
	'post /feed/videos',
	'get /feed/videos',
	'post /feed/videos/{video_id}/signature',
	'delete /feed/videos/{video_id}',
	'post /feed/videos/webhook',
	'get /feed/posts/{post_id}/comments/{comment_id}/replies',
	'post /feed/posts/{post_id}/comments/{comment_id}/replies',
	'delete /feed/posts/{post_id}/comments/{comment_id}/replies/{reply_id}',
	'post /feed/views',
	'post /reports/feed-post',
	'post /reports/feed-comment',
	'get /shop/catalog',
	'get /shop/quote',
	'post /shop/orders',
	'get /shop/orders/{order_id}',
	'get /shop/codes/{code}',
	'get /payriff/callback/{order_id}/{token}',
	'post /payriff/callback/{order_id}/{token}',
	'get /cosmetics/items',
	'get /users/@me/referral',
	'post /channels/{channel_id}/messages/{message_id}/components',
	'put /channels/{channel_id}/voice-seat',
	'get /channels/{channel_id}/table-games',
	'get /channels/{channel_id}/table-games/{slot}',
	'post /channels/{channel_id}/table-games/{slot}',
	'put /channels/{channel_id}/table-games/{slot}/players/@me',
	'delete /channels/{channel_id}/table-games/{slot}/players/@me',
	'post /channels/{channel_id}/table-games/{slot}/actions',
	'put /channels/{channel_id}/table-games/{slot}/spectators/@me',
	'delete /channels/{channel_id}/table-games/{slot}/spectators/@me',
];

const ADMIN_OPERATIONS = [
	'post /admin/cosmetics/items',
	'patch /admin/cosmetics/items/{item_id}',
	'delete /admin/cosmetics/items/{item_id}',
	'get /admin/badges',
	'post /admin/badges',
	'patch /admin/badges/{badge_id}',
	'post /admin/users/{user_id}/badges/{badge_id}',
	'delete /admin/users/{user_id}/badges/{badge_id}',
	'delete /admin/feed/posts/{post_id}',
	'delete /admin/feed/posts/{post_id}/discover-hide',
	'delete /admin/feed/posts/{post_id}/comments/{comment_id}',
	'delete /admin/feed/posts/{post_id}/comments/{comment_id}/replies/{reply_id}',
	'get /admin/shop',
	'patch /admin/shop/settings',
	'put /admin/shop/prices',
	'post /admin/shop/campaigns',
	'post /admin/shop/campaigns/remove',
	'post /admin/shop/bundles',
	'patch /admin/shop/bundles/{bundle_id}',
	'delete /admin/shop/bundles/{bundle_id}',
	'get /admin/shop/orders/{order_id}',
	'post /admin/users/{user_id}/cosmetics/{item_id}',
	'delete /admin/users/{user_id}/cosmetics/{item_id}',
	'post /admin/gift-codes/cosmetic',
	'post /admin/users/{user_id}/premium/end',
	'get /admin/shop/visionary',
	'put /admin/shop/visionary/slots',
	'post /admin/users/{user_id}/visionary',
	'delete /admin/users/{user_id}/visionary',
	'get /admin/referral',
	'patch /admin/referral/settings',
	'post /admin/referral/tiers',
	'patch /admin/referral/tiers/{tier_id}',
	'get /admin/referral/pending-rewards',
	'get /admin/users/{user_id}/referrals',
	'post /admin/users/{user_id}/referral-rewards/{tier_id}/deliver',
	'post /admin/users/{user_id}/referral-rewards/{tier_id}/notify',
];

function missingOperations(specPath: string, operations: ReadonlyArray<string>): Array<string> {
	const spec = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, specPath), 'utf8')) as {
		paths: Record<string, Record<string, unknown>>;
	};
	return operations.filter((operation) => {
		const [method, route] = operation.split(' ');
		return spec.paths[route]?.[method] === undefined;
	});
}

describe('Micup routes in the OpenAPI specs', () => {
	it('lists every public Micup operation in openapi.json', () => {
		expect(missingOperations('fluxer_api/src/api/openapi/openapi.json', PUBLIC_OPERATIONS)).toEqual([]);
	});

	it('lists every admin Micup operation in openapi-admin.json', () => {
		expect(missingOperations('fluxer_admin/openapi-admin.json', ADMIN_OPERATIONS)).toEqual([]);
	});
});

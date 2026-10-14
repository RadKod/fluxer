// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as BadgeTables from '@app/api/badge/BadgeTables';
import * as CosmeticTables from '@app/api/cosmetics/CosmeticTables';
import {CHANNEL_COLUMNS} from '@app/api/database/types/ChannelTypes';
import {COSMETIC_ITEM_BY_TYPE_COLUMNS, COSMETIC_ITEM_COLUMNS} from '@app/api/database/types/CosmeticTypes';
import {
	FEED_COMMENT_BY_AUTHOR_COLUMNS,
	FEED_COMMENT_COLUMNS,
	FEED_COMMENT_REPLY_BUCKET_COLUMNS,
	FEED_COMMENT_REPLY_COLUMNS,
	FEED_POST_COLUMNS,
	FEED_VIDEO_BY_AUTHOR_COLUMNS,
	FEED_VIDEO_COLUMNS,
	FEED_VIDEO_PENDING_COLUMNS,
} from '@app/api/database/types/FeedTypes';
import {GUILD_COLUMNS} from '@app/api/database/types/GuildTypes';
import {MESSAGE_COLUMNS} from '@app/api/database/types/MessageTypes';
import {GIFT_CODE_COLUMNS, VISIONARY_SLOT_COLUMNS} from '@app/api/database/types/PaymentTypes';
import {SHOP_BUNDLE_COLUMNS, SHOP_ORDER_COLUMNS} from '@app/api/database/types/ShopTypes';
import {USER_COLUMNS} from '@app/api/database/types/UserTypes';
import * as FeedTables from '@app/api/feed/FeedTables';
import * as FollowTables from '@app/api/follow/FollowTables';
import * as GuildBoostTables from '@app/api/guild/boost/GuildBoostTables';
import * as MicupBotTables from '@app/api/guild/micupbot/MicupBotTables';
import * as GuildRosterTables from '@app/api/guild/roster/GuildRosterTables';
import * as PremiumLedgerTables from '@app/api/premium/ledger/PremiumLedgerTables';
import * as PremiumTrialTables from '@app/api/premium/trial/PremiumTrialTables';
import * as ReferralTables from '@app/api/referral/ReferralTables';
import * as ShopTables from '@app/api/shop/ShopTables';
import {describe, expect, it} from 'vitest';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '../../../..');

interface SchemaColumn {
	name: string;
	type: string;
}

interface SchemaTable {
	name: string;
	columns: Array<SchemaColumn>;
	primary_key: string;
	options: string;
}

const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tools/dev/cassandra_target_schema.json'), 'utf8')) as {
	tables: Array<SchemaTable>;
	user_types: Array<{name: string; fields: Array<SchemaColumn>}>;
	indexes?: Array<{name: string}>;
};

const TWCS_ONE_DAY =
	"compaction = {'class': 'TimeWindowCompactionStrategy', 'compaction_window_unit': 'DAYS', 'compaction_window_size': '1'}";
// 90-day TTL: 3-day windows keep the table at ~30 windows, like Fluxer's own 90-day tables.
const TWCS_THREE_DAYS =
	"compaction = {'class': 'TimeWindowCompactionStrategy', 'compaction_window_unit': 'DAYS', 'compaction_window_size': '3'}";

// fluxer-dev compares only columns with the live schema, so a key, clustering order, TTL or compaction change in the
// target JSON never reaches a table that exists. These are pinned: a table that already holds data needs a new name.
const MICUP_TABLES: Record<string, {primaryKey: string; options: string}> = {
	badge_catalog: {primaryKey: '((catalog), badge_id)', options: ''},
	badges: {primaryKey: '((badge_id))', options: ''},
	cosmetic_grants: {primaryKey: '((user_id), grant_key)', options: ''},
	cosmetic_items: {primaryKey: '((item_id))', options: ''},
	cosmetic_items_by_type: {primaryKey: '((item_type), item_id)', options: ''},
	feed_author_buckets: {primaryKey: '((author_id), bucket)', options: 'CLUSTERING ORDER BY (bucket DESC)'},
	feed_comment_buckets: {primaryKey: '((post_id), bucket)', options: 'CLUSTERING ORDER BY (bucket DESC)'},
	feed_comment_replies: {
		primaryKey: '((post_id, comment_id, bucket), reply_id)',
		options: 'CLUSTERING ORDER BY (reply_id DESC)',
	},
	feed_comment_reply_buckets: {
		primaryKey: '((post_id), comment_id, bucket)',
		options: 'CLUSTERING ORDER BY (comment_id DESC, bucket DESC)',
	},
	feed_comments: {primaryKey: '((post_id, bucket), comment_id)', options: 'CLUSTERING ORDER BY (comment_id DESC)'},
	feed_comments_by_author: {
		primaryKey: '((author_id, bucket), comment_id)',
		options: 'CLUSTERING ORDER BY (comment_id DESC)',
	},
	feed_home: {
		primaryKey: '((user_id, day), post_id)',
		// Nothing ever deletes from feed_home (deleted and blocked posts are filtered on read), so a one day gc grace
		// cannot resurrect a row; with ten days the 30 day TTL table would keep 40 days on disk.
		options: `CLUSTERING ORDER BY (post_id DESC) AND default_time_to_live = 2592000 AND gc_grace_seconds = 86400 AND ${TWCS_ONE_DAY}`,
	},
	feed_likes_by_user: {primaryKey: '((user_id, day), post_id)', options: 'CLUSTERING ORDER BY (post_id DESC)'},
	// One read cursor per account, rewritten on every mark-read; the TTL drops the cursors of accounts that stopped reading.
	feed_notification_read_states: {primaryKey: '((user_id))', options: 'default_time_to_live = 7776000'},
	feed_notifications: {
		primaryKey: '((user_id, bucket), notification_id)',
		options: `CLUSTERING ORDER BY (notification_id DESC) AND default_time_to_live = 7776000 AND gc_grace_seconds = 864000 AND ${TWCS_THREE_DAYS}`,
	},
	feed_poll_votes: {primaryKey: '((post_id, shard), user_id)', options: ''},
	feed_poll_votes_by_user: {primaryKey: '((user_id, day), post_id)', options: 'CLUSTERING ORDER BY (post_id DESC)'},
	feed_post_likes: {primaryKey: '((post_id, shard), user_id)', options: ''},
	feed_posts: {primaryKey: '((post_id))', options: ''},
	feed_posts_by_author: {primaryKey: '((author_id, bucket), post_id)', options: 'CLUSTERING ORDER BY (post_id DESC)'},
	// No TTL: a published video's row lives as long as its post, so a late Bunny webhook still finds it.
	feed_videos: {primaryKey: '((video_guid))', options: ''},
	feed_videos_by_author: {primaryKey: '((author_id), created_id)', options: 'CLUSTERING ORDER BY (created_id DESC)'},
	feed_videos_pending: {
		primaryKey: '((hour, shard), video_guid)',
		options: `default_time_to_live = 345600 AND gc_grace_seconds = 86400 AND ${TWCS_ONE_DAY}`,
	},
	guild_boost_state: {primaryKey: '((guild_id))', options: ''},
	guild_boosts: {primaryKey: '((guild_id), boost_id)', options: ''},
	guild_entitlement_expirations: {primaryKey: '((day, shard), guild_id, entitlement_id)', options: ''},
	guild_packages: {primaryKey: '((guild_id), package_id)', options: ''},
	guild_roster_events: {primaryKey: '((guild_id), event_id)', options: ''},
	guild_roster_events_by_slot: {primaryKey: '((slot), guild_id, event_id)', options: ''},
	micupbot_guild_settings: {primaryKey: '((guild_id))', options: ''},
	micupbot_automod_rules: {primaryKey: '((guild_id), rule)', options: ''},
	micupbot_reaction_role_panels: {primaryKey: '((guild_id), message_id)', options: ''},
	micupbot_level_rewards: {primaryKey: '((guild_id), level)', options: ''},
	micupbot_member_levels: {primaryKey: '((guild_id, bucket), user_id)', options: ''},
	micupbot_warnings: {
		primaryKey: '((guild_id, user_id), warning_id)',
		options: 'CLUSTERING ORDER BY (warning_id DESC)',
	},
	micupbot_voice_guilds_by_slot: {primaryKey: '((slot), guild_id)', options: ''},
	micupbot_user_guilds: {primaryKey: '((user_id), guild_id)', options: ''},
	pioneer_by_user: {primaryKey: '((user_id))', options: ''},
	pioneer_slots: {primaryKey: '((slot))', options: ''},
	pioneer_state: {primaryKey: '((id))', options: ''},
	premium_expirations_by_day: {primaryKey: '((day, shard), user_id)', options: ''},
	premium_grant_keys: {primaryKey: '((user_id), grant_key)', options: ''},
	premium_ledger: {primaryKey: '((user_id))', options: ''},
	premium_trials_by_email: {primaryKey: '((email_hash))', options: ''},
	referral_buckets_by_referrer: {primaryKey: '((referrer_id), bucket)', options: 'CLUSTERING ORDER BY (bucket DESC)'},
	// Like shop_order_checks: rows are deleted once evaluated and carry a row TTL as a floor; a resurrected row only
	// re-evaluates a referral, which is idempotent.
	referral_checks: {
		primaryKey: '((slot, shard), referee_id)',
		options: `gc_grace_seconds = 86400 AND ${TWCS_ONE_DAY}`,
	},
	referral_codes: {primaryKey: '((code))', options: ''},
	referral_pending_rewards: {primaryKey: '((month), created_at, user_id, tier_id)', options: ''},
	referral_rewards: {primaryKey: '((user_id), tier_id)', options: ''},
	referral_stats: {primaryKey: '((user_id))', options: ''},
	referrals_by_referrer: {
		primaryKey: '((referrer_id, bucket), referee_id)',
		options: 'CLUSTERING ORDER BY (referee_id DESC)',
	},
	referrers_by_band: {primaryKey: '((band, shard), user_id)', options: ''},
	shop_bundles: {primaryKey: '((catalog), bundle_id)', options: ''},
	// Rows are deleted once checked and carry a 7 day row TTL as a floor; a resurrected row only re-checks an order,
	// which is idempotent, so one day of gc grace is enough.
	shop_order_checks: {primaryKey: '((slot, shard), order_id)', options: `gc_grace_seconds = 86400 AND ${TWCS_ONE_DAY}`},
	shop_orders: {primaryKey: '((order_id))', options: ''},
	shop_orders_by_user: {primaryKey: '((user_id), order_id)', options: 'CLUSTERING ORDER BY (order_id DESC)'},
	shop_prices: {primaryKey: '((catalog), sku)', options: ''},
	user_badges: {primaryKey: '((user_id), badge_id)', options: ''},
	user_boost_slots: {primaryKey: '((user_id), slot_id)', options: ''},
	user_cosmetics: {primaryKey: '((user_id), item_id)', options: ''},
	user_follow_stats: {primaryKey: '((user_id))', options: ''},
	user_follower_buckets: {primaryKey: '((target_id), bucket)', options: 'CLUSTERING ORDER BY (bucket DESC)'},
	user_followers: {primaryKey: '((target_id, bucket), follow_id)', options: 'CLUSTERING ORDER BY (follow_id DESC)'},
	user_following: {primaryKey: '((user_id), target_id)', options: ''},
	user_referral: {primaryKey: '((user_id))', options: ''},
};

const MICUP_CORE_COLUMNS: Record<string, {columns: ReadonlyArray<string>; types: Record<string, string>}> = {
	users: {
		columns: USER_COLUMNS,
		types: {
			avatar_decoration_id: 'bigint',
			avatar_ultra_id: 'bigint',
			profile_effect_id: 'bigint',
			nameplate_id: 'bigint',
			avatar_decoration_asset: 'text',
			avatar_ultra_asset: 'text',
			profile_effect_asset: 'text',
			nameplate_asset: 'text',
		},
	},
	guilds: {
		columns: GUILD_COLUMNS,
		types: {premium_tier: 'int', premium_subscription_count: 'int'},
	},
	// 3D room view theme of a voice channel ; additive column, null when the channel has none.
	channels: {columns: CHANNEL_COLUMNS, types: {room_theme: 'text'}},
	// The KV counters flush their base values into the post row, so a page of posts needs no second read.
	feed_posts: {
		columns: FEED_POST_COLUMNS,
		types: {
			like_count: 'int',
			comment_count: 'int',
			poll_options: 'frozen<list<text>>',
			poll_expires_at: 'timestamp',
			poll_vote_count_0: 'int',
			poll_vote_count_1: 'int',
			poll_vote_count_2: 'int',
			poll_vote_count_3: 'int',
			embeds: 'frozen<list<message_embed>>',
			view_count: 'bigint',
		},
	},
	// Ultra decorations: sizes per surface and the in-front parts (angel-wings) live on the catalog row, never on users.
	cosmetic_items: {
		columns: COSMETIC_ITEM_COLUMNS,
		types: {ultra_layout: 'map<text, int>', ultra_front: 'map<text, text>'},
	},
	cosmetic_items_by_type: {
		columns: COSMETIC_ITEM_BY_TYPE_COLUMNS,
		types: {ultra_layout: 'map<text, int>', ultra_front: 'map<text, text>'},
	},
	// Item codes (shop, 3.4) carry the cosmetic they give instead of a premium duration.
	gift_codes: {columns: GIFT_CODE_COLUMNS, types: {cosmetic_item_id: 'bigint'}},
	// Visionary numbers are held and taken with CAS on version.
	visionary_slots: {
		columns: VISIONARY_SLOT_COLUMNS,
		types: {version: 'int', order_id: 'bigint', held_until: 'timestamp'},
	},
	// Bundle item lists are always written whole: a frozen list leaves no collection tombstones.
	shop_bundles: {columns: SHOP_BUNDLE_COLUMNS, types: {item_ids: 'frozen<list<bigint>>'}},
	shop_orders: {
		columns: SHOP_ORDER_COLUMNS,
		types: {
			item_ids: 'frozen<list<bigint>>',
			display_currency: 'text',
			display_amount_minor: 'bigint',
			display_rate_micro: 'int',
		},
	},
	// The KV counter flushes the reply count into the comment row like like_count and comment_count on feed_posts.
	feed_comments: {columns: FEED_COMMENT_COLUMNS, types: {reply_count: 'int'}},
	feed_comments_by_author: {columns: FEED_COMMENT_BY_AUTHOR_COLUMNS, types: {parent_id: 'bigint'}},
	feed_comment_replies: {
		columns: FEED_COMMENT_REPLY_COLUMNS,
		types: {
			post_id: 'bigint',
			comment_id: 'bigint',
			bucket: 'int',
			reply_id: 'bigint',
			author_id: 'bigint',
			content: 'text',
			edited_at: 'timestamp',
		},
	},
	feed_comment_reply_buckets: {
		columns: FEED_COMMENT_REPLY_BUCKET_COLUMNS,
		types: {post_id: 'bigint', comment_id: 'bigint', bucket: 'int', updated_at: 'timestamp'},
	},
	feed_videos: {
		columns: FEED_VIDEO_COLUMNS,
		types: {
			video_guid: 'text',
			author_id: 'bigint',
			created_id: 'bigint',
			state: 'text',
			content: 'text',
			flags: 'int',
			content_type: 'text',
			declared_size: 'bigint',
			post_id: 'bigint',
			uploaded_at: 'text',
			original_hash: 'text',
			width: 'int',
			height: 'int',
			duration: 'int',
			mp4_file: 'text',
			scan_started_at: 'timestamp',
			updated_at: 'timestamp',
		},
	},
	feed_videos_by_author: {
		columns: FEED_VIDEO_BY_AUTHOR_COLUMNS,
		types: {author_id: 'bigint', created_id: 'bigint', video_guid: 'text'},
	},
	feed_videos_pending: {
		columns: FEED_VIDEO_PENDING_COLUMNS,
		types: {hour: 'int', shard: 'int', video_guid: 'text'},
	},
	// First-party bot buttons: prefixed names, the API field is still `components`.
	messages: {columns: MESSAGE_COLUMNS, types: {micup_components: 'frozen<list<micup_message_action_row>>'}},
};

const FEED_MEDIA_FIELDS = [
	'attachment_id:bigint',
	'filename:text',
	'size:bigint',
	'description:text',
	'width:int',
	'height:int',
	'content_type:text',
	'content_hash:text',
	'placeholder:text',
	'flags:int',
	'nsfw:boolean',
	'duration:int',
	'stream_video_id:text',
	'stream_mp4_file:text',
];

const MICUP_MESSAGE_COMPONENT_FIELDS = [
	'type:int',
	'style:int',
	'label:text',
	'emoji_name:text',
	'emoji_id:bigint',
	'emoji_animated:boolean',
	'custom_id:text',
	'disabled:boolean',
];

const MICUP_MESSAGE_ACTION_ROW_FIELDS = ['type:int', 'components:frozen<list<micup_message_component>>'];

// fluxer-dev writes identifiers unquoted, so a reserved word as a name fails the CQL apply. Reserved = the Lexer.g
// keywords outside Parser.g unreserved_keyword/native_type on apache/cassandra cassandra-5.0, plus the Appendix A
// "reserved" rows (https://cassandra.apache.org/doc/latest/cassandra/developing/cql/appendices.html#appendix-A).
// default, mbean, mbeans and unset are basic_unreserved_keyword in Cassandra 5.0 and are deliberately excluded:
// https://github.com/apache/cassandra/blob/cassandra-5.0.0/src/antlr/Parser.g#L2014-L2018
const CQL_RESERVED_WORDS = new Set([
	'add',
	'allow',
	'alter',
	'and',
	'apply',
	'asc',
	'authorize',
	'batch',
	'begin',
	'by',
	'columnfamily',
	'create',
	'delete',
	'desc',
	'describe',
	'drop',
	'entries',
	'execute',
	'from',
	'full',
	'grant',
	'if',
	'in',
	'index',
	'infinity',
	'insert',
	'into',
	'is',
	'keyspace',
	'limit',
	'materialized',
	'modify',
	'nan',
	'norecursive',
	'not',
	'null',
	'of',
	'on',
	'or',
	'order',
	'primary',
	'rename',
	'replace',
	'revoke',
	'schema',
	'select',
	'set',
	'table',
	'to',
	'token',
	'truncate',
	'unlogged',
	'update',
	'use',
	'using',
	'view',
	'where',
	'with',
]);

const DSL_TABLES = [
	...Object.values(BadgeTables),
	...Object.values(CosmeticTables),
	...Object.values(FeedTables),
	...Object.values(FollowTables),
	...Object.values(GuildBoostTables),
	...Object.values(GuildRosterTables),
	...Object.values(MicupBotTables),
	...Object.values(PremiumLedgerTables),
	...Object.values(PremiumTrialTables),
	...Object.values(ReferralTables),
	...Object.values(ShopTables),
];

function schemaTable(name: string): SchemaTable | undefined {
	return SCHEMA.tables.find((table) => table.name === name);
}

function dslPrimaryKey(table: (typeof DSL_TABLES)[number]): string {
	const partition = table.partitionKey.map(String);
	const clustering = table.primaryKey.map(String).filter((column) => !partition.includes(column));
	return `(${[`(${partition.join(', ')})`, ...clustering].join(', ')})`;
}

function ttlFromOptions(options: string): number {
	const match = /default_time_to_live = (\d+)/.exec(options);
	return match ? Number(match[1]) : 0;
}

describe('Micup Cassandra schema parity', () => {
	it('defines every pinned Micup table in a module table file and nothing else', () => {
		expect(DSL_TABLES.map((table) => table.name).sort()).toEqual(Object.keys(MICUP_TABLES).sort());
	});

	it('keeps the pinned key, clustering order, TTL and compaction in the target schema', () => {
		const mismatches = Object.entries(MICUP_TABLES).flatMap(([name, expected]) => {
			const table = schemaTable(name);
			const actual = table ? {primaryKey: table.primary_key, options: table.options} : null;
			return JSON.stringify(actual) === JSON.stringify(expected) ? [] : [`${name}: ${JSON.stringify(actual)}`];
		});
		expect(mismatches).toEqual([]);
	});

	it('matches the table DSL columns, key and TTL', () => {
		const mismatches = DSL_TABLES.flatMap((table) => {
			const target = schemaTable(table.name);
			if (!target) return [`${table.name}: missing from target schema`];
			const actual = {
				columns: [...table.columns].map(String).sort(),
				primaryKey: dslPrimaryKey(table),
				ttl: table.defaultTtlSeconds ?? 0,
			};
			const expected = {
				columns: target.columns.map((column) => column.name).sort(),
				primaryKey: target.primary_key,
				ttl: ttlFromOptions(target.options),
			};
			return JSON.stringify(actual) === JSON.stringify(expected)
				? []
				: [`${table.name}: DSL ${JSON.stringify(actual)} schema ${JSON.stringify(expected)}`];
		});
		expect(mismatches).toEqual([]);
	});

	it('adds the pinned columns to users, guilds, channels, the feed tables, gift_codes and the shop tables in the schema and the row column lists', () => {
		const mismatches = Object.entries(MICUP_CORE_COLUMNS).flatMap(([name, {columns, types}]) => {
			const target = schemaTable(name);
			return Object.entries(types).flatMap(([column, type]) => {
				const schemaType = target?.columns.find((candidate) => candidate.name === column)?.type;
				return schemaType === type && columns.includes(column)
					? []
					: [{table: name, column, schemaType, inRowColumns: columns.includes(column)}];
			});
		});
		expect(mismatches).toEqual([]);
	});

	it('declares the feed_media UDT with its pinned fields', () => {
		const udt = SCHEMA.user_types.find((type) => type.name === 'feed_media');
		expect(udt?.fields.map((field) => `${field.name}:${field.type}`)).toEqual(FEED_MEDIA_FIELDS);
	});

	it('declares the micup_message_component UDT with its pinned fields', () => {
		const udt = SCHEMA.user_types.find((type) => type.name === 'micup_message_component');
		expect(udt?.fields.map((field) => `${field.name}:${field.type}`)).toEqual(MICUP_MESSAGE_COMPONENT_FIELDS);
	});

	it('declares the micup_message_action_row UDT with its pinned fields', () => {
		const udt = SCHEMA.user_types.find((type) => type.name === 'micup_message_action_row');
		expect(udt?.fields.map((field) => `${field.name}:${field.type}`)).toEqual(MICUP_MESSAGE_ACTION_ROW_FIELDS);
	});

	it('names no table, column, UDT, UDT field or index with a reserved CQL word', () => {
		const names = [
			...SCHEMA.tables.flatMap((table) => [
				table.name,
				...table.columns.map((column) => `${table.name}.${column.name}`),
			]),
			...SCHEMA.user_types.flatMap((type) => [type.name, ...type.fields.map((field) => `${type.name}.${field.name}`)]),
			...(SCHEMA.indexes ?? []).map((index) => index.name),
		];
		expect(names.filter((name) => CQL_RESERVED_WORDS.has(name.split('.').pop()!.toLowerCase()))).toEqual([]);
	});
});

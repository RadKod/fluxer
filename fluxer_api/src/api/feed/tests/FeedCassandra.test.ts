// SPDX-License-Identifier: AGPL-3.0-or-later

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {createServer} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createUserID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {FeedPostFlags, type FeedPostRow} from '@app/api/database/types/FeedTypes';
import type {MessageEmbed} from '@app/api/database/types/MessageTypes';
import {FeedRepository, feedDay} from '@app/api/feed/FeedRepository';
import {FeedInteractionRepository} from '@app/api/feed/interaction/FeedInteractionRepository';
import {startDockerContainer} from '@app/api/test/DockerTestContainer';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {UserRelationshipRepository} from '@app/api/user/repositories/UserRelationshipRepository';
import {RelationshipTypes} from '@fluxer/constants/src/UserConstants';
import {createSnowflakeFromTimestamp} from '@fluxer/snowflake/src/Snowflake';
import {initCassandra, shutdownCassandra} from '@pkgs/cassandra/src/Client';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import cassandra from 'cassandra-driver';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '../../../../..');
const CONTAINER = `fluxer-feed-${process.pid.toString(36)}-${Date.now().toString(36)}`;
const KEYSPACE = 'fluxer_feed';
const LOCAL_DC = 'datacenter1';
// Dependencies first: message_embed and message_embed_child hold the other embed types, feed_posts holds both lists.
const USER_TYPES = [
	'message_embed_author',
	'message_embed_provider',
	'message_embed_media',
	'message_embed_footer',
	'message_embed_field',
	'message_embed_child',
	'message_embed',
	'feed_media',
];
const TABLES = [
	'feed_posts',
	'feed_posts_by_author',
	'feed_author_buckets',
	'feed_poll_votes',
	'feed_poll_votes_by_user',
	'feed_post_likes',
	'feed_comments',
	'feed_comment_buckets',
	'feed_comment_replies',
	'feed_comment_reply_buckets',
	'relationships_by_target',
];
const dockerAvailable = spawnSync('docker', ['version'], {stdio: 'ignore'}).status === 0;

interface TargetSchema {
	user_types: Array<{name: string; fields: Array<{name: string; type: string}>}>;
	tables: Array<{name: string; columns: Array<{name: string; type: string}>; primary_key: string; options: string}>;
}

function schemaCql(): Array<string> {
	const schema = JSON.parse(
		fs.readFileSync(path.join(REPO_ROOT, 'tools/dev/cassandra_target_schema.json'), 'utf8'),
	) as TargetSchema;
	const find = <T extends {name: string}>(entries: Array<T>, name: string) => {
		const entry = entries.find((candidate) => candidate.name === name);
		if (!entry) throw new Error(`${name} missing from the target schema`);
		return entry;
	};
	return [
		...USER_TYPES.map((name) => {
			const fields = find(schema.user_types, name).fields.map((field) => `${field.name} ${field.type}`);
			return `CREATE TYPE IF NOT EXISTS ${KEYSPACE}.${name} (${fields.join(', ')})`;
		}),
		...TABLES.map((name) => {
			const table = find(schema.tables, name);
			const fields = [
				...table.columns.map((column) => `${column.name} ${column.type}`),
				`PRIMARY KEY ${table.primary_key}`,
			];
			return `CREATE TABLE IF NOT EXISTS ${KEYSPACE}.${name} (${fields.join(', ')})${table.options ? ` WITH ${table.options}` : ''}`;
		}),
	];
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (typeof address === 'string' || address === null) {
				reject(new Error('no port'));
				return;
			}
			const port = address.port;
			server.close(() => resolve(port));
		});
	});
}

// Smoke run of the Keşfet feed columns and tables on real Cassandra 5.0 (the in-memory executor takes any column and
// any UDT shape): poll and embed columns of feed_posts, feed_media.duration, the poll vote tables, the counter columns
// and the reader's incoming relationships the Keşfet list filters by.
describe.skipIf(!dockerAvailable)('Keşfet feed queries against Cassandra 5.0', () => {
	let admin: cassandra.Client | null = null;
	const author = createUserID(2_000_001n);
	const voter = createUserID(2_000_002n);
	const postId = createSnowflakeFromTimestamp(Date.now());

	beforeAll(async () => {
		const port = await freePort();
		startDockerContainer([
			'run',
			'-d',
			'--name',
			CONTAINER,
			'-e',
			'MAX_HEAP_SIZE=512M',
			'-e',
			'HEAP_NEWSIZE=128M',
			'-e',
			'JVM_EXTRA_OPTS=-Dcassandra.skip_wait_for_gossip_to_settle=0',
			'-p',
			`127.0.0.1:${port}:9042`,
			'cassandra:5.0',
		]);
		for (let attempt = 0; attempt < 300 && admin === null; attempt++) {
			const client = new cassandra.Client({
				contactPoints: ['127.0.0.1'],
				localDataCenter: LOCAL_DC,
				protocolOptions: {port},
				encoding: {useBigIntAsLong: true},
			});
			try {
				await client.connect();
				admin = client;
			} catch {
				await client.shutdown().catch(() => {});
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		}
		if (admin === null) throw new Error('cassandra never came up');
		await admin.execute(
			`CREATE KEYSPACE IF NOT EXISTS ${KEYSPACE} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`,
		);
		for (const statement of schemaCql()) await admin.execute(statement);
		setCassandraQueryExecutorForTesting(null);
		await initCassandra({hosts: ['127.0.0.1'], port, keyspace: KEYSPACE, localDc: LOCAL_DC});
	}, 900_000);

	afterAll(async () => {
		await shutdownCassandra().catch(() => {});
		await admin?.shutdown().catch(() => {});
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
		spawnSync('docker', ['rm', '-f', CONTAINER], {stdio: 'ignore'});
	});

	it('writes a public poll post with a video and reads it back, then stores its link preview', async () => {
		const feed = new FeedRepository(new MockKVProvider());
		const row: FeedPostRow = {
			post_id: postId,
			author_id: author,
			content: 'Hangisi? https://www.youtube.com/watch?v=dQw4w9WgXcQ',
			media: [
				{
					attachment_id: 1n,
					filename: 'clip.mp4',
					size: 1024n,
					description: null,
					width: 640,
					height: 360,
					content_type: 'video/mp4',
					content_hash: 'hash',
					placeholder: null,
					flags: 0,
					nsfw: false,
					duration: 12,
				},
			],
			edited_at: null,
			flags: FeedPostFlags.PUBLIC,
			like_count: 0,
			comment_count: 0,
			poll_options: ['Kırmızı', 'Mavi', 'Yeşil'],
			poll_expires_at: new Date(Date.now() + 3_600_000),
		};
		await feed.createPost(row);

		const read = await feed.getPost(postId);
		expect(read).toMatchObject({author_id: author, flags: FeedPostFlags.PUBLIC, poll_options: row.poll_options});
		expect(read?.poll_expires_at?.getTime()).toBe(row.poll_expires_at!.getTime());
		expect(read?.media?.[0]?.duration).toBe(12);
		expect(read?.poll_vote_count_0 ?? null).toBeNull();

		const embed: MessageEmbed = {
			type: 'video',
			url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
			title: 'Video',
			description: null,
			timestamp: new Date('2026-09-27T10:00:00.000Z'),
			color: null,
			author: {name: 'Kanal', url: null, icon_url: null},
			provider: {name: 'YouTube', url: 'https://www.youtube.com'},
			thumbnail: {
				url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
				width: 480,
				height: 360,
				description: null,
				content_type: 'image/jpeg',
				content_hash: null,
				placeholder: null,
				flags: 0,
				duration: null,
			},
			image: null,
			video: null,
			footer: null,
			fields: null,
			nsfw: null,
			children: null,
		};
		expect(await feed.setPostEmbeds(postId, [embed])).toBe(true);
		expect(await feed.setPostEmbeds(postId + 1n, [embed])).toBe(false);
		const withPreview = await feed.getPost(postId);
		expect(withPreview?.embeds?.[0]).toMatchObject({
			url: embed.url,
			title: 'Video',
			provider: {name: 'YouTube'},
			thumbnail: {url: embed.thumbnail!.url, width: 480},
		});
		expect(withPreview?.embeds?.[0]?.timestamp?.getTime()).toBe(embed.timestamp!.getTime());
	});

	it('stores, lists, recounts and drops a poll vote, and keeps the counter base column', async () => {
		const interactions = new FeedInteractionRepository(new MockKVProvider());
		await interactions.putPollVote(voter, postId, 1, new Date());

		expect(await interactions.getPollVote(voter, postId)).toBe(1);
		expect(await interactions.listPollVotes(voter, [postId, postId - 1n])).toEqual(new Map([[postId, 1]]));
		expect(
			(await interactions.listUserPollVotes(voter, feedDay(postId), {limit: 10})).map((vote) => vote.post_id),
		).toEqual([postId]);
		expect(await interactions.countPollVotes(postId, 1)).toBe(1);
		expect(await interactions.countPollVotes(postId, 0)).toBe(0);

		await interactions.setPostCount(postId, 'poll_vote_count_1', 1);
		expect(await interactions.getPostCounts(postId)).toMatchObject({poll_vote_count_1: 1});

		await interactions.deletePostInteractions(postId, {poll: true});
		expect(await interactions.countPollVotes(postId, 1)).toBe(0);
		await interactions.deletePollVote(voter, postId);
		expect(await interactions.getPollVote(voter, postId)).toBeNull();
	});

	it('lists the relationships other accounts hold toward a reader', async () => {
		const reader = createUserID(2_000_003n);
		const blocker = createUserID(2_000_004n);
		await admin!.execute(
			`INSERT INTO ${KEYSPACE}.relationships_by_target (target_user_id, source_user_id, type) VALUES (?, ?, ?)`,
			[reader, blocker, RelationshipTypes.BLOCKED],
			{prepare: true},
		);
		expect(await new UserRelationshipRepository().listIncomingRelationships(reader, {limit: 10})).toEqual([
			{source_user_id: blocker, type: RelationshipTypes.BLOCKED},
		]);
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {Config, getConfig} from '@app/api/Config';
import {FeedPostFlags, type FeedPostRow} from '@app/api/database/types/FeedTypes';
import type {MessageEmbed, MessageEmbedMedia} from '@app/api/database/types/MessageTypes';
import {feedInviteBases} from '@app/api/feed/FeedLinkPreview';
import {
	captureJobs,
	createPost,
	overrideLimits,
	type QueuedJob,
	setProfileLevel,
} from '@app/api/feed/tests/FeedTestUtils';
import {EmbedService} from '@app/api/infrastructure/EmbedService';
import type {MediaProxyNsfwMode} from '@app/api/infrastructure/IMediaService';
import {IUnfurlerService, type UnfurlOptions, type UnfurlResult} from '@app/api/infrastructure/IUnfurlerService';
import {getKVClient, getMediaService, getSnowflakeService, getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {
	getChannelRepository,
	getFeedDiscoverRepository,
	getFeedInteractionRepository,
	getFeedRepository,
	getFeedTimelineService,
	setInjectedUnfurlerService,
} from '@app/api/middleware/ServiceSingletons';
import {urlBlocklistCache} from '@app/api/middleware/UrlBlocklistCache';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import type {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {TestMediaService} from '@app/api/test/TestMediaService';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import extractFeedPostEmbeds from '@app/api/worker/tasks/ExtractFeedPostEmbeds';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {GatewayTimeoutError} from '@fluxer/errors/src/domains/core/GatewayTimeoutError';
import {FeedPostResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {MessageEmbedResponse} from '@fluxer/schema/src/domains/message/EmbedSchemas';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const HOUR = 3_600_000;
const YOUTUBE = 'https://youtu.be/dQw4w9WgXcQ';
const THUMBNAIL = 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg';
const helpers: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};
const proxied = (url: string) => `https://media-proxy.test/external/${encodeURIComponent(url)}`;

const youtubeCard = (patch: Partial<MessageEmbedResponse> = {}): MessageEmbedResponse => ({
	type: 'video',
	url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
	title: 'Never Gonna Give You Up',
	description: 'The video',
	provider: {name: 'YouTube', url: 'https://www.youtube.com'},
	thumbnail: {url: THUMBNAIL, width: 480, height: 360, flags: 0},
	video: {url: 'https://www.youtube.com/embed/dQw4w9WgXcQ', width: 1280, height: 720, flags: 0},
	html: '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>',
	...patch,
});

// The unfurler answers what the test sets; every call is recorded.
class FakeUnfurler extends IUnfurlerService {
	readonly calls: Array<{url: string; nsfwMode?: MediaProxyNsfwMode; options: UnfurlOptions}> = [];
	answer: (url: string) => Promise<UnfurlResult> = async () => ({embeds: [], cacheTtlSeconds: null});

	override async unfurlWithCachePolicy(
		url: string,
		nsfwMode?: MediaProxyNsfwMode,
		options: UnfurlOptions = {},
	): Promise<UnfurlResult> {
		this.calls.push({url, nsfwMode, options});
		return this.answer(url);
	}
}

describe('feed link previews', () => {
	let harness: ApiTestHarness;
	let unfurler: FakeUnfurler;
	let jobs: Array<QueuedJob>;

	const getPost = (viewer: TestAccount, postId: string) =>
		createBuilder<FeedPostResponse>(harness, viewer.token).get(`/feed/posts/${postId}`);
	// public posts, written while the author is public.
	const post = async (author: TestAccount, content: string) => {
		await setProfileLevel(author, 100);
		return (await createPost(harness, author, {content}).execute()).id;
	};
	const embedJobs = () => jobs.filter((job) => job.task === 'extractFeedPostEmbeds');
	async function runEmbedJobs(): Promise<void> {
		for (const job of embedJobs()) await extractFeedPostEmbeds(job.payload, helpers);
	}
	async function preview(viewer: TestAccount, postId: string) {
		const response = await getPost(viewer, postId).execute();
		FeedPostResponse.parse(response);
		return response.link_preview;
	}
	const media = (url: string): MessageEmbedMedia => ({
		url,
		width: 640,
		height: 360,
		description: null,
		content_type: 'image/jpeg',
		content_hash: null,
		placeholder: null,
		flags: 0,
		duration: null,
	});
	const storedCard = (url: string, patch: Partial<MessageEmbed> = {}): MessageEmbed => ({
		type: 'link',
		title: 'card',
		description: null,
		url,
		timestamp: null,
		color: null,
		author: null,
		provider: null,
		thumbnail: null,
		image: null,
		video: null,
		footer: null,
		fields: null,
		nsfw: null,
		children: null,
		...patch,
	});
	// A public post row of a public author written straight to the repository and placed in the Keşfet ranking.
	async function plant(author: TestAccount, score: number, embeds: Array<MessageEmbed>): Promise<string> {
		await setProfileLevel(author, 100);
		const row: FeedPostRow = {
			post_id: await getSnowflakeService().generate(),
			author_id: createUserID(BigInt(author.userId)),
			content: 'bak',
			media: null,
			edited_at: null,
			flags: FeedPostFlags.PUBLIC,
			like_count: 0,
			comment_count: 0,
			embeds,
		};
		await getFeedRepository().createPost(row);
		await getFeedDiscoverRepository().rankPost(row.post_id, score);
		return row.post_id.toString();
	}

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		unfurler = new FakeUnfurler();
		setInjectedUnfurlerService(unfurler);
		setWorkerDependenciesForTest({
			embedService: new EmbedService(getChannelRepository(), unfurler, getMediaService(), getWorkerService()),
		});
		// TestMediaService answers one fixed URL; this one shows which link each proxy URL is for.
		vi.spyOn(TestMediaService.prototype, 'getExternalMediaProxyURL').mockImplementation(proxied as () => string);
		jobs = captureJobs();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		clearWorkerDependencies();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	it('queues one embed job for a post with an allowed link and none for other links', async () => {
		const author = await createTestAccount(harness);
		await post(author, 'bak https://example.com/x');
		expect(embedJobs()).toEqual([]);
		const postId = await post(author, `izle ${YOUTUBE} ve https://www.twitch.tv/somechannel`);
		expect(embedJobs()).toEqual([{task: 'extractFeedPostEmbeds', payload: {postId}}]);
	});

	it('stores the unfurled YouTube card and serves it as link_preview with media through the proxy', async () => {
		const author = await createTestAccount(harness);
		unfurler.answer = async () => ({embeds: [youtubeCard()], cacheTtlSeconds: 60});
		const postId = await post(author, `izle ${YOUTUBE}).`);
		await runEmbedJobs();

		expect(unfurler.calls.map(({url, nsfwMode}) => ({url, nsfwMode}))).toEqual([{url: YOUTUBE, nsfwMode: 'block'}]);
		expect(unfurler.calls[0]!.options.signal).toBeInstanceOf(AbortSignal);
		const linkPreview = await preview(author, postId);
		expect(linkPreview).toMatchObject({kind: 'youtube', url: YOUTUBE, invite_code: null});
		expect(linkPreview?.embed).toMatchObject({
			url: YOUTUBE,
			title: 'Never Gonna Give You Up',
			thumbnail: {url: THUMBNAIL, proxy_url: proxied(THUMBNAIL)},
			video: {url: 'https://www.youtube.com/embed/dQw4w9WgXcQ'},
		});
		expect(linkPreview?.embed).not.toHaveProperty('html');
	});

	it('stores the fallback card when the unfurled card belongs to another site than the link', async () => {
		const author = await createTestAccount(harness);
		unfurler.answer = async (url) => ({
			embeds: [
				url === YOUTUBE
					? youtubeCard({url: 'https://evil.test/landing', title: 'Başka site'})
					: youtubeCard({title: 'YouTube kartı'}),
			],
			cacheTtlSeconds: null,
		});
		const redirected = await post(author, YOUTUBE);
		const twitch = await post(author, 'https://www.twitch.tv/somechannel');
		await runEmbedJobs();

		expect((await preview(author, redirected))?.embed).toMatchObject({
			title: null,
			provider: {name: 'YouTube'},
			thumbnail: null,
		});
		expect((await preview(author, twitch))?.embed).toMatchObject({
			title: 'somechannel',
			provider: {name: 'Twitch'},
			thumbnail: null,
		});
	});

	it('stores a fallback card for Twitch and Kick when the unfurler returns nothing', async () => {
		const author = await createTestAccount(harness);
		const twitch = await post(author, 'yayın https://www.twitch.tv/somechannel');
		const kick = await post(author, 'klip https://kick.com/somechannel/clips/clip_01ABC');
		await runEmbedJobs();

		expect((await preview(author, twitch))?.embed).toMatchObject({
			provider: {name: 'Twitch'},
			title: 'somechannel',
			thumbnail: null,
			image: null,
			video: null,
		});
		expect(await preview(author, kick)).toMatchObject({
			kind: 'kick',
			url: 'https://kick.com/somechannel/clips/clip_01ABC',
			embed: {provider: {name: 'Kick'}, title: 'somechannel/clips/clip_01ABC', thumbnail: null},
		});
	});

	it('falls back to a card when the unfurler times out or fails', async () => {
		const author = await createTestAccount(harness);
		unfurler.answer = async () => {
			throw new GatewayTimeoutError({message: '[nats-unfurl] unfurl service did not answer in time'});
		};
		const postId = await post(author, YOUTUBE);
		await expect(runEmbedJobs()).resolves.toBeUndefined();
		expect(await preview(author, postId)).toMatchObject({
			kind: 'youtube',
			url: YOUTUBE,
			embed: {provider: {name: 'YouTube'}, thumbnail: null, video: null},
		});
	});

	it('gives up on a hanging unfurler after 5 s and stores the fallback card', async () => {
		const author = await createTestAccount(harness);
		unfurler.answer = () => new Promise<never>(() => {});
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(20));
		const postId = await post(author, 'https://www.twitch.tv/somechannel');
		await runEmbedJobs();
		expect(timeout).toHaveBeenCalledWith(5000);
		expect((await preview(author, postId))?.embed).toMatchObject({provider: {name: 'Twitch'}, title: 'somechannel'});
	});

	it("a Twitch or Kick preview's images stay out of Keşfet while feature_feed_discover_media is 0 and come back at 1; YouTube and invite previews keep theirs", async () => {
		const [a, b, c, d] = await Promise.all(Array.from({length: 4}, () => createTestAccount(harness)));
		const image = media('https://static-cdn.jtvnw.net/preview.jpg');
		const inviteUrl = new URL('abc123', Config.endpoints.invite.replace(/\/?$/, '/')).toString();
		const twitch = await plant(a!, 4, [
			storedCard('https://www.twitch.tv/somechannel', {thumbnail: image, image, video: image}),
		]);
		const kick = await plant(b!, 3, [storedCard('https://kick.com/somechannel', {image})]);
		const youtube = await plant(c!, 2, [
			storedCard('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {thumbnail: media(THUMBNAIL)}),
		]);
		const invite = await plant(d!, 1, [storedCard(inviteUrl)]);
		const previews = async () => {
			await getKVClient().del('feed:discover:build');
			await getFeedTimelineService().discover.buildSnapshot(Date.now() + 25 * HOUR);
			const snapshot = await getFeedDiscoverRepository().getSnapshot();
			return new Map(snapshot!.entries.map((entry) => [entry.post.id, entry.post.link_preview]));
		};

		const closed = await previews();
		expect(closed.get(twitch)?.embed).toMatchObject({thumbnail: null, image: null, video: null});
		expect(closed.get(kick)?.embed).toMatchObject({image: null});
		expect(closed.get(youtube)?.embed?.thumbnail?.proxy_url).toBe(proxied(THUMBNAIL));
		expect(closed.get(invite)).toMatchObject({kind: 'invite', invite_code: 'abc123'});

		overrideLimits({feature_feed_discover_media: 1});
		const open = await previews();
		expect(open.get(twitch)?.embed?.thumbnail?.proxy_url).toBe(proxied(image.url!));
		expect(open.get(kick)?.embed?.image?.proxy_url).toBe(proxied(image.url!));
	});

	it('builds invite bases from Config.endpoints only, with one trailing slash', () => {
		const original = getConfig().endpoints.invite;
		const endpoint = new URL(original);
		const expected = {origin: endpoint.origin, pathPrefix: `${endpoint.pathname.replace(/\/+$/, '')}/`};
		try {
			getConfig().endpoints.invite = `${original.replace(/\/+$/, '')}/`;
			const withSlash = feedInviteBases();
			getConfig().endpoints.invite = original.replace(/\/+$/, '');
			const withoutSlash = feedInviteBases();
			expect(withSlash).toEqual(withoutSlash);
			expect(withSlash).toContainEqual(expected);
			const origins = new Set([endpoint.origin, new URL(Config.endpoints.webApp).origin]);
			for (const base of withSlash) expect(origins.has(base.origin)).toBe(true);
		} finally {
			getConfig().endpoints.invite = original;
		}
	});

	it('serves an invite preview with its code and no embed, without calling the unfurler', async () => {
		const author = await createTestAccount(harness);
		const inviteUrl = new URL('abc123', Config.endpoints.invite.replace(/\/?$/, '/')).toString();
		const postId = await post(author, `katıl ${inviteUrl}`);
		await runEmbedJobs();
		expect(unfurler.calls).toEqual([]);
		expect(await preview(author, postId)).toEqual({kind: 'invite', url: inviteUrl, invite_code: 'abc123', embed: null});
	});

	it('drops NSFW cards and deletes the post when moderation blocks the link', async () => {
		const author = await createTestAccount(harness);
		unfurler.answer = async () => ({embeds: [youtubeCard({nsfw: true})], cacheTtlSeconds: null});
		const nsfw = await post(author, YOUTUBE);
		await runEmbedJobs();
		expect((await preview(author, nsfw))?.embed).toMatchObject({provider: {name: 'YouTube'}, thumbnail: null});

		jobs.length = 0;
		urlBlocklistCache.addDomain('banned-cdn.test');
		try {
			unfurler.answer = async () => ({
				embeds: [youtubeCard({thumbnail: {url: 'https://banned-cdn.test/x.jpg', flags: 0}})],
				cacheTtlSeconds: null,
			});
			const blocked = await post(author, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
			await runEmbedJobs();
			await getPost(author, blocked).expect(HTTP_STATUS.NOT_FOUND).execute();
		} finally {
			urlBlocklistCache.removeDomain('banned-cdn.test');
		}
	});

	it('the next read after the job shows the preview even though the post was cached', async () => {
		const author = await createTestAccount(harness);
		const postId = await post(author, 'https://www.twitch.tv/somechannel');
		expect(await preview(author, postId)).toBeUndefined();
		await runEmbedJobs();
		expect(await preview(author, postId)).toMatchObject({kind: 'twitch'});
	});

	it('does not bring back a deleted post or write a row for it', async () => {
		const author = await createTestAccount(harness);
		const postId = await post(author, 'https://www.twitch.tv/somechannel');
		await createBuilder(harness, author.token).delete(`/feed/posts/${postId}`).expect(HTTP_STATUS.NO_CONTENT).execute();
		await runEmbedJobs();

		expect(await getKVClient().get(`feed:post:${postId}`)).toBe('-');
		expect(
			await getFeedRepository().setPostEmbeds(BigInt(postId), [storedCard('https://www.twitch.tv/somechannel')]),
		).toBe(false);
		expect(await getFeedInteractionRepository().getPostCounts(BigInt(postId))).toBeNull();
		await getPost(author, postId).expect(HTTP_STATUS.NOT_FOUND).execute();
	});

	it("never drops a delete's tombstone that lands while the preview is written", async () => {
		const author = await createTestAccount(harness);
		const postId = await post(author, 'metin');
		const key = `feed:post:${postId}`;
		await getKVClient().setex(key, 60, '-');
		// The tombstone landed after a read of the entry: the old read saw the cached row, not the tombstone.
		const kv = harness.kvProvider as MockKVProvider;
		const get = kv.get.bind(kv);
		vi.spyOn(kv, 'get').mockImplementation(async (name) => (name === key ? '{"stale":true}' : get(name)));

		expect(await getFeedRepository().setPostEmbeds(BigInt(postId), [storedCard(YOUTUBE)])).toBe(true);
		vi.mocked(kv.get).mockRestore();
		expect(await getKVClient().get(key)).toBe('-');
	});

	it('a cached post row keeps embed timestamps as dates', async () => {
		const author = await createTestAccount(harness);
		const postId = await post(author, 'metin');
		const timestamp = new Date('2026-09-01T10:00:00.000Z');
		await getFeedRepository().setPostEmbeds(BigInt(postId), [
			storedCard('https://www.twitch.tv/somechannel', {timestamp}),
		]);
		await getFeedRepository().getPost(BigInt(postId));
		const cached = await getFeedRepository().getPost(BigInt(postId));
		expect(cached?.embeds?.[0]?.timestamp).toBeInstanceOf(Date);
		expect(cached?.embeds?.[0]?.timestamp).toEqual(timestamp);
		expect((await preview(author, postId))?.embed?.timestamp).toBe('2026-09-01T10:00:00.000Z');
	});
});

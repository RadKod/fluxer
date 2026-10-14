// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {FEED_VIEW_COUNT_COUNTER} from '@app/api/feed/interaction/FeedInteractionCounters';
import {FeedViewService, feedViewGateKey} from '@app/api/feed/views/FeedViewService';
import {signFeedViewTicket} from '@app/api/feed/views/FeedViews';
import {Logger} from '@app/api/Logger';
import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import type {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {FeatureTemporarilyDisabledError} from '@fluxer/errors/src/domains/core/FeatureTemporarilyDisabledError';
import {RateLimitError} from '@fluxer/errors/src/domains/core/RateLimitError';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const SECRET = 'feed-view-service-test-secret';
const MAX_POSTS = 50_000;
const FIRST_POST = 1_500_000_000_000_000_000n;

let nextViewer = 1_000_000_000_000_000n;
const newViewer = (): UserID => createUserID(nextViewer++);
const posts = (from: number, count: number) =>
	Array.from({length: count}, (_, index) => FIRST_POST + BigInt(from + index));

describe('FeedViewService', () => {
	let kv: MockKVProvider;
	let adds: Array<[string, number]>;
	let add: (namespace: string, id: string, delta: number) => Promise<number>;
	let enabled: boolean;
	let service: FeedViewService;

	const tickets = (viewerId: UserID, postIds: Array<bigint>, nowMs = Date.now()) =>
		postIds.map((id) => ({id, token: signFeedViewTicket(viewerId, id, nowMs, SECRET)}));
	const record = (viewerId: UserID, postIds: Array<bigint>) => service.record(viewerId, tickets(viewerId, postIds));
	const added = () => new Map(adds.map(([id, count]) => [id, count]));

	beforeEach(() => {
		kv = new MockKVProvider();
		adds = [];
		add = async (namespace, id, delta) => {
			expect(namespace).toBe(FEED_VIEW_COUNT_COUNTER);
			adds.push([id, delta]);
			return delta;
		};
		enabled = true;
		service = new FeedViewService({
			kv,
			counters: {add: (namespace, id, delta) => add(namespace, id, delta)},
			enabled: () => enabled,
			secret: SECRET,
		});
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		await service.shutdown();
	});

	it('answers 403 while feature_feed_views is 0 and writes nothing', async () => {
		enabled = false;
		const viewer = newViewer();

		await expect(record(viewer, posts(0, 1))).rejects.toBeInstanceOf(FeatureTemporarilyDisabledError);
		await service.flush();

		expect(adds).toEqual([]);
		expect(await kv.get(feedViewGateKey(viewer))).toBeNull();
	});

	it('counts a post named twice in one batch once', async () => {
		const viewer = newViewer();
		const [post] = posts(0, 1);

		await service.record(viewer, [...tickets(viewer, [post!]), ...tickets(viewer, [post!])]);
		await service.flush();

		expect(adds).toEqual([[post!.toString(), 1]]);
	});

	it("lets an account through once a minute and answers 429 with retry_after and resetTime from the gate's time left", async () => {
		const now = Date.now();
		vi.useFakeTimers({toFake: ['Date'], now});
		const viewer = newViewer();
		await record(viewer, posts(0, 1));
		expect(await kv.ttl(feedViewGateKey(viewer))).toBe(60);
		vi.setSystemTime(now + 18_000);

		const error = await record(viewer, posts(1, 1)).then(
			() => null,
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(RateLimitError);
		const refused = error as RateLimitError;
		expect(refused.data).toMatchObject({global: false, retry_after: 42});
		expect(refused.headers?.['Retry-After']).toBe('42');
		expect(refused.headers?.['X-RateLimit-Bucket']).toBeUndefined();
		expect(refused.headers?.['X-RateLimit-Reset']).toBe(String(Math.floor((now + 60_000) / 1000)));
		expect(refused.headers?.['X-RateLimit-Limit']).toBe('1');
		await service.flush();
		expect(adds).toEqual([[posts(0, 1)[0]!.toString(), 1]]);
	});

	it('keeps the gate open when every ticket is invalid', async () => {
		const viewer = newViewer();
		const [post] = posts(0, 1);

		await service.record(viewer, [
			{id: post!, token: 'not-a-ticket'},
			{id: post!, token: signFeedViewTicket(newViewer(), post!, Date.now(), SECRET)},
			{id: post!, token: signFeedViewTicket(viewer, post!, Date.now() - 13 * 3_600_000, SECRET)},
			{id: post!, token: signFeedViewTicket(viewer, post!, Date.now(), 'another-secret')},
		]);

		expect(await kv.get(feedViewGateKey(viewer))).toBeNull();
		await record(viewer, [post!]);
		await service.flush();
		expect(adds).toEqual([[post!.toString(), 1]]);
	});

	it('adds each post once per flush with the summed views', async () => {
		const [a, b] = posts(0, 2);
		await record(newViewer(), [a!, b!]);
		await record(newViewer(), [a!]);
		await record(newViewer(), [a!]);

		await service.flush();

		expect(added()).toEqual(
			new Map([
				[a!.toString(), 3],
				[b!.toString(), 1],
			]),
		);
		expect(adds).toHaveLength(2);
		await service.flush();
		expect(adds).toHaveLength(2);
	});

	it('holds at most 50 000 posts, flushes when full and drops beyond while a flush runs', async () => {
		const warn = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'warn');
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const recorded = add;
		add = async (namespace, id, delta) => {
			await held;
			return recorded(namespace, id, delta);
		};

		await record(newViewer(), posts(0, MAX_POSTS));
		expect(adds).toEqual([]);
		// Full: the next new post starts a flush, which takes the whole buffer, and goes into the empty one.
		await record(newViewer(), posts(MAX_POSTS, 1));
		// Full again while that flush still runs: a view of a buffered post still counts, a new post is dropped.
		await record(newViewer(), posts(MAX_POSTS, MAX_POSTS));
		await record(newViewer(), [...posts(MAX_POSTS, 1), ...posts(2 * MAX_POSTS, 1)]);

		release();
		await service.flush();
		await service.flush();

		const counts = added();
		expect(counts.size).toBe(2 * MAX_POSTS);
		expect(counts.get(posts(0, 1)[0]!.toString())).toBe(1);
		expect(counts.get(posts(MAX_POSTS, 1)[0]!.toString())).toBe(3);
		expect(counts.has(posts(2 * MAX_POSTS, 1)[0]!.toString())).toBe(false);
		vi.useFakeTimers({toFake: ['Date'], now: Date.now() + 61_000});
		await service.flush();
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({posts: 2 * MAX_POSTS, dropped: 1}),
			'Feed view buffer flushed',
		);
	}, 60_000);

	it('flushes every 5 s after the first view and not before', async () => {
		vi.useFakeTimers();
		const [a, b] = posts(0, 2);

		await record(newViewer(), [a!]);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(adds).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(adds).toEqual([[a!.toString(), 1]]);

		await record(newViewer(), [b!]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(adds).toEqual([
			[a!.toString(), 1],
			[b!.toString(), 1],
		]);
	});

	it('drains the buffer on shutdown', async () => {
		const [a] = posts(0, 1);
		await record(newViewer(), [a!]);

		await service.shutdown();

		expect(adds).toEqual([[a!.toString(), 1]]);
	});

	it('a failing KV add is logged and does not stop the other posts', async () => {
		const warn = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'warn');
		const [a, b, c] = posts(0, 3);
		const recorded = add;
		add = async (namespace, id, delta) => {
			if (id === b!.toString()) throw new Error('KV is down');
			return recorded(namespace, id, delta);
		};
		await record(newViewer(), [a!, b!, c!]);

		await service.flush();

		expect(added()).toEqual(
			new Map([
				[a!.toString(), 1],
				[c!.toString(), 1],
			]),
		);
		expect(warn).toHaveBeenCalledWith(expect.objectContaining({failed: 1}), expect.any(String));
	});

	it('logs one summary a minute with posts, views, dropped and ms', async () => {
		const info = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'info');
		const summaries = () =>
			(info.mock.calls as Array<Array<unknown>>).filter((call) => call[1] === 'Feed view buffer flushed');
		const start = Date.now();
		vi.useFakeTimers({toFake: ['Date'], now: start});
		const [a, b] = posts(0, 2);

		await record(newViewer(), [a!, b!]);
		await service.flush();
		await record(newViewer(), [a!]);
		await service.flush();
		expect(summaries()).toEqual([]);

		vi.setSystemTime(start + 60_000);
		await service.flush();
		expect(summaries()).toEqual([
			[{posts: 3, views: 3, dropped: 0, ms: expect.any(Number)}, 'Feed view buffer flushed'],
		]);

		vi.setSystemTime(start + 90_000);
		await record(newViewer(), [b!]);
		await service.flush();
		expect(summaries()).toHaveLength(1);
		vi.setSystemTime(start + 120_000);
		await service.flush();
		expect(summaries()[1]).toEqual([
			{posts: 1, views: 1, dropped: 0, ms: expect.any(Number)},
			'Feed view buffer flushed',
		]);
	});
});

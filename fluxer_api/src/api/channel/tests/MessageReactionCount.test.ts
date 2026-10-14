// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createEmojiID, createMessageID, createUserID} from '@app/api/BrandedTypes';
import type {AuthenticatedChannel} from '@app/api/channel/services/AuthenticatedChannel';
import {MessageReactionService} from '@app/api/channel/services/interaction/MessageReactionService';
import {sendChannelMessage, setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {counterKey, counterPartition} from '@app/api/infrastructure/KVCounterService';
import {Logger} from '@app/api/Logger';
import * as Registry from '@app/api/middleware/ServiceRegistry';
import {
	getChannelRepository,
	getGuildRepository,
	getKVCounterService,
	getLimitConfigService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {MAX_USERS_PER_MESSAGE_REACTION} from '@fluxer/constants/src/LimitConstants';
import {DEFAULT_FREE_LIMITS} from '@fluxer/limits/src/LimitDefaults';
import * as LimitResolver from '@fluxer/limits/src/LimitResolver';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const namespace = 'message_reaction_users';
const emoji = '👍';

describe('Message reaction user counts (K10)', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterEach(() => vi.restoreAllMocks());
	afterAll(async () => {
		await harness?.shutdown();
	});

	function overrideLimits(limits: Record<string, number>): void {
		// Guild-scoped reaction limits use their base value in the upstream user context.
		const resolveLimit = LimitResolver.resolveLimit;
		vi.spyOn(LimitResolver, 'resolveLimit').mockImplementation((snapshot, ctx, key, options) =>
			resolveLimit(snapshot, ctx, key, {...options, baseLimits: {...DEFAULT_FREE_LIMITS, ...limits}}),
		);
	}

	async function fixture(count: number) {
		const {owner, systemChannel} = await setupTestGuildWithMembers(harness, 0);
		const message = await sendChannelMessage(harness, owner.token, systemChannel.id, 'Count reactions');
		const channelId = createChannelID(BigInt(systemChannel.id));
		const messageId = createMessageID(BigInt(message.id));
		const userId = createUserID(BigInt(owner.userId));
		const repository = getChannelRepository();
		const interactions = repository.messageInteractions;
		for (let i = 0; i < count; i++) {
			await interactions.addReaction(channelId, messageId, createUserID(BigInt(10000 + i)), emoji);
		}
		const channel = await repository.findUnique(channelId);
		if (!channel) throw new Error('Missing test channel');
		const authChannel: AuthenticatedChannel = {
			channel,
			guild: null,
			member: null,
			hasPermission: async () => true,
			checkPermission: async () => {},
		};
		const service = new MessageReactionService(
			Registry.getGatewayService(),
			repository,
			getUserRepository(),
			getGuildRepository(),
			getLimitConfigService(),
		);
		const id = `${channelId}:${messageId}:0:${emoji}`;
		return {
			channelId,
			messageId,
			userId,
			id,
			repository,
			interactions,
			key: counterKey(namespace, id),
			add: (reactor = userId) => service.addReaction({authChannel, messageId, emoji, userId: reactor}),
			remove: () => service.removeReaction({authChannel, messageId, emoji, targetId: userId, actorId: userId}),
		};
	}

	it('the zero check reads at most one reaction row', async () => {
		const f = await fixture(101);
		const queries = vi.spyOn(InMemoryCassandraQueryExecutor.prototype, 'executeQuery');
		expect(await f.repository.hasReactionUsers(f.channelId, f.messageId, emoji, undefined)).toBe(true);
		expect(await f.repository.hasReactionUsers(f.channelId, f.messageId, '✅', undefined)).toBe(false);
		for (const [query] of queries.mock.calls) {
			expect(query.cql).toContain('LIMIT :limit_bind');
			expect(query.params.limit_bind).toBe(1);
		}
		expect(queries).toHaveBeenCalledTimes(2);
	});

	it('a reaction under 100 users never touches KV', async () => {
		const f = await fixture(99);
		const kv = vi.spyOn(Registry, 'getKVClient');
		const rows = vi.spyOn(f.interactions, 'countReactionUsersUpTo');
		await f.add();
		expect(kv).not.toHaveBeenCalled();
		expect(rows).toHaveBeenCalledExactlyOnceWith(f.channelId, f.messageId, emoji, undefined, 100);
	});

	it('past 100 users the cap check reads the KV counter, not the rows', async () => {
		const f = await fixture(101);
		await harness.kvProvider.set(f.key, '101');
		const get = vi.spyOn(harness.kvProvider, 'get');
		const rows = vi.spyOn(f.interactions, 'countReactionUsersUpTo');
		const unbounded = vi.spyOn(f.interactions, 'countReactionUsers');
		await f.add();
		expect(get).toHaveBeenCalledWith(f.key);
		expect(rows).toHaveBeenCalledExactlyOnceWith(f.channelId, f.messageId, emoji, undefined, 100);
		expect(unbounded).not.toHaveBeenCalled();
	});

	it('the counter follows adds and removes past 100', async () => {
		const f = await fixture(101);
		await harness.kvProvider.set(f.key, '101');
		await f.add();
		expect(await harness.kvProvider.get(f.key)).toBe('102');
		await f.add();
		expect(await harness.kvProvider.get(f.key)).toBe('102');
		await f.remove();
		expect(await harness.kvProvider.get(f.key)).toBe('101');
		await f.remove();
		expect(await harness.kvProvider.get(f.key)).toBe('101');
	});

	it('the per-reaction cap still refuses at the limit', async () => {
		const f = await fixture(30);
		overrideLimits({max_users_per_message_reaction: 30});
		await expect(f.add()).rejects.toMatchObject({code: 'MAX_REACTIONS'});
		expect(await f.interactions.checkUserReactionExists(f.channelId, f.messageId, f.userId, emoji)).toBe(false);
	});

	it('past 100 with no counter key the request reads at most 100 rows and seeds once in the background', async () => {
		const f = await fixture(101);
		overrideLimits({max_users_per_message_reaction: 100});
		const counters = getKVCounterService();
		const pending = Promise.withResolvers<number>();
		const seed = vi.spyOn(counters, 'add').mockReturnValue(pending.promise);
		const reads = vi.spyOn(counters, 'get');
		const rows = vi.spyOn(f.interactions, 'countReactionUsersUpTo');
		try {
			await f.add();
			await f.add(createUserID(90000n));
			expect(seed).toHaveBeenCalledExactlyOnceWith(namespace, f.id, 0);
			expect(reads).not.toHaveBeenCalled();
			expect(rows.mock.calls.map((call) => call[4])).toEqual([100, 100]);
			expect(await harness.kvProvider.ttl(`counter:seed:${f.id}`)).toBeGreaterThan(0);
		} finally {
			pending.resolve(103);
			await pending.promise;
		}
	});

	it('an existing counter enforces the cap without a full recount', async () => {
		const f = await fixture(100);
		await harness.kvProvider.set(f.key, '150');
		overrideLimits({max_users_per_message_reaction: 150});
		const rows = vi.spyOn(f.interactions, 'countReactionUsersUpTo');
		await expect(f.add()).rejects.toMatchObject({code: 'MAX_REACTIONS'});
		expect(rows.mock.calls.map((call) => call[4])).toEqual([100]);
	});

	it('counter failures never fail an add or removal', async () => {
		const f = await fixture(101);
		vi.spyOn(harness.kvProvider, 'get').mockRejectedValue(new Error('KV unavailable'));
		vi.spyOn(harness.kvProvider, 'counterAdd').mockRejectedValue(new Error('KV unavailable'));
		const warn = vi.spyOn(Logger.child({}), 'warn');
		await f.add();
		await f.remove();
		expect(warn).toHaveBeenCalled();
	});

	it('a failed background seed is logged without failing the reaction', async () => {
		const f = await fixture(101);
		vi.spyOn(getKVCounterService(), 'add').mockRejectedValue(new Error('Seed unavailable'));
		const warn = vi.spyOn(Logger.child({}), 'warn');
		await f.add();
		expect(warn).toHaveBeenCalled();
	});

	it('a missing counter is never seeded by a removal', async () => {
		const f = await fixture(0);
		await f.add();
		const seed = vi.spyOn(getKVCounterService(), 'add');
		await f.remove();
		expect(seed).not.toHaveBeenCalled();
		expect(await harness.kvProvider.exists(f.key)).toBe(0);
	});

	it('an expired counter cannot trigger a synchronous base read during an increment', async () => {
		const f = await fixture(101);
		await harness.kvProvider.set(f.key, '101');
		const write = f.interactions.addReaction.bind(f.interactions);
		vi.spyOn(f.interactions, 'addReaction').mockImplementation(async (...args) => {
			const result = await write(...args);
			await harness.kvProvider.del(f.key);
			return result;
		});
		const rows = vi.spyOn(f.interactions, 'countReactionUsersUpTo');
		await f.add();
		expect(rows.mock.calls.map((call) => call[4])).toEqual([100]);
		expect(await harness.kvProvider.exists(f.key)).toBe(0);
	});

	it('the registered flusher seeds a bounded count and expires it through the shared flush', async () => {
		const f = await fixture(101);
		const rows = vi.spyOn(f.repository, 'countReactionUsersUpTo');
		const counters = getKVCounterService();
		expect(await counters.add(namespace, f.id, 0)).toBe(101);
		expect(rows).toHaveBeenCalledWith(f.channelId, f.messageId, emoji, undefined, MAX_USERS_PER_MESSAGE_REACTION + 1);
		await counters.flushPartition(counterPartition(namespace, f.id), 1000);
		expect(await harness.kvProvider.ttl(f.key)).toBeGreaterThan(86_390);
	});

	it('the flusher preserves custom emoji names containing colons on recount', async () => {
		const f = await fixture(0);
		const {createMessageReactionUserCounterFlusher, messageReactionUserCounterId} = await import(
			'@app/api/channel/services/interaction/MessageReactionUserCounter'
		);
		const emojiId = createEmojiID(123n);
		await f.interactions.addReaction(f.channelId, f.messageId, f.userId, 'custom:name', emojiId);
		const flusher = createMessageReactionUserCounterFlusher(f.repository);
		const id = messageReactionUserCounterId(f.channelId, f.messageId, 'custom:name', emojiId);
		expect(await flusher.recount(id)).toBe(1);
		expect(flusher.dirtySet).toBeUndefined();
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {createMessageID, createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {MessageInteractionRepository} from '@app/api/channel/repositories/MessageInteractionRepository';
import {
	MESSAGE_REACTION_USERS_COUNTER,
	messageReactionUserCounterId,
} from '@app/api/channel/services/interaction/MessageReactionUserCounter';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {createMicupBotFixture, type MicupBotFixture} from '@app/api/guild/micupbot/tests/MicupBotTestUtils';
import * as RosterHook from '@app/api/guild/roster/GuildRosterReactionHook';
import {counterKey} from '@app/api/infrastructure/KVCounterService';
import {Logger} from '@app/api/Logger';
import {getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {getChannelRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {MAX_USERS_PER_MESSAGE_REACTION} from '@fluxer/constants/src/LimitConstants';
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest';

let harness: ApiTestHarness;
let f: MicupBotFixture;
let messageId: string;
let originalMicupBotId: string | undefined;
let originalRosterId: string | undefined;
beforeAll(async () => {
	harness = await createApiTestHarness();
});
beforeEach(async () => {
	originalMicupBotId = Config.instance.micupBotApplicationId;
	originalRosterId = Config.instance.rosterBotApplicationId;
	Config.instance.rosterBotApplicationId = undefined;
	await harness.reset();
	f = await createMicupBotFixture(harness);
	await f.addBot();
	messageId = (await f.createPanel().execute()).message_id;
});
afterEach(() => {
	Config.instance.micupBotApplicationId = originalMicupBotId;
	Config.instance.rosterBotApplicationId = originalRosterId;
	vi.restoreAllMocks();
});
afterAll(async () => {
	await harness?.shutdown();
});

const route = () => `/channels/${f.channelId}/messages/${messageId}/reactions/${encodeURIComponent('🔴')}/@me`;
const storedReaction = () =>
	getChannelRepository().messageInteractions.checkUserReactionExists(
		f.channelId,
		createMessageID(BigInt(messageId)),
		createUserID(BigInt(f.owner.userId)),
		'🔴',
	);

const reactionCounterKey = () =>
	counterKey(
		MESSAGE_REACTION_USERS_COUNTER,
		messageReactionUserCounterId(f.channelId, createMessageID(BigInt(messageId)), '🔴'),
	);

it('a reaction cap keeps the upstream user context instead of enabling guild limits', async () => {
	overrideLimits({max_users_per_message_reaction: 1});
	await createBuilder(harness, f.owner.token).put(route()).expect(204).execute();
	expect(await storedReaction()).toBe(true);
});

it('the upstream reaction cap still refuses at the limit', async () => {
	await harness.kvProvider.set(reactionCounterKey(), String(MAX_USERS_PER_MESSAGE_REACTION));
	vi.spyOn(MessageInteractionRepository.prototype, 'countReactionUsersUpTo').mockResolvedValue(100);
	const response = await createBuilder<{code: string}>(harness, f.owner.token).put(route()).expect(400).execute();
	expect(response.code).toBe('MAX_REACTIONS');
	expect(await storedReaction()).toBe(false);
});

it('removing a reaction without a counter skips the Cassandra existence read', async () => {
	await createBuilder(harness, f.owner.token).put(route()).expect(204).execute();
	const check = vi.spyOn(MessageInteractionRepository.prototype, 'checkUserReactionExists');
	const exists = vi.spyOn(harness.kvProvider, 'exists');
	const adjust = vi.spyOn(harness.kvProvider, 'counterAdd');
	await createBuilder(harness, f.owner.token).delete(route()).expect(204).execute();
	expect(check).not.toHaveBeenCalled();
	expect(exists).toHaveBeenCalledWith(reactionCounterKey());
	expect(adjust).not.toHaveBeenCalled();
	expect(await storedReaction()).toBe(false);
});

it('removing a reaction with a counter decrements it only when the reaction exists', async () => {
	await createBuilder(harness, f.owner.token).put(route()).expect(204).execute();
	const key = reactionCounterKey();
	await harness.kvProvider.set(key, '2');
	await createBuilder(harness, f.owner.token).delete(route()).expect(204).execute();
	expect(await harness.kvProvider.get(key)).toBe('1');
	await createBuilder(harness, f.owner.token).delete(route()).expect(204).execute();
	expect(await harness.kvProvider.get(key)).toBe('1');
	expect(await storedReaction()).toBe(false);
});

it('a failed counter existence check never fails the reaction removal', async () => {
	await createBuilder(harness, f.owner.token).put(route()).expect(204).execute();
	const key = reactionCounterKey();
	const error = new Error('Counter unavailable');
	const exists = harness.kvProvider.exists.bind(harness.kvProvider);
	vi.spyOn(harness.kvProvider, 'exists').mockImplementation((candidate) => {
		if (candidate === key) return Promise.reject(error);
		return exists(candidate);
	});
	const check = vi.spyOn(MessageInteractionRepository.prototype, 'checkUserReactionExists');
	const warn = vi.spyOn(Logger.child({}), 'warn');
	await createBuilder(harness, f.owner.token).delete(route()).expect(204).execute();
	expect(check).not.toHaveBeenCalled();
	expect(warn).toHaveBeenCalledWith(expect.objectContaining({error}), expect.any(String));
	expect(await storedReaction()).toBe(false);
});

it('a counter expiring during removal is never reseeded', async () => {
	await createBuilder(harness, f.owner.token).put(route()).expect(204).execute();
	const key = reactionCounterKey();
	await harness.kvProvider.set(key, '2');
	const exists = harness.kvProvider.exists.bind(harness.kvProvider);
	vi.spyOn(harness.kvProvider, 'exists').mockImplementation(async (candidate) => {
		const present = await exists(candidate);
		if (candidate === key) await harness.kvProvider.del(key);
		return present;
	});
	const recount = vi.spyOn(MessageInteractionRepository.prototype, 'countReactionUsersUpTo');
	await createBuilder(harness, f.owner.token).delete(route()).expect(204).execute();
	expect(await harness.kvProvider.get(key)).toBeNull();
	expect(recount).not.toHaveBeenCalled();
	expect(await storedReaction()).toBe(false);
});

it('a reaction through the route on a MicupBOT panel queues one role job', async () => {
	const jobs = vi.spyOn(getWorkerService(), 'addJob').mockResolvedValue(0n);
	await createBuilder(harness, f.owner.token).put(route()).expect(204).execute();
	expect(await storedReaction()).toBe(true);
	expect(jobs).toHaveBeenCalledExactlyOnceWith(
		'applyMicupBotReactionRole',
		{
			kind: 'add',
			guild_id: f.guild.id,
			channel_id: String(f.channelId),
			message_id: messageId,
			user_id: f.owner.userId,
			emoji_name: '🔴',
			emoji_id: null,
			at: expect.any(Number),
		},
		{jobKey: expect.any(String), skipLedger: true},
	);
});

it('a throwing reaction hook never fails the reaction route', async () => {
	const roster = vi.spyOn(RosterHook, 'notifyGuildRosterReaction');
	const jobs = vi.spyOn(getWorkerService(), 'addJob').mockImplementation(() => {
		throw new Error('Synchronous reaction queue failure');
	});
	await createBuilder(harness, f.owner.token).put(route()).expect(204).execute();
	expect(await storedReaction()).toBe(true);
	expect(jobs).toHaveBeenCalledExactlyOnceWith(
		'applyMicupBotReactionRole',
		expect.objectContaining({message_id: messageId, user_id: f.owner.userId}),
		expect.objectContaining({skipLedger: true}),
	);
	expect(roster).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({
			kind: 'add',
			messageId: createMessageID(BigInt(messageId)),
			authorId: createUserID(BigInt(Config.instance.micupBotApplicationId!)),
		}),
	);
});

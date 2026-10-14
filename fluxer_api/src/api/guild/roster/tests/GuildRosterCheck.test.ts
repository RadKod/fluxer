// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {rosterKeys} from '@app/api/database/types/GuildRosterTypes';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {ROSTER_TEXT} from '@app/api/guild/roster/GuildRosterConstants';
import {GuildRosterRuntime} from '@app/api/guild/roster/GuildRosterRuntime';
import {
	ANNOUNCE_AT,
	createRosterFixture,
	HOUR,
	openRoster,
	type RosterFixture,
	START,
} from '@app/api/guild/roster/tests/GuildRosterTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {GatewayTimeoutError} from '@fluxer/errors/src/domains/core/GatewayTimeoutError';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

describe('GuildRosterCheck', () => {
	let harness: ApiTestHarness;
	let f: RosterFixture;
	const originalBotId = Config.instance.rosterBotApplicationId;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		f = await createRosterFixture(harness);
		await openRoster(f);
		f.clock.mockReturnValue(START * 1000);
	});
	afterEach(() => {
		overrideLimits({});
		Config.instance.rosterBotApplicationId = originalBotId;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});
	afterAll(async () => {
		await harness.shutdown();
	});
	const check = () => f.runtime.runSlots('check', HOUR, f.slotStart);
	const final = async () => (await f.roster.readState(f.ref))!.final!;
	it('a member already in the event room is not moved', async () => {
		vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue({channel_id: f.voice.id});
		const move = vi.spyOn(f.deps.gatewayService, 'moveMember');
		await check();
		expect(move).not.toHaveBeenCalled();
		expect((await final()).main).toEqual(f.userIds);
	});
	it('a member in another voice room is moved by the bot', async () => {
		vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue({channel_id: f.otherVoice.id});
		const move = vi.spyOn(f.deps.gatewayService, 'moveMember').mockResolvedValue({success: true});
		expect(await check()).toMatchObject({moved: 2, kicked: 0, kept: 0});
		expect(move).toHaveBeenCalledWith(
			expect.objectContaining({moderatorId: f.botId, userId: f.userIds[0], channelId: f.event.voice_channel_id}),
		);
	});
	it('a member in no voice room is removed', async () => {
		vi.spyOn(f.deps.gatewayService, 'getVoiceState')
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({channel_id: null});
		expect(await check()).toMatchObject({kicked: 2});
		expect((await final()).main).toEqual([]);
	});
	it('a member who left the guild is removed', async () => {
		const absent = createUserID(9000n);
		await f.roster.close(f.ref, {main: [], subs: []});
		const state = (await f.roster.readState(f.ref))!;
		await f.roster.open(f.ref, state);
		f.clock.mockReturnValue(START * 1000 - 1);
		await f.roster.clear(f.ref);
		await f.roster.join(f.ref, absent, 1);
		f.clock.mockReturnValue(START * 1000);
		vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue({channel_id: f.otherVoice.id});
		vi.spyOn(f.deps.gatewayService, 'getUserPermissions').mockResolvedValue(
			Permissions.VIEW_CHANNEL | Permissions.CONNECT,
		);
		expect(await check()).toMatchObject({kicked: 1});
		expect((await final()).main).toEqual([]);
	});
	it('a move refused for permission or hierarchy keeps the member and posts exactly one warning', async () => {
		vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue({channel_id: f.otherVoice.id});
		vi.spyOn(f.deps.gatewayService, 'moveMember').mockResolvedValue({
			success: false,
			error: 'moderator_missing_connect',
		});
		expect(await check()).toMatchObject({kept: 2, kicked: 0, warned: 1});
		expect((await final()).main).toEqual(f.userIds);
		expect(f.send).toHaveBeenCalledTimes(1);
		expect(f.send.mock.calls[0]![0].data).toMatchObject({
			content: ROSTER_TEXT.moveWarning(f.event.name, 2),
			allowed_mentions: {parse: []},
		});
		await check();
		expect(f.send).toHaveBeenCalledTimes(1);
	});
	it('a move that finds the member out of voice removes them', async () => {
		vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue({channel_id: f.otherVoice.id});
		vi.spyOn(f.deps.gatewayService, 'moveMember').mockResolvedValue({success: false, error: 'user_not_in_voice'});
		expect(await check()).toMatchObject({kicked: 2, kept: 0});
		expect((await final()).main).toEqual([]);
	});
	it('subs are not checked and stay as they are', async () => {
		const state = (await f.roster.readState(f.ref))!;
		await f.roster.open(f.ref, {...state, mainSize: 1});
		const voice = vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue(null);
		await check();
		expect(voice.mock.calls.map(([p]) => p.userId)).toEqual([f.userIds[0]]);
		expect((await final()).subs).toEqual([f.userIds[1]]);
	});
	it('removed main members are not refilled from subs', async () => {
		const state = (await f.roster.readState(f.ref))!;
		await f.roster.open(f.ref, {...state, mainSize: 1});
		vi.spyOn(f.deps.gatewayService, 'getVoiceState')
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({channel_id: f.voice.id});
		await check();
		expect(await final()).toEqual({main: [], subs: [f.userIds[1]]});
	});
	it('the roster closes: the embed says it is no longer active and a later ✅ changes nothing', async () => {
		vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue({channel_id: f.voice.id});
		await check();
		expect(f.edit.mock.calls[0]![0].data.embeds![0]!.description).toContain(ROSTER_TEXT.closed);
		expect(f.edit.mock.calls[0]![0].data).not.toHaveProperty('content');
		expect(await f.roster.join(f.ref, createUserID(777n), Date.now())).toBe('closed');
	});
	it('at most 10 moves per second per guild', async () => {
		// Six events in the same guild exercise pacing across event boundaries (12 moves).
		const state = (await f.roster.readState(f.ref))!;
		for (let i = 1; i < 6; i++) {
			const event = {...f.event, event_id: 200n + BigInt(i)};
			await f.repository.create(event);
			const ref = {...f.ref, eventId: event.event_id};
			await f.roster.open(ref, state);
			f.clock.mockReturnValue(START * 1000 - 1);
			for (let member = 0; member < 2; member++)
				await f.roster.join(ref, createUserID(8000n + BigInt(i * 2 + member)), 1);
		}
		f.clock.mockRestore();
		vi.useFakeTimers();
		vi.setSystemTime(START * 1000);
		vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue({channel_id: f.otherVoice.id});
		vi.spyOn(f.deps.gatewayService, 'getUserPermissions').mockResolvedValue(
			Permissions.VIEW_CHANNEL | Permissions.CONNECT,
		);
		const times: Array<number> = [];
		vi.spyOn(f.deps.guildService.members, 'updateMember').mockImplementation(async () => {
			times.push(Date.now());
			return undefined as never;
		});
		const pending = check();
		await vi.runAllTimersAsync();
		await pending;
		expect(times).toHaveLength(12);
		for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(100);
	});
	it('a second check in the hour does nothing', async () => {
		const voice = vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue(null);
		await check();
		voice.mockClear();
		await check();
		expect(voice).not.toHaveBeenCalled();
		expect(f.edit).toHaveBeenCalledTimes(1);
	});
	it('a competing guild check is retried and never runs concurrently', async () => {
		const other = {...f.event, event_id: 201n};
		await f.repository.create(other);
		const ref = {...f.ref, eventId: other.event_id};
		await f.roster.open(ref, (await f.roster.readState(f.ref))!);
		f.clock.mockReturnValue(START * 1000 - 1);
		for (const id of f.userIds) await f.roster.join(ref, id, 1);
		f.clock.mockRestore();
		vi.useFakeTimers();
		vi.setSystemTime(START * 1000);
		vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue({channel_id: f.otherVoice.id});
		const times: Array<number> = [];
		vi.spyOn(f.deps.gatewayService, 'moveMember').mockImplementation(async () => {
			times.push(Date.now());
			return {success: true};
		});
		const second = new GuildRosterRuntime(f.deps, harness.logger);
		const pending = Promise.allSettled([check(), second.runSlots('check', HOUR, f.slotStart)]);
		await vi.runAllTimersAsync();
		const results = await pending;
		expect(results.filter((result) => result.status === 'rejected')).toEqual([
			{status: 'rejected', reason: expect.any(ResourceLockedError)},
		]);
		expect(times).toHaveLength(2);
		for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(100);
	});
	it('a check racing another check is retried instead of silently lost', async () => {
		const key = rosterKeys.check(f.ref.eventId, HOUR);
		await f.deps.kvClient.acquireLock(key, 'render-in-flight', 300);
		await expect(check()).rejects.toBeInstanceOf(ResourceLockedError);
		await f.deps.kvClient.releaseLock(key, 'render-in-flight');
		vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue({channel_id: f.voice.id});
		await check();
		expect((await f.roster.readState(f.ref))?.closed).toBe(true);
	});
	it('a disabled event closes without moves', async () => {
		await f.repository.update({...f.event, enabled: false}, 0);
		const voice = vi.spyOn(f.deps.gatewayService, 'getVoiceState');
		await check();
		expect(voice).not.toHaveBeenCalled();
		expect((await f.roster.readState(f.ref))?.closed).toBe(true);
	});
	it('the tick summary counts moved, removed, kept and warned', async () => {
		vi.spyOn(f.deps.gatewayService, 'getVoiceState')
			.mockResolvedValueOnce(null)
			.mockResolvedValue({channel_id: f.otherVoice.id});
		vi.spyOn(f.deps.gatewayService, 'moveMember').mockResolvedValue({
			success: false,
			error: 'moderator_missing_connect',
		});
		expect(await check()).toMatchObject({events: 1, moved: 0, kicked: 1, kept: 1, warned: 1, failed: 0});
	});
	it('a voice state read that fails keeps the member', async () => {
		vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockRejectedValue(new GatewayTimeoutError());
		expect(await check()).toMatchObject({failed: 2, kicked: 0, kept: 0, warned: 0});
		expect((await final()).main).toEqual(f.userIds);
		expect(f.send).not.toHaveBeenCalled();
	});
	it('a member who cannot see or join the event room is not moved', async () => {
		vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue({channel_id: f.otherVoice.id});
		const permissions = f.deps.gatewayService.getUserPermissions.bind(f.deps.gatewayService);
		vi.spyOn(f.deps.gatewayService, 'getUserPermissions').mockImplementation((params) => {
			if (params.userId === f.userIds[0]) return Promise.resolve(Permissions.CONNECT);
			if (params.userId === f.userIds[1]) return Promise.resolve(Permissions.VIEW_CHANNEL);
			return permissions(params);
		});
		const move = vi.spyOn(f.deps.gatewayService, 'moveMember');
		expect(await check()).toMatchObject({kept: 2, moved: 0, warned: 1});
		expect(move).not.toHaveBeenCalled();
		expect(f.send.mock.calls[0]![0].data.content).toContain('üyelerin etkinlik odasını görme ve bağlanma izinlerini');
		expect(f.send.mock.calls[0]![0].data.content).not.toContain('Botun rolünü');
	});
	it('a member in two rosters of one guild is moved at most once', async () => {
		const other = {...f.event, event_id: 201n};
		await f.repository.create(other);
		const ref = {...f.ref, eventId: other.event_id};
		await f.roster.open(ref, (await f.roster.readState(f.ref))!);
		f.clock.mockReturnValue(ANNOUNCE_AT);
		await f.roster.join(ref, f.userIds[0]!, ANNOUNCE_AT);
		f.clock.mockReturnValue(START * 1000);
		vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue({channel_id: f.otherVoice.id});
		const move = vi.spyOn(f.deps.gatewayService, 'moveMember').mockResolvedValue({success: true});
		await check();
		expect(move.mock.calls.filter(([params]) => params.userId === f.userIds[0])).toHaveLength(1);
	});
	it('switching the feature off mid-check stops moves and kicks but closes and renders', async () => {
		const voice = vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockImplementation(async () => {
			overrideLimits({feature_guild_roster: 0});
			return {channel_id: f.otherVoice.id};
		});
		const move = vi.spyOn(f.deps.gatewayService, 'moveMember').mockResolvedValue({success: true});
		await check();
		expect(voice).toHaveBeenCalledTimes(1);
		expect(move).not.toHaveBeenCalled();
		expect((await f.roster.readState(f.ref))?.closed).toBe(true);
		expect(f.edit).toHaveBeenCalledTimes(1);
		expect((await final()).main).toEqual(f.userIds);
	});
	it('a deleted event room keeps members and reports its own counter and Turkish warning', async () => {
		vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue({channel_id: f.otherVoice.id});
		vi.spyOn(f.deps.gatewayService, 'moveMember').mockResolvedValue({success: false, error: 'channel_not_found'});
		expect(await check()).toMatchObject({kept: 2, kicked: 0, room_deleted: 2, warned: 1});
		expect((await final()).main).toEqual(f.userIds);
		expect(f.send.mock.calls[0]![0].data.content).toContain('Etkinlik odası silinmiş');
		expect(f.send.mock.calls[0]![0].data.content).not.toContain('Botun rolünü');
	});
	it('an early check throws a retryable error', async () => {
		f.clock.mockReturnValue(START * 1000 - 1);
		await expect(check()).rejects.toBeInstanceOf(ResourceLockedError);
	});
	it('the guild check lease is 60 seconds and renews for each target', async () => {
		const acquire = vi.spyOn(f.deps.kvClient, 'acquireLock');
		const extend = vi.spyOn(f.deps.kvClient, 'extendLock');
		vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue(null);
		await check();
		const key = `roster:l:guild:${f.ref.guildId}:check`;
		expect(acquire).toHaveBeenCalledWith(key, expect.any(String), 60);
		expect(extend.mock.calls.filter(([lockKey]) => lockKey === key)).toHaveLength(2);
		expect(extend).toHaveBeenCalledWith(key, expect.any(String), 60);
	});
	it('warning sends reuse the bot user cache across events', async () => {
		const other = {...f.event, event_id: 201n};
		await f.repository.create(other);
		const ref = {...f.ref, eventId: other.event_id};
		await f.roster.open(ref, (await f.roster.readState(f.ref))!);
		f.clock.mockReturnValue(ANNOUNCE_AT);
		await f.roster.join(ref, createUserID(8800n), ANNOUNCE_AT);
		f.clock.mockReturnValue(START * 1000);
		vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue({channel_id: f.otherVoice.id});
		const permissions = f.deps.gatewayService.getUserPermissions.bind(f.deps.gatewayService);
		vi.spyOn(f.deps.gatewayService, 'getUserPermissions').mockImplementation((params) =>
			params.userId === f.botId ? permissions(params) : Promise.resolve(Permissions.VIEW_CHANNEL | Permissions.CONNECT),
		);
		vi.spyOn(f.deps.guildService.members, 'updateMember').mockRejectedValue(new MissingPermissionsError());
		const read = vi.spyOn(f.deps.userRepository, 'findUniqueAssert');
		expect(await check()).toMatchObject({warned: 2});
		expect(read.mock.calls.filter(([id]) => id === f.botId)).toHaveLength(1);
	});
	it('closing render uses the same lock as a normal render', async () => {
		const acquire = vi.spyOn(f.deps.kvClient, 'acquireLock');
		vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue(null);
		await check();
		await f.runtime.render(f.ref);
		expect(acquire.mock.calls.filter(([key]) => key === `roster:l:${f.ref.eventId}:${HOUR}:render`)).toHaveLength(2);
	});
	it('a busy closing render leaves the roster open for retry', async () => {
		const key = `roster:l:${f.ref.eventId}:${HOUR}:render`;
		await f.deps.kvClient.acquireLock(key, 'rendering', 60);
		vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue({channel_id: f.voice.id});
		await expect(check()).rejects.toBeInstanceOf(ResourceLockedError);
		expect((await f.roster.readState(f.ref))?.closed).toBe(false);
		await f.deps.kvClient.releaseLock(key, 'rendering');
		await check();
		expect((await f.roster.readState(f.ref))?.closed).toBe(true);
		expect(f.edit).toHaveBeenCalledTimes(1);
	});
	it('a slow render renews its lease and cannot overlap the final render', async () => {
		f.clock.mockRestore();
		vi.useFakeTimers();
		vi.setSystemTime(START * 1000 - 5000);
		const extend = vi.spyOn(f.deps.kvClient, 'extendLock');
		vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue({channel_id: f.voice.id});
		f.edit.mockImplementationOnce(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20_000));
			return undefined as never;
		});
		const pending = f.runtime.render(f.ref);
		try {
			await vi.advanceTimersByTimeAsync(11_000);
			await expect(check()).rejects.toBeInstanceOf(ResourceLockedError);
			expect((await f.roster.readState(f.ref))?.closed).toBe(false);
			expect(f.edit).toHaveBeenCalledTimes(1);
			expect(extend).toHaveBeenCalledWith(`roster:l:${f.ref.eventId}:${HOUR}:render`, expect.any(String), 10);
		} finally {
			await vi.advanceTimersByTimeAsync(20_000);
			await pending;
		}
		await check();
		expect((await f.roster.readState(f.ref))?.closed).toBe(true);
	});
	it('a dead render lease expires within ten seconds so the check can retry', async () => {
		const acquire = vi.spyOn(f.deps.kvClient, 'acquireLock');
		await f.runtime.render(f.ref);
		const key = `roster:l:${f.ref.eventId}:${HOUR}:render`;
		const ttl = acquire.mock.calls.find(([lockKey]) => lockKey === key)![2];
		await f.deps.kvClient.acquireLock(key, 'dead-worker', ttl);
		f.clock.mockReturnValue(START * 1000 + 11_000);
		vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue({channel_id: f.voice.id});
		await check();
		expect((await f.roster.readState(f.ref))?.closed).toBe(true);
	});
	it('render lease renewal failure is reported and its timer is cleared', async () => {
		f.clock.mockRestore();
		vi.useFakeTimers();
		vi.setSystemTime(START * 1000);
		const error = new Error('renewal unavailable');
		vi.spyOn(f.deps.kvClient, 'extendLock').mockRejectedValue(error);
		f.edit.mockImplementationOnce(async () => {
			await new Promise((resolve) => setTimeout(resolve, 11_000));
			return undefined as never;
		});
		const result = f.runtime.render(f.ref).then(
			() => null,
			(failure: unknown) => failure,
		);
		await vi.advanceTimersByTimeAsync(12_000);
		expect(await result).toBe(error);
		expect(vi.getTimerCount()).toBe(0);
	});
	it.each(['join', 'leave'] as const)(
		'the check snapshot waits for a %s that passed the start guard',
		async (operation) => {
			const added = createUserID(8801n);
			if (operation === 'leave') await f.roster.open(f.ref, {...(await f.roster.readState(f.ref))!, mainSize: 1});
			f.clock.mockReturnValue(START * 1000 - 1);
			let release!: () => void;
			let entered!: () => void;
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			if (operation === 'join') {
				const write = f.deps.kvClient.zadd.bind(f.deps.kvClient);
				vi.spyOn(f.deps.kvClient, 'zadd').mockImplementationOnce(async (...args) => {
					entered();
					await blocked;
					return write(...args);
				});
			} else {
				const write = f.deps.kvClient.zrem.bind(f.deps.kvClient);
				vi.spyOn(f.deps.kvClient, 'zrem').mockImplementationOnce(async (...args) => {
					entered();
					await blocked;
					return write(...args);
				});
			}
			const mutation =
				operation === 'join' ? f.roster.join(f.ref, added, START * 1000 - 1) : f.roster.leave(f.ref, f.userIds[0]!);
			await started;
			f.clock.mockReturnValue(START * 1000);
			let attempting!: () => void;
			const attempted = new Promise<void>((resolve) => {
				attempting = resolve;
			});
			const acquire = f.deps.kvClient.acquireLock.bind(f.deps.kvClient);
			vi.spyOn(f.deps.kvClient, 'acquireLock').mockImplementation(async (key, token, ttl) => {
				if (key === `roster:l:${f.ref.eventId}:${HOUR}:mutate`) attempting();
				return acquire(key, token, ttl);
			});
			const voice = vi.spyOn(f.deps.gatewayService, 'getVoiceState').mockResolvedValue({channel_id: f.voice.id});
			const checking = check();
			try {
				await attempted;
				expect(voice).not.toHaveBeenCalled();
			} finally {
				release();
				await mutation;
				await checking;
			}
			expect(await final()).toEqual(
				operation === 'join' ? {main: f.userIds, subs: [added]} : {main: [f.userIds[1]], subs: []},
			);
		},
	);
});

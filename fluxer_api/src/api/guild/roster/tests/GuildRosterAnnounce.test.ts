// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {rosterKeys} from '@app/api/database/types/GuildRosterTypes';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {rosterComponents} from '@app/api/guild/roster/GuildRosterEmbed';
import {GuildRosterRepository} from '@app/api/guild/roster/GuildRosterRepository';
import {GuildRosterRuntime} from '@app/api/guild/roster/GuildRosterRuntime';
import {
	ANNOUNCE_AT,
	createRosterFixture,
	HOUR,
	type RosterFixture,
	START,
} from '@app/api/guild/roster/tests/GuildRosterTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {UnknownChannelError} from '@fluxer/errors/src/domains/channel/UnknownChannelError';
import {AccessDeniedError} from '@fluxer/errors/src/domains/core/AccessDeniedError';
import {GatewayTimeoutError} from '@fluxer/errors/src/domains/core/GatewayTimeoutError';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import {UnknownGuildError} from '@fluxer/errors/src/domains/guild/UnknownGuildError';
import {UnknownGuildMemberError} from '@fluxer/errors/src/domains/guild/UnknownGuildMemberError';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

describe('GuildRosterAnnounce', () => {
	let harness: ApiTestHarness;
	let f: RosterFixture;
	const originalBotId = Config.instance.rosterBotApplicationId;
	const cards = () => f.send.mock.calls.filter(([params]) => params.components !== undefined);
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		f = await createRosterFixture(harness);
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
	it('queueSlots enqueues 256 jobs keyed by phase, hour and slot', async () => {
		expect(await f.runtime.queueSlots('announce', ANNOUNCE_AT)).toBe(256);
		expect(f.jobs).toHaveBeenCalledTimes(256);
		for (const [i, [task, payload, options]] of f.jobs.mock.calls.entries()) {
			expect([task, payload, options]).toEqual([
				'runGuildRosterSlots',
				{phase: 'announce', hour: HOUR, slot_start: i * 16},
				{jobKey: `announce:${HOUR}:${i * 16}`, skipLedger: true},
			]);
		}
	});
	it('a delayed scheduler just across midnight keeps the intended phase hour', async () => {
		await f.runtime.queueSlots('announce', (HOUR + 1) * 3_600_000 + 4 * 60_000);
		expect(f.jobs.mock.calls[0]![1]).toMatchObject({phase: 'announce', hour: HOUR});
		f.jobs.mockClear();
		await f.runtime.queueSlots('check', (HOUR + 1) * 3_600_000 + 4 * 60_000);
		expect(f.jobs.mock.calls[0]![1]).toMatchObject({phase: 'check', hour: HOUR});
	});
	it('feature off or no bot → no jobs', async () => {
		overrideLimits({feature_guild_roster: 0});
		expect(await f.runtime.queueSlots('check', ANNOUNCE_AT)).toBe(0);
		overrideLimits({feature_guild_roster: 1});
		Config.instance.rosterBotApplicationId = undefined;
		expect(await f.runtime.queueSlots('announce', ANNOUNCE_AT)).toBe(0);
		expect(f.jobs).not.toHaveBeenCalled();
	});
	it('runSlots reads only its 16 slot partitions', async () => {
		const list = vi.spyOn(GuildRosterRepository.prototype, 'listSlot');
		await f.runtime.runSlots('announce', HOUR, f.slotStart);
		expect(list.mock.calls).toEqual(Array.from({length: 16}, (_, i) => [f.slotStart + i, null, 500]));
	});
	it('the roster card carries Join and Leave buttons and no role mention', async () => {
		const result = await f.runtime.runSlots('announce', HOUR, f.slotStart);
		expect(result).toMatchObject({events: 1, sent: 1, failed: 0});
		const card = f.send.mock.calls[0]![0];
		expect(card).toMatchObject({
			user: {id: f.botId},
			channelId: f.event.announce_channel_id,
			components: rosterComponents(false),
		});
		expect(card.data).not.toHaveProperty('content');
		expect(card.data.allowed_mentions).toEqual({parse: []});
		const state = await f.roster.readState(f.ref);
		const message = await f.deps.channelRepository.messages.getMessage(f.event.announce_channel_id, state!.messageId);
		expect(message?.mentionedRoleIds).toEqual(new Set());
		expect(message?.components).toEqual(rosterComponents(false));
		expect(state).toMatchObject({closed: false, startSeconds: START, name: f.event.name});
		expect(await f.roster.lookupMessage(state!.messageId)).toEqual(f.ref);
		expect(await f.deps.kvClient.ttl(rosterKeys.announce(f.ref.eventId, HOUR))).toBe(7200);
	});
	it('the role ping is a separate reply to the card that mentions only that role', async () => {
		await f.runtime.runSlots('announce', HOUR, f.slotStart);
		expect(f.send).toHaveBeenCalledTimes(2);
		const state = (await f.roster.readState(f.ref))!;
		const role = f.event.mention_role_id!;
		const ping = f.send.mock.calls[1]![0];
		expect(ping).toMatchObject({
			user: {id: f.botId},
			channelId: f.event.announce_channel_id,
			data: {
				content: `<@&${role}>`,
				allowed_mentions: {parse: [], roles: [role]},
				message_reference: {
					message_id: state.messageId,
					channel_id: f.event.announce_channel_id,
					guild_id: f.event.guild_id,
				},
			},
		});
		expect(ping.components).toBeUndefined();
		const {message} = await f.send.mock.results[1]!.value;
		expect(message.mentionedRoleIds).toEqual(new Set([role]));
		expect(message.mentionedUserIds).toEqual(new Set());
		expect(message.reference?.messageId).toBe(state.messageId);
	});
	it('without a role there is no ping message', async () => {
		await f.repository.update({...f.event, mention_role_id: null}, 0);
		await f.runtime.runSlots('announce', HOUR, f.slotStart);
		expect(f.send).toHaveBeenCalledTimes(1);
		expect(cards()).toHaveLength(1);
	});
	it('a failed role ping is counted apart from the card', async () => {
		const service = f.deps.channelService.messages.send;
		const original = Object.getPrototypeOf(service).sendMessage as typeof service.sendMessage;
		f.send.mockImplementation(async (params) => {
			if (params.data.message_reference) throw new MissingPermissionsError();
			return original.call(service, params);
		});
		const warn = vi.spyOn(harness.logger, 'warn');
		expect(await f.runtime.runSlots('announce', HOUR, f.slotStart)).toMatchObject({sent: 1, failed: 0, pingFailed: 1});
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({error: expect.any(MissingPermissionsError)}),
			'Roster role ping failed',
		);
		expect(await f.roster.readState(f.ref)).toMatchObject({closed: false});
	});
	it('the first ✅ reaction is still added during the transition', async () => {
		const reaction = vi.spyOn(f.deps.channelService.interactions, 'addReaction');
		await f.runtime.runSlots('announce', HOUR, f.slotStart);
		expect(reaction).toHaveBeenCalledWith(expect.objectContaining({userId: f.botId, emoji: '✅'}));
		expect(await f.roster.members(f.ref)).toEqual([]);
	});
	it('a second run in the same hour sends nothing', async () => {
		await f.runtime.runSlots('announce', HOUR, f.slotStart);
		f.send.mockClear();
		expect(await f.runtime.runSlots('announce', HOUR, f.slotStart)).toMatchObject({sent: 0});
		expect(f.send).not.toHaveBeenCalled();
	});
	it('a disabled event is skipped', async () => {
		await f.repository.update({...f.event, enabled: false}, 0);
		await f.runtime.runSlots('announce', HOUR, f.slotStart);
		expect(f.send).not.toHaveBeenCalled();
	});
	it('a send refused for one event does not stop the others and is counted', async () => {
		await f.repository.create({...f.event, event_id: 201n});
		f.send.mockRejectedValueOnce(new MissingPermissionsError());
		expect(await f.runtime.runSlots('announce', HOUR, f.slotStart)).toMatchObject({events: 2, sent: 1, failed: 1});
		expect(cards()).toHaveLength(2);
	});
	it('an event of a deleted guild is removed', async () => {
		await f.repository.create({...f.event, event_id: 201n, enabled: false});
		f.send.mockRejectedValueOnce(new UnknownGuildError());
		await f.runtime.runSlots('announce', HOUR, f.slotStart);
		expect(await f.repository.listByGuild(f.event.guild_id)).toEqual([]);
	});
	it('an announcement at or after :35 is skipped', async () => {
		f.clock.mockReturnValue(START * 1000);
		await f.runtime.runSlots('announce', HOUR, f.slotStart);
		expect(f.send).not.toHaveBeenCalled();
	});
	it('slot walks page by guild and event and keep the guild sequential across pages', async () => {
		const first = Array.from({length: 500}, (_, i) => ({
			slot: f.slotStart,
			guild_id: f.event.guild_id,
			event_id: BigInt(i),
		}));
		const list = vi.spyOn(GuildRosterRepository.prototype, 'listSlot').mockResolvedValue([]);
		list
			.mockResolvedValueOnce(first)
			.mockResolvedValueOnce([{slot: f.slotStart, guild_id: f.event.guild_id, event_id: 500n}]);
		await f.repository.create({...f.event, event_id: 500n});
		await f.runtime.runSlots('announce', HOUR, f.slotStart);
		expect(list).toHaveBeenNthCalledWith(2, f.slotStart, {guildId: f.event.guild_id, eventId: 499n}, 500);
		expect(cards()).toHaveLength(2);
	});
	it('a late slot walk logs its counters and lag at warning level', async () => {
		const warn = vi.spyOn(harness.logger, 'warn');
		f.clock.mockReturnValue(ANNOUNCE_AT + 31_000);
		await f.runtime.runSlots('announce', HOUR, f.slotStart);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: 'announce',
				hour: HOUR,
				slot_start: f.slotStart,
				events: 1,
				sent: 1,
				lag_ms: 31_000,
			}),
			'Roster slot walk done',
		);
	});
	it('bot users are cached across runtime recreation and expire after a short TTL', async () => {
		const read = vi.spyOn(f.deps.userRepository, 'findUniqueAssert');
		await f.runtime.runSlots('announce', HOUR, f.slotStart);
		const first = await f.send.mock.results[0]!.value;
		f.send.mockResolvedValue(first);
		await f.repository.create({...f.event, event_id: 201n});
		await new GuildRosterRuntime(f.deps, harness.logger).runSlots('announce', HOUR, f.slotStart);
		expect(read.mock.calls.filter(([id]) => id === f.botId)).toHaveLength(1);
		f.clock.mockReturnValue(ANNOUNCE_AT + 61_000);
		await f.repository.create({...f.event, event_id: 202n});
		await new GuildRosterRuntime(f.deps, harness.logger).runSlots('announce', HOUR, f.slotStart);
		expect(read.mock.calls.filter(([id]) => id === f.botId)).toHaveLength(2);
	});
	it.each([
		['bot missing', () => new UnknownGuildMemberError()],
		['bot expelled', () => new AccessDeniedError()],
		['bot user missing', () => new UnknownUserError()],
		['channel missing', () => new UnknownChannelError()],
		['permissions missing', () => new MissingPermissionsError()],
	])('six consecutive permanent failures for %s survive recreation and retry daily', async (_reason, error) => {
		f.send.mockRejectedValue(error());
		for (let i = 0; i < 30; i++) {
			f.clock.mockReturnValue(ANNOUNCE_AT + i * 3_600_000);
			await new GuildRosterRuntime(f.deps, harness.logger).runSlots('announce', HOUR + i, f.slotStart);
		}
		expect(f.send).toHaveBeenCalledTimes(7);
		f.send.mockRestore();
		f.send = vi.spyOn(f.deps.channelService.messages.send, 'sendMessage');
		f.clock.mockReturnValue(ANNOUNCE_AT + 53 * 3_600_000);
		expect(
			await new GuildRosterRuntime(f.deps, harness.logger).runSlots('announce', HOUR + 53, f.slotStart),
		).toMatchObject({sent: 1});
		f.clock.mockReturnValue(ANNOUNCE_AT + 54 * 3_600_000);
		expect(
			await new GuildRosterRuntime(f.deps, harness.logger).runSlots('announce', HOUR + 54, f.slotStart),
		).toMatchObject({sent: 1});
	});
	it('transient failures break the consecutive permanent failure streak', async () => {
		f.send.mockRejectedValue(new MissingPermissionsError());
		for (let i = 0; i < 5; i++) {
			f.clock.mockReturnValue(ANNOUNCE_AT + i * 3_600_000);
			await f.runtime.runSlots('announce', HOUR + i, f.slotStart);
		}
		f.send.mockRejectedValueOnce(new GatewayTimeoutError());
		for (let i = 5; i < 12; i++) {
			f.clock.mockReturnValue(ANNOUNCE_AT + i * 3_600_000);
			await f.runtime.runSlots('announce', HOUR + i, f.slotStart);
		}
		expect(f.send).toHaveBeenCalledTimes(12);
	});
	it('a deleted voice room prevents announcements and is retried daily after six failures', async () => {
		await f.deps.channelRepository.channelData.delete(f.event.voice_channel_id, f.event.guild_id);
		const read = vi.spyOn(f.deps.channelRepository.channelData, 'findUnique');
		for (let i = 0; i < 8; i++) {
			f.clock.mockReturnValue(ANNOUNCE_AT + i * 3_600_000);
			await new GuildRosterRuntime(f.deps, harness.logger).runSlots('announce', HOUR + i, f.slotStart);
		}
		expect(f.send).not.toHaveBeenCalled();
		expect(read.mock.calls.filter(([id]) => id === f.event.voice_channel_id)).toHaveLength(6);
	});
});

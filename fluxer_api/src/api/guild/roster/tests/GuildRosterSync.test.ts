// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {MessageReactionService} from '@app/api/channel/services/interaction/MessageReactionService';
import {rosterKeys} from '@app/api/database/types/GuildRosterTypes';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {type GuildRosterReactionPayload, GuildRosterRuntime} from '@app/api/guild/roster/GuildRosterRuntime';
import {clickRoster} from '@app/api/guild/roster/tests/GuildRosterComponentTestUtils';
import {
	ANNOUNCE_AT,
	createRosterFixture,
	HOUR,
	type RosterFixture,
} from '@app/api/guild/roster/tests/GuildRosterTestUtils';
import {Logger} from '@app/api/Logger';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

describe('GuildRosterSync', () => {
	let harness: ApiTestHarness;
	let f: RosterFixture;
	let payload: GuildRosterReactionPayload;
	const originalBotId = Config.instance.rosterBotApplicationId;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		f = await createRosterFixture(harness);
		await f.runtime.runSlots('announce', HOUR, f.slotStart);
		const state = (await f.roster.readState(f.ref))!;
		payload = {
			kind: 'add',
			guild_id: f.guild.id,
			channel_id: f.systemChannel.id,
			message_id: state.messageId.toString(),
			user_id: f.userIds[0]!.toString(),
			at: ANNOUNCE_AT,
		};
		f.jobs.mockClear();
	});
	afterEach(() => {
		overrideLimits({});
		Config.instance.rosterBotApplicationId = originalBotId;
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness.shutdown();
	});
	it("add then remove processed out of order ends with the reaction's real state", async () => {
		const exists = vi
			.spyOn(f.deps.channelRepository.messageInteractions, 'checkUserReactionExists')
			.mockResolvedValue(false);
		await f.runtime.syncReaction({...payload, kind: 'remove'});
		await f.runtime.syncReaction(payload);
		expect(await f.roster.members(f.ref)).toEqual([]);
		exists.mockResolvedValue(true);
		await f.runtime.syncReaction({...payload, kind: 'remove'});
		expect(await f.roster.members(f.ref)).toEqual([f.userIds[0]]);
	});
	it('sync for an unknown message does nothing', async () => {
		const exists = vi.spyOn(f.deps.channelRepository.messageInteractions, 'checkUserReactionExists');
		await f.runtime.syncReaction({...payload, message_id: '123'});
		expect(exists).not.toHaveBeenCalled();
		expect(f.jobs).not.toHaveBeenCalled();
	});
	it('clear empties the roster and re-renders', async () => {
		for (const id of f.userIds) await f.roster.join(f.ref, id, 1);
		vi.spyOn(f.deps.channelRepository.messageInteractions, 'checkUserReactionExists').mockResolvedValue(false);
		await f.runtime.syncReaction({...payload, kind: 'clear', user_id: undefined});
		expect(await f.roster.members(f.ref)).toEqual([]);
		expect(f.jobs).toHaveBeenCalledWith(
			'renderGuildRosterMessage',
			expect.objectContaining({event_id: '200', hour: HOUR}),
			expect.objectContaining({skipLedger: true}),
		);
	});
	it('clear processed after a later add keeps the member whose ✅ remains', async () => {
		for (const id of f.userIds) await f.roster.join(f.ref, id, 1);
		vi.spyOn(f.deps.channelRepository.messageInteractions, 'checkUserReactionExists').mockImplementation(
			async (_c, _m, userId) => userId === f.userIds[0],
		);
		await f.runtime.syncReaction({...payload, kind: 'clear', user_id: undefined});
		expect(await f.roster.members(f.ref)).toEqual([f.userIds[0]]);
	});
	it('concurrent add/remove ends with the real state', async () => {
		const exists = vi
			.spyOn(f.deps.channelRepository.messageInteractions, 'checkUserReactionExists')
			.mockResolvedValueOnce(true)
			.mockResolvedValue(false);
		await f.runtime.syncReaction(payload);
		expect(await f.roster.members(f.ref)).toEqual([]);
		exists.mockResolvedValueOnce(false).mockResolvedValue(true);
		await f.runtime.syncReaction({...payload, kind: 'remove'});
		expect(await f.roster.members(f.ref)).toEqual([f.userIds[0]]);
	});
	it('sync rejects mismatched guild and channel references', async () => {
		const exists = vi.spyOn(f.deps.channelRepository.messageInteractions, 'checkUserReactionExists');
		await f.runtime.syncReaction({...payload, guild_id: '1'});
		await f.runtime.syncReaction({...payload, channel_id: '2'});
		expect(exists).not.toHaveBeenCalled();
	});
	it('a reaction clear keeps members who joined with the button', async () => {
		expect(await clickRoster(f, f.userIds[0]!, 'roster:join')).toEqual({code: 'roster_joined'});
		await f.roster.join(f.ref, f.userIds[1]!, ANNOUNCE_AT + 1);
		vi.spyOn(f.deps.channelRepository.messageInteractions, 'checkUserReactionExists').mockResolvedValue(false);
		await f.runtime.syncReaction({...payload, kind: 'clear', user_id: undefined});
		expect(await f.roster.members(f.ref)).toEqual([f.userIds[0]]);
	});
	it('removing a reaction does not drop a member who joined with the button', async () => {
		expect(await clickRoster(f, f.userIds[0]!, 'roster:join')).toEqual({code: 'roster_joined'});
		vi.spyOn(f.deps.channelRepository.messageInteractions, 'checkUserReactionExists').mockResolvedValue(false);
		await f.runtime.syncReaction({...payload, kind: 'remove'});
		expect(await f.roster.members(f.ref)).toEqual([f.userIds[0]]);
	});
	it('an old reaction sync that waits on the lock does not drop a member who joined with the button meanwhile', async () => {
		vi.spyOn(f.deps.channelRepository.messageInteractions, 'checkUserReactionExists').mockResolvedValue(false);
		const lock = `roster:l:${f.ref.eventId}:${HOUR}:mutate`;
		const acquire = f.deps.kvClient.acquireLock.bind(f.deps.kvClient);
		let clicked = false;
		// The sync has read the marks and the reaction; its Leave asks for the lock while the Join click holds it.
		vi.spyOn(f.deps.kvClient, 'acquireLock').mockImplementation(async (key, token, ttl) => {
			if (key === lock && !clicked) {
				clicked = true;
				expect(await clickRoster(f, f.userIds[0]!, 'roster:join')).toEqual({code: 'roster_joined'});
			}
			return acquire(key, token, ttl);
		});
		await f.runtime.syncReaction({...payload, kind: 'remove'});
		expect(clicked).toBe(true);
		expect(await f.roster.members(f.ref)).toEqual([f.userIds[0]]);
	});
	it('Leave removes a button member and its mark', async () => {
		await clickRoster(f, f.userIds[0]!, 'roster:join');
		expect(await f.roster.buttonMembers(f.ref)).toEqual(new Set([f.userIds[0]]));
		expect(await clickRoster(f, f.userIds[0]!, 'roster:leave')).toEqual({code: 'roster_left'});
		expect(await f.roster.members(f.ref)).toEqual([]);
		expect(await f.roster.buttonMembers(f.ref)).toEqual(new Set());
	});
	it('a reaction join still works during the transition', async () => {
		vi.spyOn(f.deps.channelRepository.messageInteractions, 'checkUserReactionExists').mockResolvedValue(true);
		await f.runtime.syncReaction(payload);
		expect(await f.roster.members(f.ref)).toEqual([f.userIds[0]]);
		expect(await f.roster.buttonMembers(f.ref)).toEqual(new Set());
	});
	it('Leave after a ✅ reaction removes the reaction and a redelivered sync does not re-add', async () => {
		const state = (await f.roster.readState(f.ref))!;
		const reactions = f.deps.channelRepository.messageInteractions;
		await reactions.addReaction(state.channelId, state.messageId, f.userIds[0]!, '✅');
		await f.runtime.syncReaction(payload);
		expect(await f.roster.members(f.ref)).toEqual([f.userIds[0]]);
		expect(await clickRoster(f, f.userIds[0]!, 'roster:leave')).toEqual({code: 'roster_left'});
		expect(await reactions.checkUserReactionExists(state.channelId, state.messageId, f.userIds[0]!, '✅')).toBe(false);
		await f.runtime.syncReaction(payload);
		expect(await f.roster.members(f.ref)).toEqual([]);
	});
	it('a reaction member who presses Join can still leave by removing ✅', async () => {
		const state = (await f.roster.readState(f.ref))!;
		const reactions = f.deps.channelRepository.messageInteractions;
		await reactions.addReaction(state.channelId, state.messageId, f.userIds[0]!, '✅');
		await f.runtime.syncReaction(payload);
		expect(await clickRoster(f, f.userIds[0]!, 'roster:join')).toEqual({code: 'roster_already_joined'});
		await reactions.removeReaction(state.channelId, state.messageId, f.userIds[0]!, '✅');
		await f.runtime.syncReaction({...payload, kind: 'remove'});
		expect(await f.roster.members(f.ref)).toEqual([]);
	});
	it('Leave before a pending ✅ sync also takes the ✅ back', async () => {
		const state = (await f.roster.readState(f.ref))!;
		await f.deps.channelRepository.messageInteractions.addReaction(
			state.channelId,
			state.messageId,
			f.userIds[0]!,
			'✅',
		);
		expect(await clickRoster(f, f.userIds[0]!, 'roster:leave')).toEqual({code: 'roster_not_joined'});
		await f.runtime.syncReaction(payload);
		expect(await f.roster.members(f.ref)).toEqual([]);
	});
	it('a Leave whose ✅ cannot be removed still answers roster_left and logs', async () => {
		const state = (await f.roster.readState(f.ref))!;
		await f.deps.channelRepository.messageInteractions.addReaction(
			state.channelId,
			state.messageId,
			f.userIds[0]!,
			'✅',
		);
		await f.runtime.syncReaction(payload);
		const error = new Error('reactions are switched off');
		vi.spyOn(MessageReactionService.prototype, 'removeReaction').mockRejectedValue(error);
		const warn = vi.spyOn(Logger.child({}), 'warn');
		expect(await clickRoster(f, f.userIds[0]!, 'roster:leave')).toEqual({code: 'roster_left'});
		expect(await f.roster.members(f.ref)).toEqual([]);
		expect(warn).toHaveBeenCalledWith({error}, 'Roster Leave could not remove the reaction');
	});
	it('the button mark is written in the same transaction as the roster change', async () => {
		const user = f.userIds[0]!.toString();
		const members = rosterKeys.members(f.ref.eventId, HOUR);
		const marks = `roster:b:${f.ref.eventId}:${HOUR}`;
		const [joinWrite, leaveWrite] = [f.deps.kvClient.multi(), f.deps.kvClient.multi()];
		const writes = [
			vi.spyOn(joinWrite, 'zadd'),
			vi.spyOn(joinWrite, 'sadd'),
			vi.spyOn(leaveWrite, 'zrem'),
			vi.spyOn(leaveWrite, 'srem'),
		];
		vi.spyOn(f.deps.kvClient, 'multi').mockReturnValueOnce(joinWrite).mockReturnValueOnce(leaveWrite);
		expect(await clickRoster(f, f.userIds[0]!, 'roster:join')).toEqual({code: 'roster_joined'});
		expect(await clickRoster(f, f.userIds[0]!, 'roster:leave')).toEqual({code: 'roster_left'});
		expect(writes.map((write) => write.mock.calls)).toEqual([
			[[members, expect.any(Number), user]],
			[[marks, user]],
			[[members, user]],
			[[marks, user]],
		]);
	});
	it('a clear sync reads the button marks once and rechecks each leave under the lock', async () => {
		for (const id of f.userIds) await f.roster.join(f.ref, id, 1);
		vi.spyOn(f.deps.channelRepository.messageInteractions, 'checkUserReactionExists').mockResolvedValue(false);
		const marks = `roster:b:${f.ref.eventId}:${HOUR}`;
		const smembers = vi.spyOn(f.deps.kvClient, 'smembers');
		const sismember = vi.spyOn(f.deps.kvClient, 'sismember');
		await f.runtime.syncReaction({...payload, kind: 'clear', user_id: undefined});
		expect(await f.roster.members(f.ref)).toEqual([]);
		expect(smembers.mock.calls.filter(([key]) => key === marks)).toHaveLength(1);
		expect(sismember.mock.calls.filter(([key]) => key === marks)).toHaveLength(f.userIds.length);
	});
	it('render edits only the embed so the role is not pinged again', async () => {
		await f.roster.join(f.ref, f.userIds[0]!, 1);
		await f.runtime.render(f.ref);
		expect(f.edit).toHaveBeenCalledTimes(1);
		expect(Object.keys(f.edit.mock.calls[0]![0].data)).toEqual(['embeds']);
		expect(f.edit.mock.calls[0]![0].data.embeds![0]!.description).toContain(`<@${f.userIds[0]}>`);
	});
	it('30 concurrent reaction syncs keep all 30 distinct members', async () => {
		vi.spyOn(f.deps.channelRepository.messageInteractions, 'checkUserReactionExists').mockResolvedValue(true);
		const ids = Array.from({length: 30}, (_, i) => createUserID(8000n + BigInt(i)));
		await Promise.all(
			ids.map((id, i) => f.runtime.syncReaction({...payload, user_id: id.toString(), at: payload.at + i})),
		);
		expect(await f.roster.members(f.ref)).toEqual(ids);
	});
	it('stored check mark variation selectors are recognized', async () => {
		const state = (await f.roster.readState(f.ref))!;
		await f.deps.channelRepository.messageInteractions.addReaction(
			state.channelId,
			state.messageId,
			f.userIds[0]!,
			'✅\uFE0F',
		);
		await f.runtime.syncReaction(payload);
		expect(await f.roster.members(f.ref)).toEqual([f.userIds[0]]);
	});
	it('no-op syncs do not schedule a render', async () => {
		const exists = vi
			.spyOn(f.deps.channelRepository.messageInteractions, 'checkUserReactionExists')
			.mockResolvedValue(false);
		await f.runtime.syncReaction({...payload, kind: 'remove'});
		await f.runtime.syncReaction({...payload, kind: 'clear', user_id: undefined});
		expect(f.jobs).not.toHaveBeenCalled();
		exists.mockResolvedValue(true);
		await f.runtime.syncReaction(payload);
		f.jobs.mockClear();
		await f.runtime.syncReaction(payload);
		expect(f.jobs).not.toHaveBeenCalled();
	});
	it.each(['add', 'remove', 'clear'] as const)(
		'a committed %s retries its render after the queue fails',
		async (kind) => {
			const exists = vi
				.spyOn(f.deps.channelRepository.messageInteractions, 'checkUserReactionExists')
				.mockResolvedValue(true);
			if (kind !== 'add') {
				await f.runtime.syncReaction(payload);
				exists.mockResolvedValue(false);
			}
			f.jobs.mockClear();
			const error = new Error('queue unavailable');
			f.jobs.mockRejectedValueOnce(error);
			const change = {...payload, kind, user_id: kind === 'clear' ? undefined : payload.user_id};
			await expect(f.runtime.syncReaction(change)).rejects.toBe(error);
			expect(await f.roster.members(f.ref)).toEqual(kind === 'add' ? [f.userIds[0]] : []);
			const retry = new GuildRosterRuntime(f.deps, harness.logger);
			await retry.syncReaction(change);
			expect(f.jobs).toHaveBeenCalledTimes(2);
			await retry.syncReaction(change);
			expect(f.jobs).toHaveBeenCalledTimes(2);
		},
	);
	it.each(['add', 'remove', 'clear'] as const)(
		'a committed %s EXEC with a lost response recovers on retry',
		async (kind) => {
			const exists = vi
				.spyOn(f.deps.channelRepository.messageInteractions, 'checkUserReactionExists')
				.mockResolvedValue(true);
			if (kind !== 'add') {
				await f.runtime.syncReaction(payload);
				exists.mockResolvedValue(false);
			}
			f.jobs.mockClear();
			const change = {...payload, kind, user_id: kind === 'clear' ? undefined : payload.user_id};
			const transaction = f.deps.kvClient.multi();
			const exec = transaction.exec.bind(transaction);
			const error = new Error('EXEC reply lost after commit');
			vi.spyOn(transaction, 'exec').mockImplementationOnce(async () => {
				await exec();
				throw error;
			});
			vi.spyOn(f.deps.kvClient, 'multi').mockReturnValueOnce(transaction);
			await expect(f.runtime.syncReaction(change)).rejects.toBe(error);
			expect(await f.roster.members(f.ref)).toEqual(kind === 'add' ? [f.userIds[0]] : []);
			await new GuildRosterRuntime(f.deps, harness.logger).syncReaction(change);
			expect(f.jobs).toHaveBeenCalledTimes(1);
			if (kind !== 'add') {
				const otherRef = {...f.ref, eventId: 201n};
				await f.roster.open(otherRef, (await f.roster.readState(f.ref))!);
				expect(await f.roster.join(otherRef, f.userIds[0]!, ANNOUNCE_AT + 1)).toBe('joined');
			}
		},
	);
	it('a reaction reread failure does not lose the committed render on retry', async () => {
		const error = new Error('reaction read unavailable');
		vi.spyOn(f.deps.channelRepository.messageInteractions, 'checkUserReactionExists')
			.mockResolvedValueOnce(true)
			.mockRejectedValueOnce(error)
			.mockResolvedValue(true);
		await expect(f.runtime.syncReaction(payload)).rejects.toBe(error);
		expect(await f.roster.members(f.ref)).toEqual([f.userIds[0]]);
		await f.runtime.syncReaction(payload);
		expect(f.jobs).toHaveBeenCalledTimes(1);
	});
	it('a successful enqueue cannot clear a newer pending render token', async () => {
		vi.spyOn(f.deps.channelRepository.messageInteractions, 'checkUserReactionExists').mockResolvedValue(true);
		f.jobs.mockImplementationOnce(async () => {
			await f.roster.join(f.ref, f.userIds[1]!, ANNOUNCE_AT + 1);
			return 0n;
		});
		await f.runtime.syncReaction(payload);
		f.jobs.mockClear();
		await f.runtime.syncReaction(payload);
		expect(f.jobs).toHaveBeenCalledTimes(1);
		await f.runtime.syncReaction(payload);
		expect(f.jobs).toHaveBeenCalledTimes(1);
	});
	it('render does not acquire the mutation or check lock', async () => {
		await f.deps.kvClient.acquireLock(rosterKeys.check(f.ref.eventId, HOUR), 'checking', 300);
		await f.deps.kvClient.acquireLock(`roster:l:${f.ref.eventId}:${HOUR}:mutate`, 'joining', 10);
		await f.runtime.render(f.ref);
		expect(f.edit).toHaveBeenCalledTimes(1);
	});
	it('on-time sync and render do not emit info logs', async () => {
		vi.spyOn(f.deps.channelRepository.messageInteractions, 'checkUserReactionExists').mockResolvedValue(false);
		const info = vi.spyOn(harness.logger, 'info');
		await f.runtime.syncReaction(payload);
		await f.runtime.render(f.ref, ANNOUNCE_AT);
		expect(
			info.mock.calls.filter((call) => {
				const message = (call as Array<unknown>)[1];
				return message === 'Roster reaction sync done' || message === 'Roster render done';
			}),
		).toEqual([]);
	});
	it('a late reaction sync logs its lag at warning level', async () => {
		vi.spyOn(f.deps.channelRepository.messageInteractions, 'checkUserReactionExists').mockResolvedValue(false);
		const warn = vi.spyOn(harness.logger, 'warn');
		f.clock.mockReturnValue(ANNOUNCE_AT + 31_000);
		await f.runtime.syncReaction(payload);
		expect(warn).toHaveBeenCalledWith(expect.objectContaining({lag_ms: 31_000}), 'Roster reaction sync done');
	});
	it('a late render logs lag from its scheduled run time', async () => {
		const warn = vi.spyOn(harness.logger, 'warn');
		f.clock.mockReturnValue(ANNOUNCE_AT + 33_000);
		await f.runtime.render(f.ref, ANNOUNCE_AT + 2000);
		expect(warn).toHaveBeenCalledWith(expect.objectContaining({lag_ms: 31_000}), 'Roster render done');
	});
});

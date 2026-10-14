// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {rosterKeys} from '@app/api/database/types/GuildRosterTypes';
import {ROSTER_STATE_TTL_SECONDS, ROSTER_WAITLIST_MAX} from '@app/api/guild/roster/GuildRosterConstants';
import {splitRoster} from '@app/api/guild/roster/GuildRosterEmbed';
import {GuildRosterService} from '@app/api/guild/roster/GuildRosterService';
import {
	ANNOUNCE_AT,
	OPEN_STATE,
	REF,
	START,
	USER_A,
	USER_B,
	USER_C,
} from '@app/api/guild/roster/tests/GuildRosterTestUtils';
import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import type {WorkerDependencies} from '@app/api/worker/WorkerDependencies';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

describe('GuildRosterService', () => {
	let kv: MockKVProvider;
	let worker: WorkerDependencies['workerService'];
	let roster: GuildRosterService;
	beforeEach(() => {
		vi.spyOn(Date, 'now').mockReturnValue(ANNOUNCE_AT);
		kv = new MockKVProvider();
		worker = new NoopWorkerService();
		roster = new GuildRosterService({kvClient: kv, workerService: worker});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});
	it('join orders by reaction time and a second join keeps the first time', async () => {
		await roster.open(REF, OPEN_STATE);
		expect(await roster.join(REF, USER_B, 20)).toBe('joined');
		await roster.join(REF, USER_A, 10);
		expect(await roster.join(REF, USER_A, 30)).toBe('already');
		expect(await roster.members(REF)).toEqual([USER_A, USER_B]);
	});
	it('a second roster in the same hour is refused as busy', async () => {
		const other = {...REF, eventId: REF.eventId + 1n};
		await roster.open(REF, OPEN_STATE);
		await roster.open(other, OPEN_STATE);
		expect(await roster.join(REF, USER_A, 1)).toBe('joined');
		expect(await roster.join(other, USER_A, 2)).toBe('busy');
		expect(await roster.members(other)).toEqual([]);
	});
	it('concurrent rosters reserve a user only once', async () => {
		const other = {...REF, eventId: REF.eventId + 1n};
		await roster.open(REF, OPEN_STATE);
		await roster.open(other, OPEN_STATE);
		const results = await Promise.all([roster.join(REF, USER_A, 1), roster.join(other, USER_A, 2)]);
		expect(results.sort()).toEqual(['busy', 'joined']);
		expect([...(await roster.members(REF)), ...(await roster.members(other))]).toEqual([USER_A]);
	});
	it.each(['leave', 'clear'] as const)('%s releases the reservation for another roster', async (operation) => {
		const other = {...REF, eventId: REF.eventId + 1n};
		await roster.open(REF, OPEN_STATE);
		await roster.open(other, OPEN_STATE);
		await roster.join(REF, USER_A, 1);
		expect(await roster.join(other, USER_A, 2)).toBe('busy');
		if (operation === 'leave') await roster.leave(REF, USER_A);
		else await roster.clear(REF);
		expect(await roster.join(other, USER_A, 3)).toBe('joined');
	});
	it('an absent leave cannot erase another roster reservation', async () => {
		const other = {...REF, eventId: REF.eventId + 1n};
		await roster.open(REF, OPEN_STATE);
		await roster.open(other, OPEN_STATE);
		await roster.join(REF, USER_A, 1);
		expect(await roster.leave(other, USER_A)).toBe('absent');
		expect(await kv.get(`roster:u:${REF.guildId}:${REF.hour}:${USER_A}`)).toBe(REF.eventId.toString());
		expect(await roster.join(other, USER_A, 2)).toBe('busy');
	});
	it.each(['leave', 'clear'] as const)('%s preserves a reservation acquired by another roster', async (operation) => {
		const key = `roster:u:${REF.guildId}:${REF.hour}:${USER_A}`;
		await roster.open(REF, OPEN_STATE);
		await roster.join(REF, USER_A, 1);
		expect(await kv.get(key)).toBe(REF.eventId.toString());
		await kv.setex(key, ROSTER_STATE_TTL_SECONDS, 'another-roster');
		if (operation === 'leave') await roster.leave(REF, USER_A);
		else await roster.clear(REF);
		expect(await kv.get(key)).toBe('another-roster');
	});
	it('membership and its TTL are written in the same transaction', async () => {
		const transaction = kv.multi();
		const zadd = vi.spyOn(transaction, 'zadd');
		const expire = vi.spyOn(transaction, 'expire');
		vi.spyOn(kv, 'multi').mockReturnValue(transaction);
		await roster.open(REF, OPEN_STATE);
		await roster.join(REF, USER_A, 1);
		const key = rosterKeys.members(REF.eventId, REF.hour);
		expect(zadd).toHaveBeenCalledWith(key, 1, USER_A.toString());
		expect(expire).toHaveBeenCalledWith(key, ROSTER_STATE_TTL_SECONDS);
		expect(await kv.ttl(key)).toBe(ROSTER_STATE_TTL_SECONDS);
	});
	it('a failed transaction command is not reported as a joined member', async () => {
		const transaction = kv.multi();
		const error = new Error('membership write failed');
		vi.spyOn(transaction, 'exec').mockResolvedValue([
			[error, null],
			[null, 0],
		]);
		vi.spyOn(kv, 'multi').mockReturnValue(transaction);
		await roster.open(REF, OPEN_STATE);
		await expect(roster.join(REF, USER_A, 1)).rejects.toBe(error);
	});
	it('retrying an uncertain membership write reuses its own reservation', async () => {
		const transaction = kv.multi();
		const error = new Error('EXEC connection lost');
		vi.spyOn(transaction, 'exec').mockRejectedValueOnce(error);
		vi.spyOn(kv, 'multi').mockReturnValueOnce(transaction);
		await roster.open(REF, OPEN_STATE);
		await expect(roster.join(REF, USER_A, 1)).rejects.toBe(error);
		expect(await kv.get(`roster:u:${REF.guildId}:${REF.hour}:${USER_A}`)).toBe(REF.eventId.toString());
		expect(await roster.join(REF, USER_A, 1)).toBe('joined');
		expect(await roster.members(REF)).toEqual([USER_A]);
	});
	it('mutations use a short lock separate from the check lock', async () => {
		await roster.open(REF, OPEN_STATE);
		const checkKey = rosterKeys.check(REF.eventId, REF.hour);
		await kv.acquireLock(checkKey, 'check-owner', 300);
		await expect(roster.join(REF, USER_A, 1)).resolves.toBe('joined');
		await expect(roster.leave(REF, USER_A)).resolves.toBe('left');
		await roster.clear(REF);
		expect(await kv.get(checkKey)).toBe('check-owner');
		expect(kv.acquireLockSpy).toHaveBeenCalledWith(
			`roster:l:${REF.eventId}:${REF.hour}:mutate`,
			expect.any(String),
			10,
		);
	});
	it('a mutation waits for a busy lock and joins after it is released', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(ANNOUNCE_AT);
		await roster.open(REF, OPEN_STATE);
		const key = `roster:l:${REF.eventId}:${REF.hour}:mutate`;
		await kv.acquireLock(key, 'owner', 10);
		const joined = roster.join(REF, USER_A, 1);
		await vi.advanceTimersByTimeAsync(24);
		expect(await roster.members(REF)).toEqual([]);
		await kv.releaseLock(key, 'owner');
		await vi.advanceTimersByTimeAsync(1);
		expect(await joined).toBe('joined');
	});
	it('a busy mutation lock stops retrying after two seconds', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(ANNOUNCE_AT);
		await roster.open(REF, OPEN_STATE);
		await kv.acquireLock(`roster:l:${REF.eventId}:${REF.hour}:mutate`, 'owner', 10);
		const result = roster.join(REF, USER_A, 1).then(
			() => null,
			(error: unknown) => error,
		);
		await vi.advanceTimersByTimeAsync(2000);
		expect(await result).toBeInstanceOf(ResourceLockedError);
		expect(await roster.members(REF)).toEqual([]);
	});
	it('a click stops waiting for a busy lock after 8 jittered tries', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(ANNOUNCE_AT);
		await roster.open(REF, OPEN_STATE);
		await kv.acquireLock(`roster:l:${REF.eventId}:${REF.hour}:mutate`, 'owner', 10);
		let outcome: unknown;
		void roster.join(REF, USER_A, 1, {messageId: OPEN_STATE.messageId}).then(
			(result) => {
				outcome = result;
			},
			(error: unknown) => {
				outcome = error;
			},
		);
		await vi.advanceTimersByTimeAsync(8 * 50);
		expect(outcome).toBeInstanceOf(ResourceLockedError);
		expect(await roster.members(REF)).toEqual([]);
	});
	it('closing with a check token also waits for the mutation lock', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(ANNOUNCE_AT);
		await roster.open(REF, OPEN_STATE);
		await kv.acquireLock(rosterKeys.check(REF.eventId, REF.hour), 'check-owner', 300);
		const key = `roster:l:${REF.eventId}:${REF.hour}:mutate`;
		await kv.acquireLock(key, 'mutation-owner', 10);
		const closing = roster.close(REF, {main: [], subs: []}, 'check-owner');
		await vi.advanceTimersByTimeAsync(24);
		expect((await roster.readState(REF))?.closed).toBe(false);
		await kv.releaseLock(key, 'mutation-owner');
		await vi.advanceTimersByTimeAsync(1);
		await closing;
		expect((await roster.readState(REF))?.closed).toBe(true);
	});
	it('leave lets the next sub move up into main', async () => {
		await roster.open(REF, {...OPEN_STATE, mainSize: 1});
		await roster.join(REF, USER_A, 1);
		await roster.join(REF, USER_B, 2);
		expect(await roster.leave(REF, USER_A)).toBe('left');
		expect(splitRoster(await roster.members(REF), 1, 1)).toEqual({main: [USER_B], subs: []});
	});
	it('join past main + subs + waitlist is ignored', async () => {
		await roster.open(REF, {...OPEN_STATE, mainSize: 1, subSize: 0});
		for (let i = 0; i <= ROSTER_WAITLIST_MAX; i++) await roster.join(REF, createUserID(BigInt(i + 1)), i);
		expect(await roster.join(REF, USER_C, 100)).toBe('full');
		expect(await roster.members(REF)).toHaveLength(51);
	});
	it('a closed roster ignores join and leave', async () => {
		await roster.open(REF, OPEN_STATE);
		await roster.join(REF, USER_A, 1);
		await roster.close(REF, {main: [USER_A], subs: []});
		expect(await roster.join(REF, USER_B, 2)).toBe('closed');
		expect(await roster.leave(REF, USER_A)).toBe('closed');
		expect((await roster.readState(REF))?.final).toEqual({main: [USER_A], subs: []});
	});
	it('every key carries the 2 hour TTL', async () => {
		await roster.open(REF, OPEN_STATE);
		await roster.join(REF, USER_A, 1);
		for (const key of [
			rosterKeys.state(REF.eventId, REF.hour),
			rosterKeys.message(OPEN_STATE.messageId),
			rosterKeys.members(REF.eventId, REF.hour),
			`roster:u:${REF.guildId}:${REF.hour}:${USER_A}`,
			`roster:d:${REF.eventId}:${REF.hour}`,
		]) {
			expect(await kv.ttl(key)).toBe(ROSTER_STATE_TTL_SECONDS);
		}
		await roster.close(REF, {main: [USER_A], subs: []});
		vi.spyOn(Date, 'now').mockReturnValue(ANNOUNCE_AT + ROSTER_STATE_TTL_SECONDS * 1000 + 1);
		expect(await roster.readState(REF)).toBeNull();
		expect(await roster.lookupMessage(OPEN_STATE.messageId)).toBeNull();
		expect(await roster.members(REF)).toEqual([]);
		expect(await kv.get(`roster:u:${REF.guildId}:${REF.hour}:${USER_A}`)).toBeNull();
	});
	it('no-op membership operations do not mark a render pending', async () => {
		await roster.open(REF, OPEN_STATE);
		const key = `roster:d:${REF.eventId}:${REF.hour}`;
		await roster.leave(REF, USER_A);
		await roster.clear(REF);
		expect(await kv.get(key)).toBeNull();
		await roster.join(REF, USER_A, 1);
		const token = await kv.get(key);
		expect(token).not.toBeNull();
		await roster.join(REF, USER_A, 2);
		await roster.leave(REF, USER_B);
		expect(await kv.get(key)).toBe(token);
	});
	it.each(['leave', 'clear'] as const)('%s propagates transaction command errors', async (operation) => {
		await roster.open(REF, OPEN_STATE);
		await roster.join(REF, USER_A, 1);
		const transaction = kv.multi();
		const error = new Error('mutation command failed');
		vi.spyOn(transaction, 'exec').mockResolvedValue([[error, null]]);
		vi.spyOn(kv, 'multi').mockReturnValueOnce(transaction);
		await expect(operation === 'leave' ? roster.leave(REF, USER_A) : roster.clear(REF)).rejects.toBe(error);
	});
	it.each(['read', 'release'] as const)(
		'a failed uncertain leave cleanup %s preserves the EXEC retry error',
		async (failure) => {
			await roster.open(REF, OPEN_STATE);
			await roster.join(REF, USER_A, 1);
			const transaction = kv.multi();
			const exec = transaction.exec.bind(transaction);
			const error = new Error('EXEC reply lost');
			vi.spyOn(transaction, 'exec').mockImplementationOnce(async () => {
				await exec();
				if (failure === 'read') vi.spyOn(kv, 'zrangebyscore').mockRejectedValueOnce(new Error('cleanup read failed'));
				else {
					const release = kv.releaseLock.bind(kv);
					vi.spyOn(kv, 'releaseLock').mockImplementation(async (key, token) => {
						if (key.startsWith('roster:u:')) throw new Error('cleanup release failed');
						return release(key, token);
					});
				}
				throw error;
			});
			vi.spyOn(kv, 'multi').mockReturnValueOnce(transaction);
			await expect(roster.leave(REF, USER_A)).rejects.toBe(error);
		},
	);
	it('scheduleRender queues one render per 2 s window, run at the window end', async () => {
		const jobs = vi.spyOn(worker, 'addJob');
		for (const at of [4001, 5999, 6000]) await roster.scheduleRender(REF, at);
		expect(jobs.mock.calls.map(([, , options]) => options?.jobKey)).toEqual([
			`${REF.eventId}:${REF.hour}:2`,
			`${REF.eventId}:${REF.hour}:2`,
			`${REF.eventId}:${REF.hour}:3`,
		]);
		expect(jobs.mock.calls.map(([, , options]) => [options?.runAt?.getTime(), options?.skipLedger])).toEqual([
			[6000, true],
			[6000, true],
			[8000, true],
		]);
	});
	it('lookupMessage maps the message to its event and hour', async () => {
		await roster.open(REF, OPEN_STATE);
		expect(await roster.lookupMessage(OPEN_STATE.messageId)).toEqual(REF);
	});
	it('unknown state is never created by a reaction', async () => {
		expect(await roster.join(REF, USER_A, 1)).toBe('unknown');
		expect(await roster.leave(REF, USER_A)).toBe('unknown');
	});
	it('the start boundary closes participation even before the check runs', async () => {
		await roster.open(REF, OPEN_STATE);
		vi.useFakeTimers();
		vi.setSystemTime(START * 1000);
		expect(await roster.join(REF, USER_A, ANNOUNCE_AT)).toBe('closed');
	});
	it('concurrent joins cannot exceed capacity or overwrite the first score', async () => {
		await roster.open(REF, {...OPEN_STATE, mainSize: 1, subSize: 0});
		for (let i = 1; i <= 50; i++) await roster.join(REF, createUserID(BigInt(i)), i);
		await Promise.allSettled([roster.join(REF, USER_A, 100), roster.join(REF, USER_B, 101)]);
		expect(await roster.members(REF)).toHaveLength(51);
	});
});

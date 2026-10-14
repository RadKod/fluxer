// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createMessageID, createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {ROSTER_WAITLIST_MAX} from '@app/api/guild/roster/GuildRosterConstants';
import {rosterComponents, splitRoster} from '@app/api/guild/roster/GuildRosterEmbed';
import {clickRoster} from '@app/api/guild/roster/tests/GuildRosterComponentTestUtils';
import {
	ANNOUNCE_AT,
	createRosterFixture,
	HOUR,
	type RosterFixture,
	START,
} from '@app/api/guild/roster/tests/GuildRosterTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

describe('GuildRosterComponents', () => {
	let harness: ApiTestHarness;
	let f: RosterFixture;
	const originalBotId = Config.instance.rosterBotApplicationId;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		f = await createRosterFixture(harness, 3);
		await f.runtime.runSlots('announce', HOUR, f.slotStart);
		f.jobs.mockClear();
	});
	afterEach(() => {
		overrideLimits({});
		Config.instance.rosterBotApplicationId = originalBotId;
		vi.restoreAllMocks();
	});
	// Records attempts on this roster's event (mutation) lock from now on.
	const eventLocks = () => {
		const spy = vi.spyOn(f.deps.kvClient, 'acquireLock');
		spy.mockClear();
		return Object.assign(() => spy.mock.calls.filter(([key]) => key === `roster:l:${f.ref.eventId}:${HOUR}:mutate`), {
			reset: () => spy.mockClear(),
		});
	};
	afterAll(async () => {
		await harness.shutdown();
	});
	it('Join adds the member and answers roster_joined, the card re-renders within the 2 second window', async () => {
		expect(await clickRoster(f, f.userIds[0]!, 'roster:join')).toEqual({code: 'roster_joined'});
		expect(await f.roster.members(f.ref)).toEqual([f.userIds[0]]);
		const render = f.jobs.mock.calls.find(([task]) => task === 'renderGuildRosterMessage')!;
		expect(render[2]!.runAt!.getTime()).toBeLessThanOrEqual(ANNOUNCE_AT + 2000);
		await f.runtime.render(f.ref);
		const edit = f.edit.mock.lastCall![0];
		expect(edit.components).toEqual(rosterComponents(false));
		expect(edit.data.embeds![0]!.description).toContain(`<@${f.userIds[0]}>`);
	});
	it('a second Join answers roster_already_joined', async () => {
		await clickRoster(f, f.userIds[0]!, 'roster:join');
		expect(await clickRoster(f, f.userIds[0]!, 'roster:join')).toEqual({code: 'roster_already_joined'});
		expect(await f.roster.members(f.ref)).toEqual([f.userIds[0]]);
	});
	it('Leave removes a member and answers roster_left; a later sub moves up as before', async () => {
		for (const [i, id] of f.userIds.entries())
			expect(await clickRoster(f, id, 'roster:join', {atMs: ANNOUNCE_AT + i})).toEqual({code: 'roster_joined'});
		expect(splitRoster(await f.roster.members(f.ref), 2, 1).subs).toEqual([f.userIds[2]]);
		expect(await clickRoster(f, f.userIds[0]!, 'roster:leave')).toEqual({code: 'roster_left'});
		expect(splitRoster(await f.roster.members(f.ref), 2, 1)).toEqual({main: [f.userIds[1], f.userIds[2]], subs: []});
	});
	it('Leave when not on the roster answers roster_not_joined', async () => {
		expect(await clickRoster(f, f.userIds[0]!, 'roster:leave')).toEqual({code: 'roster_not_joined'});
	});
	it('a full roster answers roster_full', async () => {
		for (let i = 0; i < 2 + 1 + ROSTER_WAITLIST_MAX; i++)
			await f.roster.join(f.ref, createUserID(9000n + BigInt(i)), ANNOUNCE_AT + i);
		expect(await clickRoster(f, f.userIds[0]!, 'roster:join')).toEqual({code: 'roster_full'});
		expect(await f.roster.members(f.ref)).not.toContain(f.userIds[0]);
	});
	it('after the start or close Join answers roster_closed', async () => {
		f.clock.mockReturnValue(START * 1000);
		expect(await clickRoster(f, f.userIds[0]!, 'roster:join')).toEqual({code: 'roster_closed'});
		f.clock.mockReturnValue(ANNOUNCE_AT);
		await f.roster.close(f.ref, {main: [], subs: []});
		expect(await clickRoster(f, f.userIds[0]!, 'roster:join')).toEqual({code: 'roster_closed'});
		expect(await f.roster.members(f.ref)).toEqual([]);
		await f.runtime.render(f.ref);
		expect(f.edit.mock.lastCall![0].components).toEqual(rosterComponents(true));
	});
	it('a full roster answers roster_full without taking the event lock', async () => {
		for (let i = 0; i < 2 + 1 + ROSTER_WAITLIST_MAX; i++)
			await f.roster.join(f.ref, createUserID(9000n + BigInt(i)), ANNOUNCE_AT + i);
		const locks = eventLocks();
		expect(await clickRoster(f, f.userIds[0]!, 'roster:join')).toEqual({code: 'roster_full'});
		expect(locks()).toEqual([]);
	});
	it('a closed roster answers roster_closed without taking the event lock', async () => {
		const locks = eventLocks();
		f.clock.mockReturnValue(START * 1000);
		expect(await clickRoster(f, f.userIds[0]!, 'roster:join')).toEqual({code: 'roster_closed'});
		expect(locks()).toEqual([]);
		f.clock.mockReturnValue(ANNOUNCE_AT);
		await f.roster.close(f.ref, {main: [], subs: []});
		locks.reset();
		expect(await clickRoster(f, f.userIds[0]!, 'roster:join')).toEqual({code: 'roster_closed'});
		expect(locks()).toEqual([]);
	});
	it('an already joined member answers without taking the event lock', async () => {
		await clickRoster(f, f.userIds[0]!, 'roster:join');
		const locks = eventLocks();
		expect(await clickRoster(f, f.userIds[0]!, 'roster:join')).toEqual({code: 'roster_already_joined'});
		expect(locks()).toEqual([]);
	});
	it('a member on another roster of the same hour answers roster_busy', async () => {
		const other = {...f.ref, eventId: 201n};
		await f.roster.open(other, {...(await f.roster.readState(f.ref))!, messageId: createMessageID(1n)});
		expect(await f.roster.join(other, f.userIds[0]!, ANNOUNCE_AT)).toBe('joined');
		expect(await clickRoster(f, f.userIds[0]!, 'roster:join')).toEqual({code: 'roster_busy'});
		expect(await f.roster.members(f.ref)).toEqual([]);
	});
	it('a roster ref of another community is never joined', async () => {
		const foreign = {guildId: createGuildID(f.ref.guildId + 1n), eventId: 300n, hour: HOUR};
		// The card's message id now points at a roster of another community.
		await f.roster.open(foreign, (await f.roster.readState(f.ref))!);
		expect(await clickRoster(f, f.userIds[0]!, 'roster:join')).toEqual({code: 'component_unavailable'});
		expect(await f.roster.members(foreign)).toEqual([]);
		expect(await f.roster.members(f.ref)).toEqual([]);
	});
	it('with feature_guild_roster 0 a click answers component_unavailable', async () => {
		overrideLimits({feature_guild_roster: 0});
		expect(await clickRoster(f, f.userIds[0]!, 'roster:join')).toEqual({code: 'component_unavailable'});
		expect(await f.roster.members(f.ref)).toEqual([]);
	});
	it('after the bot leaves the community a click answers component_unavailable', async () => {
		await createBuilder(harness, f.owner.token)
			.delete(`/guilds/${f.guild.id}/members/${f.botId}`)
			.expect(204)
			.execute();
		expect(await clickRoster(f, f.userIds[0]!, 'roster:join')).toEqual({code: 'component_unavailable'});
		expect(await f.roster.members(f.ref)).toEqual([]);
	});
});

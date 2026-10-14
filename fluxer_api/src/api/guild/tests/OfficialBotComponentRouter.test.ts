// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomInt} from 'node:crypto';
import {createChannelID, createGuildID, createUserID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import type {AuthenticatedChannel} from '@app/api/channel/services/AuthenticatedChannel';
import type {ChannelService} from '@app/api/channel/services/ChannelService';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {type OfficialBotComponentClick, routeOfficialBotComponent} from '@app/api/guild/OfficialBotComponentRouter';
import {isOfficialBotInGuild, isOfficialComponentBot} from '@app/api/guild/OfficialBots';
import * as RosterComponents from '@app/api/guild/roster/GuildRosterComponents';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import type {GuildMember} from '@app/api/models/GuildMember';
import type {Message} from '@app/api/models/Message';
import type {User} from '@app/api/models/User';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import type {GuildMemberResponse} from '@fluxer/schema/src/domains/guild/GuildMemberSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest';

const ROSTER_APP = '9001';
const MICUPBOT_APP = '9002';
const ROSTER_BOT = createUserID(9001n);
const MICUPBOT = createUserID(9002n);

let harness: ApiTestHarness;
let originalRosterId: string | undefined;
let originalMicupBotId: string | undefined;
beforeAll(async () => {
	harness = await createApiTestHarness();
});
beforeEach(() => {
	originalRosterId = Config.instance.rosterBotApplicationId;
	originalMicupBotId = Config.instance.micupBotApplicationId;
	Config.instance.rosterBotApplicationId = ROSTER_APP;
	Config.instance.micupBotApplicationId = MICUPBOT_APP;
	overrideLimits({feature_guild_roster: 1, feature_micupbot: 1});
});
afterEach(() => {
	Config.instance.rosterBotApplicationId = originalRosterId;
	Config.instance.micupBotApplicationId = originalMicupBotId;
	vi.restoreAllMocks();
});
afterAll(async () => {
	await harness?.shutdown();
});

function click(authorId: UserID | null, customId: string): OfficialBotComponentClick {
	return {
		viewer: {kind: 'user', userId: createUserID(101n), bot: false, capable: true},
		user: {id: createUserID(101n)} as User,
		guildId: createGuildID(100n),
		channelId: createChannelID(102n),
		message: {authorId, webhookId: null} as Message,
		customId,
		member: {} as GuildMemberResponse,
		authChannel: {} as AuthenticatedChannel,
		channelService: {} as ChannelService,
		requestCache: createRequestCache(),
		atMs: Date.now(),
	};
}

function spyRoster() {
	return vi.spyOn(RosterComponents, 'handleGuildRosterComponent').mockResolvedValue({code: 'roster_joined'});
}

it('a Roster message with a roster: custom_id reaches only the Roster handler', async () => {
	const roster = spyRoster();
	const rosterClick = click(ROSTER_BOT, 'roster:join');
	expect(await routeOfficialBotComponent(rosterClick)).toEqual({code: 'roster_joined'});
	expect(roster).toHaveBeenCalledExactlyOnceWith(rosterClick);
	roster.mockClear();
	expect(await routeOfficialBotComponent(click(MICUPBOT, 'roster:join'))).toEqual({code: 'component_unavailable'});
	expect(roster).not.toHaveBeenCalled();
});

it('a support: custom_id on a Roster message reaches no handler', async () => {
	const roster = spyRoster();
	for (const customId of ['support:open', 'giveaway:enter', 'rosterjoin', 'ROSTER:join'])
		expect(await routeOfficialBotComponent(click(ROSTER_BOT, customId))).toEqual({code: 'component_unavailable'});
	expect(roster).not.toHaveBeenCalled();
});

it('a message by a user who is not a first-party bot reaches no handler', async () => {
	const roster = spyRoster();
	for (const authorId of [createUserID(103n), null])
		expect(await routeOfficialBotComponent(click(authorId, 'roster:join'))).toEqual({code: 'component_unavailable'});
	expect(roster).not.toHaveBeenCalled();
});

it('with no application configured nothing routes', async () => {
	const roster = spyRoster();
	for (const configuredId of [undefined, '', 'not-a-number']) {
		Config.instance.rosterBotApplicationId = configuredId;
		Config.instance.micupBotApplicationId = configuredId;
		expect(await routeOfficialBotComponent(click(ROSTER_BOT, 'roster:join'))).toEqual({code: 'component_unavailable'});
	}
	expect(roster).not.toHaveBeenCalled();
});

it('with the feature flag at 0 the router calls no handler', async () => {
	vi.restoreAllMocks();
	overrideLimits({feature_guild_roster: 0, feature_micupbot: 1});
	const roster = spyRoster();
	expect(await routeOfficialBotComponent(click(ROSTER_BOT, 'roster:join'))).toEqual({code: 'component_unavailable'});
	expect(roster).not.toHaveBeenCalled();
});

it('bot guild membership is cached for 30 seconds per guild', async () => {
	// Unique ids: the cache is process-wide and other files in the worker may use it.
	const base = BigInt(randomInt(1, 2 ** 40)) << 22n;
	const [present, absent] = [createGuildID(base), createGuildID(base + 1n)];
	const getMember = vi.fn(async (guildId: bigint) => (guildId === present ? ({} as GuildMember) : null));
	const repository = {getMember} as unknown as Parameters<typeof isOfficialBotInGuild>[0];
	const start = Date.now();
	const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
	expect(await isOfficialBotInGuild(repository, ROSTER_BOT, present)).toBe(true);
	expect(await isOfficialBotInGuild(repository, ROSTER_BOT, present)).toBe(true);
	expect(await isOfficialBotInGuild(repository, ROSTER_BOT, absent)).toBe(false);
	expect(await isOfficialBotInGuild(repository, ROSTER_BOT, absent)).toBe(false);
	expect(getMember).toHaveBeenCalledTimes(3);
	clock.mockReturnValue(start + 29_999);
	await isOfficialBotInGuild(repository, ROSTER_BOT, present);
	expect(getMember).toHaveBeenCalledTimes(3);
	clock.mockReturnValue(start + 30_000);
	expect(await isOfficialBotInGuild(repository, ROSTER_BOT, present)).toBe(true);
	expect(getMember).toHaveBeenCalledTimes(4);
	expect(getMember).toHaveBeenLastCalledWith(present, ROSTER_BOT);
});

it('a negative bot membership result is not cached', async () => {
	const guildId = createGuildID(BigInt(randomInt(1, 2 ** 40)) << 22n);
	let isMember = false;
	const getMember = vi.fn(async () => (isMember ? ({} as GuildMember) : null));
	const repository = {getMember} as unknown as Parameters<typeof isOfficialBotInGuild>[0];
	expect(await isOfficialBotInGuild(repository, ROSTER_BOT, guildId)).toBe(false);
	isMember = true;
	expect(await isOfficialBotInGuild(repository, ROSTER_BOT, guildId)).toBe(true);
	expect(getMember).toHaveBeenCalledTimes(2);
});

it('MicupBOT cannot write buttons yet', () => {
	expect(isOfficialComponentBot(ROSTER_BOT)).toBe(true);
	expect(isOfficialComponentBot(MICUPBOT)).toBe(false);
});

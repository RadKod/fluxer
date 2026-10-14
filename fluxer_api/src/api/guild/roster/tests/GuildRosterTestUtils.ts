// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createMessageID, createRoleID, createUserID} from '@app/api/BrandedTypes';
import {authorizeBot} from '@app/api/bot/tests/BotTestUtils';
import {Config} from '@app/api/Config';
import {
	createChannel,
	createRole,
	setupTestGuildWithMembers,
	updateRole,
} from '@app/api/channel/tests/ChannelTestUtils';
import {
	type GuildRosterEventRow,
	rosterHourOf,
	rosterSlotOf,
	rosterStartSeconds,
} from '@app/api/database/types/GuildRosterTypes';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {ROSTER_BOT_INVITE_PERMISSIONS} from '@app/api/guild/roster/GuildRosterConstants';
import {GuildRosterRepository} from '@app/api/guild/roster/GuildRosterRepository';
import {GuildRosterRuntime} from '@app/api/guild/roster/GuildRosterRuntime';
import {GuildRosterService} from '@app/api/guild/roster/GuildRosterService';
import {ServiceMiddleware} from '@app/api/middleware/ServiceMiddleware';
import {getGatewayService, getKVClient, getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {getChannelRepository, getLimitConfigService, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {createOAuth2Application} from '@app/api/oauth/tests/OAuth2TestUtils';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import type {WorkerDependencies} from '@app/api/worker/WorkerDependencies';
import {createSnowflake} from '@fluxer/snowflake/src/Snowflake';
import {Hono} from 'hono';
import {vi} from 'vitest';

export const ANNOUNCE_AT = Date.parse('2026-10-02T10:25:00Z');
export const HOUR = rosterHourOf(ANNOUNCE_AT);
export const START = rosterStartSeconds(HOUR);
export const USER_A = createUserID(101n);
export const USER_B = createUserID(102n);
export const USER_C = createUserID(103n);

export function rosterEvent(overrides: Partial<GuildRosterEventRow> = {}): GuildRosterEventRow {
	return {
		guild_id: createGuildID(160n << 22n),
		event_id: 200n,
		name: 'İzmir baskını',
		voice_channel_id: createChannelID(201n),
		announce_channel_id: createChannelID(202n),
		mention_role_id: createRoleID(203n),
		main_size: 2,
		sub_size: 1,
		enabled: true,
		created_by: USER_A,
		created_at: new Date(ANNOUNCE_AT),
		updated_at: new Date(ANNOUNCE_AT),
		version: 0,
		...overrides,
	};
}

export const REF = {guildId: rosterEvent().guild_id, eventId: 200n, hour: HOUR};
export const OPEN_STATE = {
	channelId: rosterEvent().announce_channel_id,
	messageId: createMessageID(createSnowflake({timestamp: ANNOUNCE_AT})),
	name: rosterEvent().name,
	mainSize: 2,
	subSize: 1,
	startSeconds: START,
	announcedAt: ANNOUNCE_AT,
};

export async function createRosterFixture(harness: ApiTestHarness, memberCount = 2) {
	const setup = await setupTestGuildWithMembers(harness, memberCount);
	const app = await createOAuth2Application(harness, setup.owner.token, {name: 'sanalyer Roster'});
	await authorizeBot(
		harness,
		setup.owner.token,
		app.application.id,
		['bot'],
		setup.guild.id,
		ROSTER_BOT_INVITE_PERMISSIONS.toString(),
	);
	const voice = await createChannel(harness, setup.owner.token, setup.guild.id, 'Event room', 2);
	const otherVoice = await createChannel(harness, setup.owner.token, setup.guild.id, 'Other room', 2);
	const role = await createRole(harness, setup.owner.token, setup.guild.id, {name: 'Roster'});
	await updateRole(harness, setup.owner.token, setup.guild.id, role.id, {mentionable: true});
	Config.instance.rosterBotApplicationId = app.application.id;
	overrideLimits({feature_guild_roster: 1});
	const appServices = new Hono<HonoEnv>();
	let channelService!: WorkerDependencies['channelService'];
	let guildService!: WorkerDependencies['guildService'];
	appServices.use(ServiceMiddleware);
	appServices.get('/', (ctx) => {
		channelService = ctx.get('channelService');
		guildService = ctx.get('guildService');
		return ctx.body(null, 204);
	});
	await appServices.request('/');
	const deps = {
		kvClient: getKVClient(),
		workerService: getWorkerService(),
		gatewayService: getGatewayService(),
		channelRepository: getChannelRepository(),
		channelService,
		guildService,
		userRepository: getUserRepository(),
		limitConfigService: getLimitConfigService(),
	} as WorkerDependencies;
	const event = rosterEvent({
		guild_id: createGuildID(BigInt(setup.guild.id)),
		voice_channel_id: createChannelID(BigInt(voice.id)),
		announce_channel_id: createChannelID(BigInt(setup.systemChannel.id)),
		mention_role_id: createRoleID(BigInt(role.id)),
	});
	const repository = new GuildRosterRepository();
	await repository.create(event);
	const runtime = new GuildRosterRuntime(deps, harness.logger);
	const roster = new GuildRosterService(deps);
	const ref = {guildId: event.guild_id, eventId: event.event_id, hour: HOUR};
	const slotStart = Math.floor(rosterSlotOf(event.guild_id) / 16) * 16;
	const send = vi.spyOn(deps.channelService.messages.send, 'sendMessage');
	const edit = vi.spyOn(deps.channelService.messages.edit, 'editMessage');
	const jobs = vi.spyOn(deps.workerService, 'addJob');
	const clock = vi.spyOn(Date, 'now').mockReturnValue(ANNOUNCE_AT);
	return {
		...setup,
		deps,
		event,
		repository,
		runtime,
		roster,
		ref,
		slotStart,
		send,
		edit,
		jobs,
		clock,
		voice,
		otherVoice,
		botId: createUserID(BigInt(app.botUserId)),
		userIds: setup.members.map((m) => createUserID(BigInt(m.userId))),
	};
}
export type RosterFixture = Awaited<ReturnType<typeof createRosterFixture>>;

export async function openRoster(f: RosterFixture) {
	await f.runtime.runSlots('announce', HOUR, f.slotStart);
	f.send.mockClear();
	for (const [i, userId] of f.userIds.entries()) await f.roster.join(f.ref, userId, ANNOUNCE_AT + i);
	return (await f.roster.readState(f.ref))!;
}

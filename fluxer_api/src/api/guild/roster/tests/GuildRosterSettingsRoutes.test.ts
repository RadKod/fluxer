// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createRoleID, createUserID} from '@app/api/BrandedTypes';
import {authorizeBot, createTestBotAccount} from '@app/api/bot/tests/BotTestUtils';
import {Config} from '@app/api/Config';
import {rosterSlotOf} from '@app/api/database/types/GuildRosterTypes';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {GuildRosterRepository} from '@app/api/guild/roster/GuildRosterRepository';
import {
	createRosterSettingsFixture,
	type RosterSettingsFixture,
} from '@app/api/guild/roster/tests/GuildRosterSettingsTestUtils';
import {
	acceptInvite,
	createChannel,
	createChannelInvite,
	createGuild,
	createRole,
} from '@app/api/guild/tests/GuildTestUtils';
import {Logger} from '@app/api/Logger';
import {createOAuth2Application} from '@app/api/oauth/tests/OAuth2TestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';
import type {
	GuildRosterEventListResponse,
	GuildRosterEventResponse,
} from '@fluxer/schema/src/domains/roster/GuildRosterResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

describe('Guild roster settings routes', () => {
	let harness: ApiTestHarness;
	let fixture: RosterSettingsFixture;
	let originalApplicationId: string | undefined;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		originalApplicationId = Config.instance.rosterBotApplicationId;
		await harness.reset();
		fixture = await createRosterSettingsFixture(harness);
	});
	afterEach(() => {
		Config.instance.rosterBotApplicationId = originalApplicationId;
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	const list = () =>
		createBuilder<GuildRosterEventListResponse>(harness, fixture.owner.token).get(fixture.base).execute();
	const patch = (eventId: bigint, body: object) =>
		createBuilder<GuildRosterEventResponse>(harness, fixture.owner.token)
			.patch(`${fixture.base}/${eventId}`)
			.body(body);
	const remove = (eventId: bigint) => createBuilder(harness, fixture.owner.token).delete(`${fixture.base}/${eventId}`);

	async function expectValidation(body: object, path: string, code: string): Promise<void> {
		const result = await createBuilder<{errors: Array<{path: string; code: string}>}>(harness, fixture.owner.token)
			.post(fixture.base)
			.body({...fixture.data, ...body})
			.expect(400, APIErrorCodes.INVALID_FORM_BODY)
			.execute();
		expect(result.errors).toContainEqual(expect.objectContaining({path, code}));
	}

	it('every roster route answers 403 without MANAGE_GUILD', async () => {
		const member = await createTestAccount(harness);
		const invite = await createChannelInvite(harness, fixture.owner.token, fixture.data.announce_channel_id);
		await acceptInvite(harness, member.token, invite.code);
		const row = await fixture.seed();
		for (const request of [
			createBuilder(harness, member.token).get(fixture.base),
			fixture.create(fixture.data, member.token),
			createBuilder(harness, member.token).patch(`${fixture.base}/${row.event_id}`).body({enabled: false}),
			createBuilder(harness, member.token).delete(`${fixture.base}/${row.event_id}`),
		])
			await request.expect(403, APIErrorCodes.MISSING_PERMISSIONS).execute();
		expect(await fixture.repository.get(fixture.guildId, row.event_id)).toEqual(row);
	});

	it('OAuth2 bearer and bot tokens are refused', async () => {
		const oauth = await createBuilder<{token: string}>(harness, '')
			.post('/test/oauth2/access-token')
			.body({user_id: fixture.owner.userId, scopes: ['identify']})
			.execute();
		const bot = await createTestBotAccount(harness);
		for (const token of [`Bearer ${oauth.token}`, `Bot ${bot.botToken}`]) {
			for (const request of [
				createBuilder(harness, token).get(fixture.base),
				fixture.create(fixture.data, token),
				createBuilder(harness, token).patch(`${fixture.base}/1490000000000000002`).body({enabled: false}),
				createBuilder(harness, token).delete(`${fixture.base}/1490000000000000002`),
			])
				await request.expect(403).execute();
		}
	});

	it('the roster bot token is refused', async () => {
		const bot = await createOAuth2Application(harness, fixture.owner.token, {name: 'sanalyer Roster'});
		Config.instance.rosterBotApplicationId = bot.application.id;
		await createBuilder(harness, `Bot ${bot.botToken}`).get('/users/@me').expect(401).execute();
	});

	it('no bot application configured leaves other bot tokens valid', async () => {
		const bot = await createTestBotAccount(harness);
		for (const applicationId of [undefined, '', '1490000000000000001']) {
			Config.instance.rosterBotApplicationId = applicationId;
			const user = await createBuilder<{id: string}>(harness, `Bot ${bot.botToken}`).get('/users/@me').execute();
			expect(user.id).toBe(bot.botUserId);
		}
	});

	it('an event id of another guild answers 404 (no cross-guild read or write)', async () => {
		const row = await fixture.seed();
		const otherGuild = await createGuild(harness, fixture.owner.token, 'Other guild');
		const path = `/guilds/${otherGuild.id}/roster-events`;
		const otherList = await createBuilder<GuildRosterEventListResponse>(harness, fixture.owner.token)
			.get(path)
			.execute();
		expect(otherList.events).toEqual([]);
		await createBuilder(harness, fixture.owner.token)
			.patch(`${path}/${row.event_id}`)
			.body({name: 'Stolen'})
			.expect(404, APIErrorCodes.UNKNOWN_GUILD_ROSTER_EVENT)
			.execute();
		await createBuilder(harness, fixture.owner.token)
			.delete(`${path}/${row.event_id}`)
			.expect(404, APIErrorCodes.UNKNOWN_GUILD_ROSTER_EVENT)
			.execute();
		expect(await fixture.repository.get(fixture.guildId, row.event_id)).toEqual(row);
	});

	it('creates an event and lists it with the bot block and invite_permissions 17910848', async () => {
		const created = await fixture.create({...fixture.data, name: '  Raid  '}).execute();
		expect(created).toMatchObject({
			...fixture.data,
			name: 'Raid',
			guild_id: fixture.guild.id,
			mention_role_id: null,
			main_size: 10,
			sub_size: 5,
			enabled: true,
		});
		expect(Object.keys(created).sort()).toEqual(
			[
				'id',
				'guild_id',
				'name',
				'voice_channel_id',
				'announce_channel_id',
				'mention_role_id',
				'main_size',
				'sub_size',
				'enabled',
				'created_at',
				'updated_at',
			].sort(),
		);
		const stored = await fixture.repository.get(fixture.guildId, BigInt(created.id));
		expect(stored).toMatchObject({created_by: createUserID(BigInt(fixture.owner.userId)), version: 0});
		expect(await list()).toEqual({
			feature_enabled: true,
			bot: {
				application_id: Config.instance.rosterBotApplicationId,
				user_id: Config.instance.rosterBotApplicationId,
				in_guild: false,
			},
			invite_permissions: '17910848',
			max_events: 10,
			events: [created],
		});
	});

	it('GET lists events in event id order', async () => {
		const later = await fixture.seed();
		const earlier = await fixture.seed({event_id: later.event_id - 1n, name: 'Earlier'});
		expect((await list()).events.map((event) => event.id)).toEqual([
			earlier.event_id.toString(),
			later.event_id.toString(),
		]);
	});

	async function expectDisabledWrites(): Promise<void> {
		const row = await fixture.seed();
		for (const request of [fixture.create(), patch(row.event_id, {name: 'Changed'}), remove(row.event_id)]) {
			await request.expect(403, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED).execute();
		}
		expect(await fixture.repository.get(fixture.guildId, row.event_id)).toEqual(row);
		expect((await list()).events).toHaveLength(1);
	}

	it('GET says feature_enabled false and writes answer 403 while feature_guild_roster is 0', async () => {
		overrideLimits({feature_guild_roster: 0});
		expect((await list()).feature_enabled).toBe(false);
		await expectDisabledWrites();
	});

	it('bot is null and writes answer 403 while no bot application is configured', async () => {
		Config.instance.rosterBotApplicationId = undefined;
		expect(await list()).toMatchObject({feature_enabled: false, bot: null});
		await expectDisabledWrites();
	});

	it('bot.in_guild turns true once the bot is a member', async () => {
		const bot = await createOAuth2Application(harness, fixture.owner.token, {name: 'sanalyer Roster'});
		Config.instance.rosterBotApplicationId = bot.application.id;
		expect((await list()).bot?.in_guild).toBe(false);
		await authorizeBot(harness, fixture.owner.token, bot.application.id, ['bot'], fixture.guild.id, '17910848');
		expect((await list()).bot).toEqual({application_id: bot.application.id, user_id: bot.botUserId, in_guild: true});
	});

	it('refuses @everyone as the mention role', async () => {
		await expectValidation(
			{mention_role_id: fixture.guild.id},
			'mention_role_id',
			ValidationErrorCodes.INVALID_ROLE_ID,
		);
	});

	it('refuses a channel or role of another guild', async () => {
		const other = await createGuild(harness, fixture.owner.token, 'Foreign guild');
		const voice = await createChannel(
			harness,
			fixture.owner.token,
			other.id,
			'Foreign voice',
			ChannelTypes.GUILD_VOICE,
		);
		const role = await createRole(harness, fixture.owner.token, other.id, {name: 'Foreign', mentionable: true});
		await expectValidation(
			{voice_channel_id: voice.id},
			'voice_channel_id',
			ValidationErrorCodes.CHANNEL_DOES_NOT_EXIST,
		);
		await expectValidation(
			{announce_channel_id: other.system_channel_id},
			'announce_channel_id',
			ValidationErrorCodes.CHANNEL_DOES_NOT_EXIST,
		);
		await expectValidation({mention_role_id: role.id}, 'mention_role_id', ValidationErrorCodes.INVALID_ROLE_ID);
	});

	it('refuses missing channels and roles', async () => {
		for (const path of ['voice_channel_id', 'announce_channel_id', 'mention_role_id']) {
			await expectValidation(
				{[path]: '1490000000000000099'},
				path,
				path === 'mention_role_id' ? ValidationErrorCodes.INVALID_ROLE_ID : ValidationErrorCodes.CHANNEL_DOES_NOT_EXIST,
			);
		}
	});

	it('refuses a text channel as the event room and a voice channel as the announce channel', async () => {
		await expectValidation(
			{voice_channel_id: fixture.data.announce_channel_id},
			'voice_channel_id',
			ValidationErrorCodes.CHANNEL_MUST_BE_VOICE,
		);
		await expectValidation(
			{announce_channel_id: fixture.voice.id},
			'announce_channel_id',
			ValidationErrorCodes.INVALID_CHANNEL_ID,
		);
	});

	it('the 11th event answers 400 MAX_GUILD_ROSTER_EVENTS', async () => {
		for (let index = 0; index < 9; index++) await fixture.seed();
		await fixture.create().execute();
		await fixture.create().expect(400, APIErrorCodes.MAX_GUILD_ROSTER_EVENTS).execute();
		expect(await fixture.repository.listByGuild(fixture.guildId)).toHaveLength(10);
	});

	it('main_size 0 or 51 and sub_size 26 answer 400', async () => {
		for (const invalid of [{main_size: 0}, {main_size: 51}, {sub_size: 26}]) {
			await fixture
				.create({...fixture.data, ...invalid})
				.expect(400, APIErrorCodes.INVALID_FORM_BODY)
				.execute();
		}
	});

	it('warns when concurrent creates exceed the soft event limit', async () => {
		for (let index = 0; index < 9; index++) await fixture.seed();
		const create = GuildRosterRepository.prototype.create;
		vi.spyOn(GuildRosterRepository.prototype, 'create').mockImplementationOnce(async function (
			this: GuildRosterRepository,
			row,
		) {
			await create.call(this, {...row, event_id: row.event_id + 1n});
			await create.call(this, row);
		});
		const warning = vi.spyOn(Logger.child({}), 'warn');
		await fixture.create().execute();
		expect(await fixture.repository.listByGuild(fixture.guildId)).toHaveLength(11);
		expect(warning).toHaveBeenCalledWith(
			{guild_id: fixture.guild.id, count: 11, max_events: 10},
			'Guild roster event limit exceeded',
		);
		warning.mockClear();
		await fixture.create().expect(400, APIErrorCodes.MAX_GUILD_ROSTER_EVENTS).execute();
		expect(warning).toHaveBeenCalledWith(
			{guild_id: fixture.guild.id, count: 11, max_events: 10},
			'Guild roster event limit exceeded',
		);
	});

	it('a 65 character name answers 400', async () => {
		await fixture
			.create({...fixture.data, name: 'x'.repeat(65)})
			.expect(400, APIErrorCodes.INVALID_FORM_BODY)
			.execute();
	});

	it('PATCH with mention_role_id null removes the mention', async () => {
		const role = await createRole(harness, fixture.owner.token, fixture.guild.id, {name: 'Raiders', mentionable: true});
		const row = await fixture.seed({mention_role_id: createRoleID(BigInt(role.id))});
		const updated = await patch(row.event_id, {mention_role_id: null}).execute();
		expect(updated).toMatchObject({
			name: row.name,
			main_size: row.main_size,
			sub_size: row.sub_size,
			mention_role_id: null,
		});
		expect(await fixture.repository.get(fixture.guildId, row.event_id)).toMatchObject({
			mention_role_id: null,
			version: 1,
		});
	});

	it('PATCH revalidates channel types and guild ownership', async () => {
		const row = await fixture.seed();
		const other = await createGuild(harness, fixture.owner.token, 'Other guild');
		for (const data of [
			{voice_channel_id: fixture.data.announce_channel_id},
			{announce_channel_id: fixture.voice.id},
			{announce_channel_id: other.system_channel_id},
			{mention_role_id: fixture.guild.id},
		]) {
			await patch(row.event_id, data).expect(400, APIErrorCodes.INVALID_FORM_BODY).execute();
		}
		expect(await fixture.repository.get(fixture.guildId, row.event_id)).toEqual(row);
	});

	it('PATCH retries once against the latest row without losing unrelated fields', async () => {
		const row = await fixture.seed();
		const update = GuildRosterRepository.prototype.update;
		const write = vi.spyOn(GuildRosterRepository.prototype, 'update').mockImplementationOnce(async function (
			this: GuildRosterRepository,
			next,
			version,
		) {
			await update.call(this, {...next, name: 'Concurrent', main_size: 23}, version);
			return false;
		});
		const result = await patch(row.event_id, {name: 'Requested', sub_size: 0, enabled: false}).execute();
		expect(result).toMatchObject({name: 'Requested', main_size: 23, sub_size: 0, enabled: false});
		expect(write).toHaveBeenCalledTimes(2);
		expect(await fixture.repository.get(fixture.guildId, row.event_id)).toMatchObject({version: 2});
	});

	it('PATCH returns 409 after two version conflicts', async () => {
		const row = await fixture.seed();
		const update = vi.spyOn(GuildRosterRepository.prototype, 'update').mockResolvedValue(false);
		await patch(row.event_id, {name: 'Changed'}).expect(409, APIErrorCodes.CONFLICT).execute();
		expect(update).toHaveBeenCalledTimes(2);
		expect(await fixture.repository.get(fixture.guildId, row.event_id)).toEqual(row);
	});

	it('PATCH returns 404 if the event disappears before the retry', async () => {
		const row = await fixture.seed();
		vi.spyOn(GuildRosterRepository.prototype, 'update').mockImplementationOnce(async () => {
			await fixture.repository.delete(fixture.guildId, row.event_id);
			return false;
		});
		await patch(row.event_id, {name: 'Changed'}).expect(404, APIErrorCodes.UNKNOWN_GUILD_ROSTER_EVENT).execute();
		expect(await fixture.repository.get(fixture.guildId, row.event_id)).toBeNull();
	});

	it('DELETE removes the event and its slot row', async () => {
		const row = await fixture.seed();
		await remove(row.event_id).expect(204).execute();
		expect(await fixture.repository.get(fixture.guildId, row.event_id)).toBeNull();
		expect(await fixture.repository.listSlot(rosterSlotOf(fixture.guildId), null, 10)).toEqual([]);
		await remove(row.event_id).expect(404, APIErrorCodes.UNKNOWN_GUILD_ROSTER_EVENT).execute();
	});
	it('DELETE retry cleans a remaining slot before returning 404', async () => {
		const row = await fixture.seed();
		const execute = InMemoryCassandraQueryExecutor.prototype.executeQuery;
		const database = vi
			.spyOn(InMemoryCassandraQueryExecutor.prototype, 'executeQuery')
			.mockImplementation(async function (this: InMemoryCassandraQueryExecutor, query) {
				if (query.kvMeta?.action === 'delete' && query.kvMeta.table.name === 'guild_roster_events_by_slot') {
					throw new ServiceUnavailableError();
				}
				return execute.call(this, query);
			} as typeof execute);
		await remove(row.event_id).expect(503).execute();
		expect(await fixture.repository.get(fixture.guildId, row.event_id)).toBeNull();
		expect(await fixture.repository.listSlot(rosterSlotOf(fixture.guildId), null, 10)).toHaveLength(1);
		database.mockRestore();
		await remove(row.event_id).expect(404, APIErrorCodes.UNKNOWN_GUILD_ROSTER_EVENT).execute();
		expect(await fixture.repository.listSlot(rosterSlotOf(fixture.guildId), null, 10)).toEqual([]);
	});
});

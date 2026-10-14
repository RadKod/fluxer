// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs} from '@app/api/auth/tests/AuthTestUtils';
import {createChannelID, createGuildID, createInviteCode, type GuildID, type InviteCode} from '@app/api/BrandedTypes';
import {executeConditional, upsertOne} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import {GuildDataHelpers} from '@app/api/guild/services/data/GuildDataHelpers';
import {createGuild} from '@app/api/guild/tests/GuildTestUtils';
import {InviteRepository} from '@app/api/invite/InviteRepository';
import {Invites, InvitesByGuild} from '@app/api/Tables';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {InviteTypes} from '@fluxer/constants/src/ChannelConstants';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

describe('Guild vanity URL race', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function createVanityGuild(name: string) {
		const owner = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, name);
		await createBuilder(harness, '')
			.post(`/test/guilds/${guild.id}/features`)
			.body({add_features: [GuildFeatures.VANITY_URL]})
			.execute();
		return {owner, guild};
	}

	function holdLookupsUntil(code: string, callers: number): void {
		const findUnique = InviteRepository.prototype.findUnique;
		let arrived = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(InviteRepository.prototype, 'findUnique').mockImplementation(async function (
			this: InviteRepository,
			inviteCode: InviteCode,
		) {
			if (inviteCode === code) {
				arrived += 1;
				if (arrived === callers) release();
				await gate;
			}
			return findUnique.call(this, inviteCode);
		});
	}

	function holdVanityRequestsUntil(callers: number): void {
		const getGuildAuthenticated = GuildDataHelpers.prototype.getGuildAuthenticated;
		let arrived = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(GuildDataHelpers.prototype, 'getGuildAuthenticated').mockImplementation(async function (
			this: GuildDataHelpers,
			params,
		) {
			arrived += 1;
			if (arrived === callers) release();
			await gate;
			return getGuildAuthenticated.call(this, params);
		});
	}

	function patchVanity(token: string, guildId: string, code: string | null) {
		return createBuilder<{code?: string; errors?: Array<{code: string}>}>(harness, token)
			.patch(`/guilds/${guildId}/vanity-url`)
			.body({code});
	}

	async function guildInviteCodes(guildId: string): Promise<Array<string>> {
		const invites = await new InviteRepository().listGuildInvites(createGuildID(BigInt(guildId)));
		return invites.map((invite) => invite.code);
	}

	async function guildVanity(guildId: string): Promise<string | null> {
		return (await new GuildRepository().findUnique(createGuildID(BigInt(guildId))))?.vanityUrlCode ?? null;
	}

	async function createVanityAdmin() {
		const admin = await createTestAccount(harness);
		await setUserACLs(harness, admin, ['admin:authenticate', 'guild:update:vanity']);
		return admin;
	}

	function adminPatchVanity(token: string, guildId: string, code: string | null) {
		return createBuilder<{errors?: Array<{code: string}>}>(harness, token)
			.patch(`/admin/guilds/${guildId}`)
			.body({vanity_url_code: code});
	}

	it('lets exactly one of two guilds claim the same code', async () => {
		const code = 'racecode';
		const a = await createVanityGuild('Vanity Race A');
		const b = await createVanityGuild('Vanity Race B');
		holdLookupsUntil(code, 2);

		const results = await Promise.all(
			[a, b].map(({owner, guild}) =>
				createBuilder<{code?: string; errors?: Array<{code: string}>}>(harness, owner.token)
					.patch(`/guilds/${guild.id}/vanity-url`)
					.body({code})
					.executeRaw(),
			),
		);

		const statuses = results.map(({response}) => response.status).sort();
		expect(statuses).toEqual([200, 400]);
		const winner = results[0].response.status === 200 ? a : b;
		const loser = winner === a ? results[1] : results[0];
		expect(loser.json.errors?.[0]?.code).toBe(ValidationErrorCodes.VANITY_URL_CODE_ALREADY_TAKEN);

		vi.restoreAllMocks();
		const invite = await new InviteRepository().findUnique(createInviteCode(code));
		expect(invite?.guildId?.toString()).toBe(winner.guild.id);
	});

	it('keeps the old code when the new one was claimed after the lookup', async () => {
		const a = await createVanityGuild('Vanity Keep A');
		const b = await createVanityGuild('Vanity Keep B');
		await createBuilder(harness, a.owner.token)
			.patch(`/guilds/${a.guild.id}/vanity-url`)
			.body({code: 'oldcode'})
			.execute();
		await createBuilder(harness, b.owner.token)
			.patch(`/guilds/${b.guild.id}/vanity-url`)
			.body({code: 'takencode'})
			.execute();
		const findUnique = InviteRepository.prototype.findUnique;
		vi.spyOn(InviteRepository.prototype, 'findUnique').mockImplementation(async function (
			this: InviteRepository,
			inviteCode: InviteCode,
		) {
			return inviteCode === 'takencode' ? null : findUnique.call(this, inviteCode);
		});

		await createBuilder(harness, a.owner.token)
			.patch(`/guilds/${a.guild.id}/vanity-url`)
			.body({code: 'takencode'})
			.expect(400, 'INVALID_FORM_BODY')
			.execute();

		vi.restoreAllMocks();
		const repository = new InviteRepository();
		expect((await repository.findUnique(createInviteCode('oldcode')))?.guildId?.toString()).toBe(a.guild.id);
		expect((await repository.findUnique(createInviteCode('takencode')))?.guildId?.toString()).toBe(b.guild.id);
	});

	it('creates a code at most once under concurrent conditional inserts', async () => {
		const repository = new InviteRepository();
		const code = createInviteCode('atomiccode');
		const guildIds = Array.from({length: 20}, (_, i) => createGuildID(BigInt(1000 + i)));

		const applied = await Promise.all(
			guildIds.map((guild_id) =>
				repository.createIfAbsent({
					code,
					type: InviteTypes.GUILD,
					guild_id,
					channel_id: null,
					inviter_id: null,
					uses: 0,
					max_uses: 0,
					max_age: 0,
				}),
			),
		);

		expect(applied.filter(Boolean)).toHaveLength(1);
		const winner = guildIds[applied.indexOf(true)];
		expect((await repository.findUnique(code))?.guildId).toBe(winner);
		for (const guildId of guildIds) {
			const codes = (await repository.listGuildInvites(guildId)).map((invite) => invite.code);
			expect(codes).toEqual(guildId === winner ? [code] : []);
		}
	});

	it('lets exactly one guild take over an unowned row and never takes an owned one', async () => {
		const repository = new InviteRepository();
		const code = createInviteCode('leftoveruses');
		// What a join's use count leaves behind when it lands after the code was released.
		await upsertOne(Invites.patchByPk({code}, {uses: Db.set(3)}));
		const claim = (guild_id: GuildID) =>
			repository.createIfAbsent({
				code,
				type: InviteTypes.GUILD,
				guild_id,
				channel_id: null,
				inviter_id: null,
				uses: 0,
				max_uses: 0,
				max_age: 0,
			});
		const guildIds = Array.from({length: 20}, (_, i) => createGuildID(BigInt(2000 + i)));

		const applied = await Promise.all(guildIds.map(claim));

		expect(applied.filter(Boolean)).toHaveLength(1);
		const winner = guildIds[applied.indexOf(true)];
		expect(await repository.findUnique(code)).toMatchObject({
			guildId: winner,
			channelId: null,
			type: InviteTypes.GUILD,
			uses: 0,
		});
		expect((await repository.listGuildInvites(winner)).map((invite) => invite.code)).toEqual([code]);
		expect(await claim(createGuildID(3000n))).toBe(false);
		expect((await repository.findUnique(code))?.guildId).toBe(winner);

		const groupDmCode = createInviteCode('groupdmcode');
		const groupDmChannel = createChannelID(4000n);
		await executeConditional(
			Invites.insertIfNotExists({
				code: groupDmCode,
				type: InviteTypes.GROUP_DM,
				guild_id: null,
				channel_id: groupDmChannel,
				inviter_id: null,
				created_at: new Date(),
				uses: 1,
				max_uses: 0,
				max_age: 0,
				temporary: false,
				version: 1,
			}),
		);
		expect(
			await repository.createIfAbsent({
				code: groupDmCode,
				type: InviteTypes.GUILD,
				guild_id: winner,
				channel_id: null,
				uses: 0,
				max_uses: 0,
				max_age: 0,
			}),
		).toBe(false);
		expect((await repository.findUnique(groupDmCode))?.channelId).toBe(groupDmChannel);
	});

	it('lets another guild claim a code whose release raced a join', async () => {
		const code = createInviteCode('ghostcode');
		const a = await createVanityGuild('Vanity Ghost A');
		const b = await createVanityGuild('Vanity Ghost B');
		const joiner = await createTestAccount(harness);
		await patchVanity(a.owner.token, a.guild.id, code).expect(200).execute();
		const updateInviteUses = InviteRepository.prototype.updateInviteUses;
		let arrive!: () => void;
		const arrived = new Promise<void>((resolve) => {
			arrive = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(InviteRepository.prototype, 'updateInviteUses').mockImplementation(async function (
			this: InviteRepository,
			...args
		) {
			arrive();
			await gate;
			return updateInviteUses.apply(this, args);
		});

		const join = createBuilder(harness, joiner.token).post(`/invites/${code}`).body(null).executeRaw();
		await arrived;
		await patchVanity(a.owner.token, a.guild.id, null).expect(200).execute();
		release();
		await join;
		vi.restoreAllMocks();
		const leftover = await new InviteRepository().findUnique(code);
		expect(leftover).not.toBeNull();
		expect(leftover?.guildId).toBeNull();

		await patchVanity(b.owner.token, b.guild.id, code).expect(200).execute();

		expect((await new InviteRepository().findUnique(code))?.guildId?.toString()).toBe(b.guild.id);
		expect(await guildInviteCodes(b.guild.id)).toEqual([code]);
	});

	it.each([
		[
			'the index write',
			() =>
				vi.spyOn(InvitesByGuild, 'insert').mockImplementationOnce(() => {
					throw new Error('index write failed');
				}),
		],
		[
			'the guild update',
			() =>
				vi.spyOn(GuildRepository.prototype, 'upsertPartial').mockRejectedValueOnce(new Error('guild update failed')),
		],
	])('releases the claim when %s fails, so the same guild can retry', async (_step, failOnce) => {
		const {owner, guild} = await createVanityGuild('Vanity Retry');
		failOnce();

		const failed = await patchVanity(owner.token, guild.id, 'retrycode').executeRaw();
		expect(failed.response.status).toBe(500);
		vi.restoreAllMocks();
		expect(await new InviteRepository().findUnique(createInviteCode('retrycode'))).toBeNull();

		await patchVanity(owner.token, guild.id, 'retrycode').expect(200).execute();
		expect((await new InviteRepository().findUnique(createInviteCode('retrycode')))?.guildId?.toString()).toBe(
			guild.id,
		);
		expect(await guildInviteCodes(guild.id)).toEqual(['retrycode']);
	});

	it('completes its own claim left behind by an interrupted request', async () => {
		const {owner, guild} = await createVanityGuild('Vanity Leftover');
		const other = await createVanityGuild('Vanity Leftover Other');
		const code = createInviteCode('leftovercode');
		await executeConditional(
			Invites.insertIfNotExists({
				code,
				type: InviteTypes.GUILD,
				guild_id: createGuildID(BigInt(guild.id)),
				channel_id: null,
				inviter_id: null,
				created_at: new Date(),
				uses: 0,
				max_uses: 0,
				max_age: 0,
				temporary: false,
				version: 1,
			}),
		);

		await patchVanity(other.owner.token, other.guild.id, code).expect(400, 'INVALID_FORM_BODY').execute();
		await patchVanity(owner.token, guild.id, code).expect(200).execute();

		expect((await new InviteRepository().findUnique(code))?.guildId?.toString()).toBe(guild.id);
		expect(await guildInviteCodes(guild.id)).toEqual([code]);
	});

	it.each([null, 'movedcode'])('keeps a code another guild now holds when changing to %s', async (next) => {
		const a = await createVanityGuild('Vanity Stale A');
		const b = await createVanityGuild('Vanity Stale B');
		const stale = createInviteCode('stalecode');
		await patchVanity(a.owner.token, a.guild.id, stale).expect(200).execute();
		await new InviteRepository().delete(stale);
		await patchVanity(b.owner.token, b.guild.id, stale).expect(200).execute();

		await patchVanity(a.owner.token, a.guild.id, next).expect(200).execute();

		expect((await new InviteRepository().findUnique(stale))?.guildId?.toString()).toBe(b.guild.id);
	});

	it('leaves no unowned claim when one guild requests two codes at once', async () => {
		const {owner, guild} = await createVanityGuild('Vanity Pair');
		const codes = ['paircodex', 'paircodey'];
		holdVanityRequestsUntil(codes.length);

		const results = await Promise.all(codes.map((code) => patchVanity(owner.token, guild.id, code).executeRaw()));

		for (const {response} of results) {
			expect([200, 423]).toContain(response.status);
		}
		vi.restoreAllMocks();
		const vanity = (await new GuildRepository().findUnique(createGuildID(BigInt(guild.id))))?.vanityUrlCode;
		expect(codes).toContain(vanity);
		expect(await guildInviteCodes(guild.id)).toEqual([vanity]);
		for (const code of codes) {
			const invite = await new InviteRepository().findUnique(createInviteCode(code));
			expect(invite?.guildId?.toString()).toBe(code === vanity ? guild.id : undefined);
		}
	});

	function holdFirstLookupAfterRead(code: string) {
		const findUnique = InviteRepository.prototype.findUnique;
		let held = false;
		let arrive!: () => void;
		const arrived = new Promise<void>((resolve) => {
			arrive = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(InviteRepository.prototype, 'findUnique').mockImplementation(async function (
			this: InviteRepository,
			inviteCode: InviteCode,
		) {
			const invite = await findUnique.call(this, inviteCode);
			if (inviteCode === code && !held) {
				held = true;
				arrive();
				await gate;
			}
			return invite;
		});
		return {arrived, release};
	}

	it('does not let an admin overwrite a code a guild claimed after the admin looked it up', async () => {
		const code = 'panelcode';
		const a = await createVanityGuild('Vanity Admin A');
		const b = await createVanityGuild('Vanity Admin B');
		const admin = await createVanityAdmin();
		const lookup = holdFirstLookupAfterRead(code);

		const staffRequest = adminPatchVanity(admin.token, b.guild.id, code).executeRaw();
		await lookup.arrived;
		await patchVanity(a.owner.token, a.guild.id, code).expect(200).execute();
		lookup.release();
		const staff = await staffRequest;

		expect(staff.response.status).toBe(400);
		expect(staff.json.errors?.[0]?.code).toBe(ValidationErrorCodes.THIS_VANITY_URL_IS_ALREADY_TAKEN);
		vi.restoreAllMocks();
		expect((await new InviteRepository().findUnique(createInviteCode(code)))?.guildId?.toString()).toBe(a.guild.id);
		expect(await guildVanity(a.guild.id)).toBe(code);
		expect(await guildVanity(b.guild.id)).toBeNull();
	});

	it('makes an admin change wait for the guild change in progress', async () => {
		const {owner, guild} = await createVanityGuild('Vanity Admin Same');
		const admin = await createVanityAdmin();
		const lookup = holdFirstLookupAfterRead('ownercode');

		const ownerRequest = patchVanity(owner.token, guild.id, 'ownercode').executeRaw();
		await lookup.arrived;
		const staff = await adminPatchVanity(admin.token, guild.id, 'crewcode').executeRaw();
		lookup.release();
		const ownerResult = await ownerRequest;

		expect(staff.response.status).toBe(423);
		expect(ownerResult.response.status).toBe(200);
		vi.restoreAllMocks();
		expect(await guildVanity(guild.id)).toBe('ownercode');
		expect(await guildInviteCodes(guild.id)).toEqual(['ownercode']);
		expect(await new InviteRepository().findUnique(createInviteCode('crewcode'))).toBeNull();
	});

	it.each(['micupdestek', 'micup-resmi', 'login', 'destek', 'resmi-destek', 'm1cup', 'epha'])(
		'refuses the reserved code %s for the guild and for an admin',
		async (code) => {
			const {owner, guild} = await createVanityGuild('Vanity Reserved');
			const admin = await createVanityAdmin();

			const byOwner = await patchVanity(owner.token, guild.id, code).expect(400, 'INVALID_FORM_BODY').execute();
			const byAdmin = await adminPatchVanity(admin.token, guild.id, code).expect(400, 'INVALID_FORM_BODY').execute();

			expect(byOwner.errors?.[0]?.code).toBe(ValidationErrorCodes.VANITY_URL_CODE_RESERVED);
			expect(byAdmin.errors?.[0]?.code).toBe(ValidationErrorCodes.VANITY_URL_CODE_RESERVED);
			expect(await new InviteRepository().findUnique(createInviteCode(code))).toBeNull();
			expect(await guildVanity(guild.id)).toBeNull();
		},
	);

	it.each(['oyuncular', 'badminton'])('accepts the ordinary code %s', async (code) => {
		const {owner, guild} = await createVanityGuild('Vanity Ordinary');

		await patchVanity(owner.token, guild.id, code).expect(200).execute();

		expect(await guildVanity(guild.id)).toBe(code);
	});
});

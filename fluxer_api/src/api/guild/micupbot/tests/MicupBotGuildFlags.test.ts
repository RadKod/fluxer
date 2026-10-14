// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createGuildID, createUserID} from '@app/api/BrandedTypes';
import type {MicupBotGuildSettingsRow} from '@app/api/database/types/MicupBotTypes';
import {desiredMicupBotFlags, syncMicupBotGuildFlags} from '@app/api/guild/micupbot/MicupBotGuildFlags';
import * as MemberHooks from '@app/api/guild/micupbot/MicupBotMemberHooks';
import {MicupBotRepository} from '@app/api/guild/micupbot/MicupBotRepository';
import {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import {acceptInvite, createChannelInvite, createGuild} from '@app/api/guild/tests/GuildTestUtils';
import {getGatewayService} from '@app/api/middleware/ServiceRegistry';
import {getCacheService, getGuildBoostService, removeGuildMemberCounted} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {afterAll, afterEach, beforeAll, expect, it, vi} from 'vitest';

let harness: ApiTestHarness;
const repository = new MicupBotRepository(),
	guildRepository = new GuildRepository();
const flags = ['MICUPBOT_COMMANDS', 'MICUPBOT_LEVELS', 'MICUPBOT_AUTOMOD', 'MICUPBOT_JOIN'];
const row = (guildId: ReturnType<typeof createGuildID>): MicupBotGuildSettingsRow => ({
	guild_id: guildId,
	commands_enabled: true,
	levels_enabled: true,
	automod_enabled: true,
	welcome_enabled: true,
	welcome_channel_id: null,
	welcome_message: null,
	welcome_embed: false,
	goodbye_enabled: false,
	goodbye_channel_id: null,
	goodbye_message: null,
	goodbye_embed: false,
	autorole_ids: null,
	level_up_message_enabled: true,
	level_up_channel_id: null,
	level_up_message: null,
	no_xp_channel_ids: null,
	no_xp_role_ids: null,
	voice_xp_enabled: false,
	updated_by: createUserID(1n),
	updated_at: new Date(),
	version: 0,
});
beforeAll(async () => {
	harness = await createApiTestHarness();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
	await harness?.shutdown();
});
it('flags follow the modules', () => {
	const settings = row(createGuildID(1n));
	expect(desiredMicupBotFlags({settings, rules: [], botPresent: true})).toEqual(
		new Set([GuildFeatures.MICUPBOT_COMMANDS, GuildFeatures.MICUPBOT_LEVELS, GuildFeatures.MICUPBOT_JOIN]),
	);
	expect(
		desiredMicupBotFlags({
			settings: {...settings, commands_enabled: false, levels_enabled: false, welcome_enabled: false},
			rules: [],
			botPresent: true,
		}),
	).toEqual(new Set());
});
it('no bot means no flags', () => {
	expect(desiredMicupBotFlags({settings: row(createGuildID(1n)), rules: [], botPresent: false})).toEqual(new Set());
});
async function fixture() {
	const owner = await createTestAccount(harness),
		guild = await createGuild(harness, owner.token, 'Bot flags'),
		guildId = createGuildID(BigInt(guild.id));
	await repository.putSettings(row(guildId), null);
	const current = (await guildRepository.findUnique(guildId))!;
	await guildRepository.upsertPartial(
		guildId,
		{features: new Set([...current.features, 'ANIMATED_ICON', 'MICUPBOT_AUTOMOD'])},
		current.toRow(),
	);
	return {
		owner,
		guild,
		guildId,
		deps: {repository, guildRepository, gatewayService: getGatewayService(), cacheService: getCacheService()},
	};
}
it('sync touches only MICUPBOT flags and keeps the others', async () => {
	const f = await fixture();
	const before = (await guildRepository.findUnique(f.guildId))!;
	expect(await syncMicupBotGuildFlags({...f, botPresent: true})).toBe(true);
	const after = (await guildRepository.findUnique(f.guildId))!;
	expect([...after.features].filter((v) => !flags.includes(v))).toEqual(
		[...before.features].filter((v) => !flags.includes(v)),
	);
	expect(after.features.has('MICUPBOT_AUTOMOD')).toBe(false);
	expect(after.features.has('MICUPBOT_COMMANDS')).toBe(true);
	await syncMicupBotGuildFlags({...f, botPresent: false});
	expect([...(await guildRepository.findUnique(f.guildId))!.features].some((v) => flags.includes(v))).toBe(false);
});
it('sync dispatches GUILD_UPDATE only on change', async () => {
	const f = await fixture(),
		dispatch = vi.spyOn(f.deps.gatewayService, 'dispatchGuild');
	await syncMicupBotGuildFlags({...f, botPresent: true});
	await syncMicupBotGuildFlags({...f, botPresent: true});
	expect(dispatch.mock.calls.filter(([p]) => p.event === 'GUILD_UPDATE')).toHaveLength(1);
});
it('a boost recompute keeps the MICUPBOT flags', async () => {
	const f = await fixture();
	await syncMicupBotGuildFlags({...f, botPresent: true});
	await getGuildBoostService().recompute(f.guildId);
	expect((await guildRepository.findUnique(f.guildId))!.features).toContain('MICUPBOT_COMMANDS');
});
it("a user's PATCH /guilds cannot set or clear MICUPBOT features", async () => {
	const f = await fixture();
	await syncMicupBotGuildFlags({...f, botPresent: false});
	for (const feature of flags)
		expect(
			(
				await createBuilder(harness, f.owner.token)
					.patch(`/guilds/${f.guild.id}`)
					.body({features: [feature]})
					.executeRaw()
			).response.status,
		).toBe(400);
	await syncMicupBotGuildFlags({...f, botPresent: true});
	expect(
		(await createBuilder(harness, f.owner.token).patch(`/guilds/${f.guild.id}`).body({features: []}).executeRaw())
			.response.status,
	).toBe(200);
	expect((await guildRepository.findUnique(f.guildId))!.features).toContain('MICUPBOT_COMMANDS');
});
it('the leave hook receives the removed temporary member flag', async () => {
	const f = await fixture(),
		member = await createTestAccount(harness);
	const invite = await createChannelInvite(harness, f.owner.token, f.guild.system_channel_id!);
	await acceptInvite(harness, member.token, invite.code);
	const userId = createUserID(BigInt(member.userId)),
		stored = (await guildRepository.getMember(f.guildId, userId))!;
	await guildRepository.upsertMember({...stored.toRow(), temporary: true});
	const hook = vi.spyOn(MemberHooks, 'notifyMicupBotMemberLeave');
	expect(await removeGuildMemberCounted(guildRepository, f.guildId, userId)).toBe(true);
	expect(hook).toHaveBeenCalledWith({guildId: f.guildId, userId, removed: true, temporary: true});
});

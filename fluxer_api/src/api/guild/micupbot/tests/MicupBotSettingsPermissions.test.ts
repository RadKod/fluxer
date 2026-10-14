// SPDX-License-Identifier: AGPL-3.0-or-later

import {createRoleID, createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {createMicupBotFixture, type MicupBotFixture} from '@app/api/guild/micupbot/tests/MicupBotTestUtils';
import {ELEVATED_MFA_PERMISSIONS} from '@app/api/guild/services/GuildMfaEnforcement';
import {
	createChannel,
	createGuild,
	createRole,
	updateRole,
	updateRolePositions,
} from '@app/api/guild/tests/GuildTestUtils';
import {getGatewayService} from '@app/api/middleware/ServiceRegistry';
import {getGuildRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest';

let harness: ApiTestHarness;
let f: MicupBotFixture;
let originalId: string | undefined;
beforeAll(async () => {
	harness = await createApiTestHarness();
});
beforeEach(async () => {
	originalId = Config.instance.micupBotApplicationId;
	await harness.reset();
	f = await createMicupBotFixture(harness);
});
afterEach(() => {
	Config.instance.micupBotApplicationId = originalId;
	vi.restoreAllMocks();
});
afterAll(async () => {
	await harness?.shutdown();
});

it('refuses @everyone as an auto role', async () => {
	await f
		.patch({autorole_ids: [f.guild.id]})
		.expect(400, APIErrorCodes.MICUPBOT_ROLE_NOT_ASSIGNABLE)
		.execute();
	expect(await f.repository.getSettings(f.guildId)).toBeNull();
});

it('refuses a role carrying any elevated MFA permission', async () => {
	for (let bit = 1n; bit <= ELEVATED_MFA_PERMISSIONS; bit <<= 1n) {
		if ((bit & ELEVATED_MFA_PERMISSIONS) === 0n) continue;
		const role = (await getGuildRepository().getRole(createRoleID(BigInt(f.role.id)), f.guildId))!;
		await getGuildRepository().upsertRole({...role.toRow(), permissions: bit});
		await f
			.patch({autorole_ids: [f.role.id]})
			.expect(400, APIErrorCodes.MICUPBOT_ROLE_NOT_ASSIGNABLE)
			.execute();
	}
});

it("refuses a role at or above the caller's highest role", async () => {
	const caller = await f.member(Permissions.MANAGE_GUILD | Permissions.MANAGE_ROLES);
	await updateRolePositions(harness, f.owner.token, f.guild.id, [{id: f.role.id, position: 10}]);
	await f
		.patch({autorole_ids: [f.role.id]}, caller.token)
		.expect(400, APIErrorCodes.MICUPBOT_ROLE_NOT_ASSIGNABLE)
		.execute();
	// The caller's own highest role is also forbidden, even if it has no elevated bits.
	await updateRole(harness, f.owner.token, f.guild.id, caller.role.id, {permissions: '0'});
	await updateRole(harness, f.owner.token, f.guild.id, f.guild.id, {
		permissions: (Permissions.MANAGE_GUILD | Permissions.MANAGE_ROLES).toString(),
	});
	await f
		.patch({autorole_ids: [caller.role.id]}, caller.token)
		.expect(400, APIErrorCodes.MICUPBOT_ROLE_NOT_ASSIGNABLE)
		.execute();
});

it("refuses a role at or above the bot's highest role", async () => {
	const bot = await f.addBot();
	await updateRolePositions(harness, f.owner.token, f.guild.id, [{id: f.role.id, position: 20}]);
	await f
		.patch({autorole_ids: [f.role.id]})
		.expect(400, APIErrorCodes.MICUPBOT_ROLE_NOT_ASSIGNABLE)
		.execute();
	await updateRole(harness, f.owner.token, f.guild.id, bot.botRoleId, {permissions: '0'});
	await f
		.patch({autorole_ids: [bot.botRoleId]})
		.expect(400, APIErrorCodes.MICUPBOT_ROLE_NOT_ASSIGNABLE)
		.execute();
});

it('refuses a role of another community', async () => {
	const other = await createGuild(harness, f.owner.token, 'Other roles');
	const role = await createRole(harness, f.owner.token, other.id, {name: 'Foreign', permissions: '0'});
	await f
		.patch({autorole_ids: [role.id]})
		.expect(400, APIErrorCodes.MICUPBOT_ROLE_NOT_ASSIGNABLE)
		.execute();
});

it('a caller without MANAGE_ROLES cannot save auto roles, panels or rewards', async () => {
	const caller = await f.member(Permissions.MANAGE_GUILD);
	await f
		.patch({autorole_ids: [f.role.id]}, caller.token)
		.expect(403, APIErrorCodes.MISSING_PERMISSIONS)
		.execute();
	await f.createPanel(f.panel, caller.token).expect(403, APIErrorCodes.MISSING_PERMISSIONS).execute();
	await createBuilder(harness, caller.token)
		.put(`${f.base}/level-rewards`)
		.body({rewards: [{level: 1, role_id: f.role.id}]})
		.expect(403, APIErrorCodes.MISSING_PERMISSIONS)
		.execute();
});

it('a manager without MANAGE_ROLES can change only commands_enabled with saved auto roles', async () => {
	const caller = await f.member(Permissions.MANAGE_GUILD);
	await f.seedSettings({autorole_ids: new Set([createRoleID(BigInt(f.role.id))])});
	const result = await f.patch({commands_enabled: true}, caller.token).execute();
	expect(result.settings.commands_enabled).toBe(true);
	expect(result.settings.autorole_ids).toEqual([f.role.id]);
});

it.each([
	['welcome_channel_id', 'welcome_message', 'Changed welcome'],
	['welcome_channel_id', 'welcome_embed', true],
	['welcome_channel_id', 'welcome_enabled', true],
	['goodbye_channel_id', 'goodbye_message', 'Changed goodbye'],
	['goodbye_channel_id', 'goodbye_embed', true],
	['goodbye_channel_id', 'goodbye_enabled', true],
	['level_up_channel_id', 'level_up_message', 'Changed level message'],
	['level_up_channel_id', 'level_up_message_enabled', false],
] as const)('checks the saved %s when only %s is patched', async (channelField, field, value) => {
	const caller = await f.member(
		Permissions.MANAGE_GUILD | Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.EMBED_LINKS,
	);
	await f.seedSettings({[channelField]: f.channelId});
	const saved = await f.repository.getSettings(f.guildId);
	for (const permission of [Permissions.VIEW_CHANNEL, Permissions.SEND_MESSAGES, Permissions.EMBED_LINKS]) {
		await createBuilder(harness, f.owner.token)
			.put(`/channels/${f.channelId}/permissions/${caller.role.id}`)
			.body({type: 0, allow: '0', deny: permission.toString()})
			.expect(204)
			.execute();
		await f
			.patch({[field]: value}, caller.token)
			.expect(403, APIErrorCodes.MISSING_PERMISSIONS)
			.execute();
		expect(await f.repository.getSettings(f.guildId)).toEqual(saved);
	}
});

it('a manager who cannot view saved message channels can change only commands_enabled', async () => {
	const caller = await f.member(Permissions.MANAGE_GUILD);
	await f.seedSettings({
		welcome_channel_id: f.channelId,
		goodbye_channel_id: f.channelId,
		level_up_channel_id: f.channelId,
	});
	await createBuilder(harness, f.owner.token)
		.put(`/channels/${f.channelId}/permissions/${caller.role.id}`)
		.body({type: 0, allow: '0', deny: Permissions.VIEW_CHANNEL.toString()})
		.expect(204)
		.execute();
	expect((await f.patch({commands_enabled: true}, caller.token).execute()).settings.commands_enabled).toBe(true);
});

it.each([
	['welcome_channel_id', 'welcome_message'],
	['goodbye_channel_id', 'goodbye_message'],
	['level_up_channel_id', 'level_up_message'],
] as const)('validates the merged %s when changing %s', async (channelField, messageField) => {
	const caller = await f.member(
		Permissions.MANAGE_GUILD | Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.EMBED_LINKS,
	);
	await f.seedSettings({[channelField]: f.channelId});
	await createBuilder(harness, f.owner.token)
		.put(`/channels/${f.channelId}/permissions/${caller.role.id}`)
		.body({type: 0, allow: '0', deny: Permissions.VIEW_CHANNEL.toString()})
		.expect(204)
		.execute();
	const channel = await createChannel(harness, f.owner.token, f.guild.id, 'Accessible messages', 0);
	const result = await f.patch({[channelField]: channel.id, [messageField]: 'Changed'}, caller.token).execute();
	expect(result.settings[channelField]).toBe(channel.id);
	expect(result.settings[messageField]).toBe('Changed');
	await f.patch({[channelField]: null, [messageField]: null}, caller.token).execute();
});

it.each(['welcome_channel_id', 'goodbye_channel_id', 'level_up_channel_id'] as const)(
	'a deleted saved %s does not block an unrelated PATCH',
	async (field) => {
		await f.seedSettings({[field]: f.channelId});
		await createBuilder(harness, f.owner.token).delete(`/channels/${f.channelId}`).expect(204).execute();
		const result = await f.patch({commands_enabled: true}).execute();
		expect(result.settings.commands_enabled).toBe(true);
		expect(result.settings[field]).toBe(f.channelId.toString());
		await f
			.patch({[field]: f.channelId.toString()})
			.expect(400, APIErrorCodes.INVALID_FORM_BODY)
			.execute();
		await f.patch({[field]: null}).execute();
	},
);

it('role_warnings lists a saved role that was raised later', async () => {
	await f.addBot();
	await f.patch({autorole_ids: [f.role.id]}).execute();
	expect((await f.get().execute()).role_warnings).toEqual([]);
	await updateRolePositions(harness, f.owner.token, f.guild.id, [{id: f.role.id, position: 20}]);
	expect((await f.get().execute()).role_warnings).toContain(f.role.id);
	await f.patch({welcome_message: 'Unrelated'}).execute();
	await f
		.patch({autorole_ids: [f.role.id]})
		.expect(400, APIErrorCodes.MICUPBOT_ROLE_NOT_ASSIGNABLE)
		.execute();
});

it('automod save needs MANAGE_MESSAGES and MODERATE_MEMBERS for a mute rule', async () => {
	const caller = await f.member(Permissions.MANAGE_GUILD);
	const save = (action: string) =>
		createBuilder(harness, caller.token)
			.put(`${f.base}/automod`)
			.body({rules: [{rule: 'spam', enabled: true, threshold: 5, action}]});
	await save('delete_warn').expect(403, APIErrorCodes.MISSING_PERMISSIONS).execute();
	await updateRole(harness, f.owner.token, f.guild.id, caller.role.id, {
		permissions: (Permissions.MANAGE_GUILD | Permissions.MANAGE_MESSAGES).toString(),
	});
	await save('delete_warn').execute();
	await save('delete_mute').expect(403, APIErrorCodes.MISSING_PERMISSIONS).execute();
	await updateRole(harness, f.owner.token, f.guild.id, caller.role.id, {
		permissions: (Permissions.MANAGE_GUILD | Permissions.MANAGE_MESSAGES | Permissions.MODERATE_MEMBERS).toString(),
	});
	await save('delete_mute').execute();
});

it('a 2 letter word is refused', async () => {
	await createBuilder(harness, f.owner.token)
		.put(`${f.base}/automod`)
		.body({rules: [{rule: 'words', enabled: true, threshold: 0, words: ['ab']}]})
		.expect(400, APIErrorCodes.INVALID_FORM_BODY)
		.execute();
});

it('a disabled delete_mute rule does not require MODERATE_MEMBERS', async () => {
	const caller = await f.member(Permissions.MANAGE_GUILD | Permissions.MANAGE_MESSAGES);
	await createBuilder(harness, caller.token)
		.put(`${f.base}/automod`)
		.body({rules: [{rule: 'spam', enabled: false, threshold: 5, action: 'delete_mute'}]})
		.execute();
	expect(await f.repository.listRules(f.guildId)).toEqual([
		expect.objectContaining({enabled: false, action: 'delete_mute'}),
	]);
});

it('refuses a welcome channel where the caller cannot send or embed (channel overwrite denies SEND_MESSAGES)', async () => {
	const caller = await f.member(
		Permissions.MANAGE_GUILD | Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.EMBED_LINKS,
	);
	const gateway = getGatewayService();
	const params = {guildId: f.guildId, userId: createUserID(BigInt(caller.userId))};
	expect((await gateway.getUserPermissions(params)) & Permissions.SEND_MESSAGES).toBe(Permissions.SEND_MESSAGES);
	for (const permission of [Permissions.SEND_MESSAGES, Permissions.EMBED_LINKS, Permissions.VIEW_CHANNEL]) {
		await createBuilder(harness, f.owner.token)
			.put(`/channels/${f.channelId}/permissions/${caller.role.id}`)
			.body({type: 0, allow: '0', deny: permission.toString()})
			.expect(204)
			.execute();
		const spy = vi.spyOn(gateway, 'getUserPermissions');
		await f
			.patch({welcome_channel_id: f.channelId.toString()}, caller.token)
			.expect(403, APIErrorCodes.MISSING_PERMISSIONS)
			.execute();
		expect(spy).toHaveBeenCalledWith({...params, channelId: f.channelId});
		spy.mockRestore();
	}
	await f.seedSettings({welcome_channel_id: f.channelId});
	await f.patch({goodbye_message: 'Changed'}, caller.token).execute();
});

it("refuses a voice channel or another community's channel", async () => {
	const voice = await createChannel(harness, f.owner.token, f.guild.id, 'Voice', 2);
	const other = await createGuild(harness, f.owner.token, 'Other channel');
	for (const field of ['welcome_channel_id', 'goodbye_channel_id', 'level_up_channel_id']) {
		for (const [id, code] of [
			[voice.id, ValidationErrorCodes.INVALID_CHANNEL_ID],
			[other.system_channel_id!, ValidationErrorCodes.CHANNEL_DOES_NOT_EXIST],
		]) {
			const result = await createBuilder<{errors: Array<{path: string; code: string}>}>(harness, f.owner.token)
				.patch(`${f.base}/settings`)
				.body({[field]: id})
				.expect(400, APIErrorCodes.INVALID_FORM_BODY)
				.execute();
			expect(result.errors).toContainEqual(expect.objectContaining({path: field, code}));
		}
	}
});

it('a 1001 character template is refused', async () => {
	await f
		.patch({welcome_message: 'a'.repeat(1001)})
		.expect(400, APIErrorCodes.INVALID_FORM_BODY)
		.execute();
});

it('reward replacement checks each role and keeps only the requested levels', async () => {
	const put = (rewards: Array<{level: number; role_id: string}>) =>
		createBuilder(harness, f.owner.token).put(`${f.base}/level-rewards`).body({rewards});
	await put([{level: 1, role_id: f.guild.id}])
		.expect(400, APIErrorCodes.MICUPBOT_ROLE_NOT_ASSIGNABLE)
		.execute();
	await put([
		{level: 1, role_id: f.role.id},
		{level: 5, role_id: f.role.id},
	]).execute();
	expect(await f.repository.listRewards(f.guildId)).toHaveLength(2);
	await put([{level: 5, role_id: f.role.id}]).execute();
	expect(await createBuilder(harness, f.owner.token).get(`${f.base}/level-rewards`).execute()).toEqual({
		rewards: [{level: 5, role_id: f.role.id}],
		max_rewards: 25,
	});
});

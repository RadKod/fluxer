// SPDX-License-Identifier: AGPL-3.0-or-later

import {createRoleID, guildIdToRoleId} from '@app/api/BrandedTypes';
import {MICUPBOT_TEXT} from '@app/api/guild/micupbot/MicupBotConstants';
import {useCommandFixture} from '@app/api/guild/micupbot/tests/MicupBotCommandTestUtils';
import {addMemberRole, createChannel, updateRolePositions} from '@app/api/guild/tests/GuildTestUtils';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AuditLogActionType} from '@fluxer/constants/src/AuditLogActionType';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {GuildMFALevel} from '@fluxer/constants/src/GuildConstants';
import {expect, it, vi} from 'vitest';

const fixture = useCommandFixture();

it('a member without BAN_MEMBERS who types #ban is refused and nobody is banned', async () => {
	const f = await fixture(0n);
	const botRole = (await f.deps.guildRepository.getRole(createRoleID(BigInt(f.bot.botRoleId)), f.guildId))!;
	await f.deps.guildRepository.upsertRole({
		...botRole.toRow(),
		permissions: botRole.permissions | Permissions.BAN_MEMBERS,
	});
	expect(
		await f.deps.gatewayService.checkPermission({
			guildId: f.guildId,
			userId: f.botId,
			permission: Permissions.BAN_MEMBERS,
		}),
	).toBe(true);
	await f.run(`#ban ${f.target.userId}`);
	expect(f.reply()?.content).toBe(MICUPBOT_TEXT.noPermission);
	expect(await f.deps.guildRepository.getBan(f.guildId, f.targetId)).toBeNull();
	expect(await f.deps.guildRepository.getMember(f.guildId, f.targetId)).not.toBeNull();
});

it('timeout aliases and unmute use author-scoped member updates', async () => {
	const f = await fixture();
	for (const name of ['mute', 'timeout']) {
		await f.run(`#${name} ${f.target.userId} 30sn reason`);
		expect(
			(await f.deps.guildRepository.getMember(f.guildId, f.targetId))?.communicationDisabledUntil?.getTime(),
		).toBeGreaterThan(Date.now());
	}
	await f.run(`#unmute ${f.target.userId}`);
	expect((await f.deps.guildRepository.getMember(f.guildId, f.targetId))?.communicationDisabledUntil).toBeNull();
});

it('role toggles by Turkish full name and nickname updates use the author', async () => {
	const f = await fixture();
	const roleId = createRoleID(BigInt(f.role.id));
	const role = (await f.deps.guildRepository.getRole(roleId, f.guildId))!;
	await f.deps.guildRepository.upsertRole({...role.toRow(), name: 'İZMİR Ekibi', position: 1});
	await f.run(`#role ${f.target.userId} izmir ekibi`);
	expect((await f.deps.guildRepository.getMember(f.guildId, f.targetId))?.roleIds.has(roleId)).toBe(true);
	await f.run(`#role ${f.target.userId} <@&${roleId}>`);
	expect((await f.deps.guildRepository.getMember(f.guildId, f.targetId))?.roleIds.has(roleId)).toBe(false);
	await f.run(`#nick ${f.target.userId} New Name`);
	expect((await f.deps.guildRepository.getMember(f.guildId, f.targetId))?.nickname).toBe('New Name');
	await f.run(`#nick ${f.target.userId}`);
	expect((await f.deps.guildRepository.getMember(f.guildId, f.targetId))?.nickname).toBeNull();
});

it('move uses the author as moderator and rejects a text destination', async () => {
	const f = await fixture();
	const voice = await createChannel(f.harness, f.owner.token, f.guild.id, 'Voice', 2);
	const move = vi.spyOn(f.deps.gatewayService, 'moveMember').mockResolvedValue({success: true});
	await f.run(`#move ${f.target.userId} <#${voice.id}>`);
	expect(move).toHaveBeenCalledWith(
		expect.objectContaining({moderatorId: f.authorId, userId: f.targetId, channelId: BigInt(voice.id)}),
	);
	move.mockClear();
	await f.run(`#move ${f.target.userId} <#${f.channelId}>`);
	expect(move).not.toHaveBeenCalled();
});

it('a moderator cannot #ban or #kick someone at or above their own highest role', async () => {
	const f = await fixture();
	await addMemberRole(f.harness, f.owner.token, f.guild.id, f.target.userId, f.author.role.id);
	for (const position of [1, 4]) {
		await updateRolePositions(f.harness, f.owner.token, f.guild.id, [{id: f.target.role.id, position}]);
		for (const command of ['ban', 'kick']) {
			await f.run(`#${command} ${f.target.userId}`);
			expect(f.reply()?.content).toBe(MICUPBOT_TEXT.noPermission);
			expect(await f.deps.guildRepository.getMember(f.guildId, f.targetId)).not.toBeNull();
			expect(await f.deps.guildRepository.getBan(f.guildId, f.targetId)).toBeNull();
		}
	}
});

it("#role cannot give a role above the author's highest role even though the bot could", async () => {
	const f = await fixture();
	await updateRolePositions(f.harness, f.owner.token, f.guild.id, [{id: f.role.id, position: 4}]);
	expect(
		await f.deps.gatewayService.canManageRoles({
			guildId: f.guildId,
			userId: f.botId,
			targetUserId: f.targetId,
			roleId: createRoleID(BigInt(f.role.id)),
		}),
	).toBe(true);
	await f.run(`#role ${f.target.userId} ${f.role.id}`);
	expect(f.reply()?.content).toBe(MICUPBOT_TEXT.noPermission);
	expect(
		(await f.deps.guildRepository.getMember(f.guildId, f.targetId))?.roleIds.has(createRoleID(BigInt(f.role.id))),
	).toBe(false);
});

it('the audit log names the author, not the bot', async () => {
	const f = await fixture();
	await f.run(`#ban ${f.target.userId} audit reason`);
	const logs = await createBuilder<{audit_log_entries: Array<{user_id: string; target_id: string; reason: string}>}>(
		f.harness,
		f.owner.token,
	)
		.get(`/guilds/${f.guild.id}/audit-logs?action_type=${AuditLogActionType.MEMBER_BAN_ADD}`)
		.execute();
	expect(logs.audit_log_entries).toEqual(
		expect.arrayContaining([
			expect.objectContaining({user_id: f.author.userId, target_id: f.target.userId, reason: 'audit reason'}),
		]),
	);
	expect(logs.audit_log_entries.some((entry) => entry.user_id === f.bot.botUserId)).toBe(false);
});

it('on an elevated-MFA community a moderator without 2FA is refused', async () => {
	const f = await fixture();
	const guild = (await f.deps.guildRepository.findUnique(f.guildId))!;
	await f.deps.guildRepository.upsert({...guild.toRow(), mfa_level: GuildMFALevel.ELEVATED});
	for (const command of [`#ban ${f.target.userId}`, `#mute ${f.target.userId} 10m`]) {
		await f.run(command);
		expect(f.reply()?.content).toBe(MICUPBOT_TEXT.mfaRequired);
	}
	expect(await f.deps.guildRepository.getBan(f.guildId, f.targetId)).toBeNull();
	expect((await f.deps.guildRepository.getMember(f.guildId, f.targetId))?.communicationDisabledUntil).toBeNull();
});

it('#ban with a duration bans temporarily', async () => {
	const f = await fixture();
	const now = Date.now();
	await f.run(`#ban ${f.target.userId} 2h reason`);
	const ban = (await f.deps.guildRepository.getBan(f.guildId, f.targetId))!;
	expect(ban.expiresAt?.getTime()).toBeGreaterThanOrEqual(now + 7200000);
	expect(ban.moderatorId).toBe(f.authorId);
	await f.run(`#unban ${f.target.userId}`);
	expect(await f.deps.guildRepository.getBan(f.guildId, f.targetId)).toBeNull();
});

for (const [name, content] of [
	['#mute above 28 days is a usage error', '#mute TARGET 29d'],
	['#ban 5s is a usage error', '#ban TARGET 5s'],
	["#nick longer than Fluxer's limit is refused", `#nick TARGET ${'x'.repeat(33)}`],
	["#slowmode above Fluxer's maximum is a usage error", '#slowmode 999999'],
	['a 600 character reason is refused', `#ban TARGET ${'x'.repeat(600)}`],
] as const)
	it(name, async () => {
		const f = await fixture();
		const ban = vi.spyOn(f.deps.guildService.moderation, 'banMember');
		const member = vi.spyOn(f.deps.guildService.members, 'updateMember');
		const channel = vi.spyOn(f.deps.channelService.channelData, 'editChannel');
		await f.run(content.replace('TARGET', f.target.userId));
		expect(f.reply()?.content).toContain(MICUPBOT_TEXT.usage(content.split(' ')[0]).split('`')[0]);
		expect(ban).not.toHaveBeenCalled();
		expect(member).not.toHaveBeenCalled();
		expect(channel).not.toHaveBeenCalled();
	});

it("#clear deletes up to N messages before the command (only the named member's when given)", async () => {
	const f = await fixture();
	const old = await f.message('old', f.target);
	const keep = await f.message('keep');
	const remove = await f.message('remove', f.target);
	const payload = await f.run(`#clear 2 <@${f.target.userId}>`);
	expect(await f.exists(String(old.id))).not.toBeNull();
	expect(await f.exists(String(keep.id))).not.toBeNull();
	expect(await f.exists(String(remove.id))).toBeNull();
	expect(await f.exists(payload.message_id)).not.toBeNull();
	expect(f.reply()?.content).toBe(MICUPBOT_TEXT.cleared(1));
});

it('#clear in a channel whose overwrite denies the author MANAGE_MESSAGES is refused', async () => {
	const f = await fixture();
	const keep = await f.message('keep', f.target);
	await f.overwrite(0n, Permissions.MANAGE_MESSAGES, f.author.userId, 1);
	await f.run('#clear 1');
	expect(await f.exists(String(keep.id))).not.toBeNull();
	expect(f.reply()?.content).toBe(MICUPBOT_TEXT.noPermission);
});

it('a redelivered #clear deletes nothing more', async () => {
	const f = await fixture();
	await f.message('remove');
	const payload = await f.run('#clear 1');
	const deletion = vi.spyOn(f.deps.channelService.messages.deletion, 'bulkDeleteMessages');
	const keep = await f.message('keep');
	f.send.mockClear();
	await f.runner.run(payload);
	expect(deletion).not.toHaveBeenCalled();
	expect(f.send).not.toHaveBeenCalled();
	expect(await f.exists(String(keep.id))).not.toBeNull();
});

it('#lock keeps the other overwrite bits and #unlock removes only SEND_MESSAGES', async () => {
	const f = await fixture();
	await f.overwrite(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES, Permissions.ADD_REACTIONS);
	await f.run('#lock');
	const read = async () =>
		(await f.deps.channelRepository.channelData.findUnique(f.channelId))!.permissionOverwrites.get(
			guildIdToRoleId(f.guildId),
		)!;
	expect((await read()).allow).toBe(Permissions.VIEW_CHANNEL);
	expect((await read()).deny).toBe(Permissions.ADD_REACTIONS | Permissions.SEND_MESSAGES);
	await f.run('#unlock', f.owner);
	expect((await read()).allow).toBe(Permissions.VIEW_CHANNEL);
	expect((await read()).deny).toBe(Permissions.ADD_REACTIONS);
});

it('#slowmode off sets 0', async () => {
	const f = await fixture();
	await f.run('#slowmode 10');
	expect((await f.deps.channelRepository.channelData.findUnique(f.channelId))?.rateLimitPerUser).toBe(10);
	await f.run('#slowmode off');
	expect((await f.deps.channelRepository.channelData.findUnique(f.channelId))?.rateLimitPerUser).toBe(0);
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {updateRole} from '@app/api/channel/tests/ChannelTestUtils';
import {MICUPBOT_TEXT} from '@app/api/guild/micupbot/MicupBotConstants';
import {useMemberFixture} from '@app/api/guild/micupbot/tests/MicupBotMemberTestUtils';
import {updateRolePositions} from '@app/api/guild/tests/GuildTestUtils';
import {Logger} from '@app/api/Logger';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {expect, it, vi} from 'vitest';

const fixture = useMemberFixture();

it('auto roles are given by the bot with the audit reason', async () => {
	const f = await fixture();
	await f.settings({autorole_ids: new Set(f.roles)});
	const lock = vi.spyOn(f.deps.kvClient, 'acquireLock');
	await f.runner.run(f.payload);
	for (const roleId of f.roles)
		expect(f.grant).toHaveBeenCalledWith(
			expect.objectContaining({userId: f.botId, targetId: f.userId, guildId: f.guildId, roleId}),
			MICUPBOT_TEXT.audit.autorole,
		);
	expect((await f.deps.guildRepository.getMember(f.guildId, f.userId))!.roleIds).toEqual(new Set(f.roles));
	expect(lock).toHaveBeenCalledWith(`micupbot:mlock:${f.guildId}:${f.userId}`, expect.any(String), 5);
});

it('a temporary member gets no auto role', async () => {
	const f = await fixture();
	const member = (await f.deps.guildRepository.getMember(f.guildId, f.userId))!;
	await f.deps.guildRepository.upsertMember({...member.toRow(), temporary: true});
	await f.runner.run(f.payload);
	expect(f.grant).not.toHaveBeenCalled();
	expect((await f.deps.guildRepository.getMember(f.guildId, f.userId))!.isTemporary).toBe(true);
});

it('an auto role raised to ADMINISTRATOR later is skipped', async () => {
	const f = await fixture();
	await updateRole(f.harness, f.owner.token, f.guild.id, String(f.roles[0]), {
		permissions: Permissions.ADMINISTRATOR.toString(),
	});
	const warn = vi.spyOn(Logger.child({}), 'warn');
	await f.runner.run(f.payload);
	expect(f.grant).not.toHaveBeenCalled();
	expect(warn).toHaveBeenCalledWith(expect.objectContaining({problem: 'elevated'}), expect.any(String));
	expect(f.send).toHaveBeenCalledOnce();
});

it("an auto role above the bot's highest role is skipped", async () => {
	const f = await fixture();
	await updateRolePositions(f.harness, f.owner.token, f.guild.id, [{id: String(f.roles[0]), position: 5}]);
	const debug = vi.spyOn(Logger.child({}), 'debug');
	await expect(f.rejoin()).resolves.toMatchObject({userId: f.userId});
	await f.runner.run(f.payload);
	expect((await f.deps.guildRepository.getMember(f.guildId, f.userId))!.roleIds.size).toBe(0);
	expect(debug).toHaveBeenCalledWith(expect.objectContaining({skipped: 1}), expect.any(String));
	expect(f.send).toHaveBeenCalledOnce();
});

it('on an elevated-MFA community the auto role is skipped and counted', async () => {
	const f = await fixture();
	await f.deps.guildRepository.upsert({...f.guildModel.toRow(), mfa_level: 1});
	const debug = vi.spyOn(Logger.child({}), 'debug');
	await expect(f.rejoin()).resolves.toMatchObject({userId: f.userId});
	await f.runner.run(f.payload);
	expect((await f.deps.guildRepository.getMember(f.guildId, f.userId))!.roleIds.size).toBe(0);
	expect(debug).toHaveBeenCalledWith(expect.objectContaining({skipped: 1}), expect.any(String));
	expect(f.send).toHaveBeenCalledOnce();
});

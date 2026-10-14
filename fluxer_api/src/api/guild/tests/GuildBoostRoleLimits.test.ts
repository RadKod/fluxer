// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createGuildID, createRoleID, createUserID, guildIdToRoleId} from '@app/api/BrandedTypes';
import {GuildRoleService} from '@app/api/guild/services/GuildRoleService';
import {acceptInvite, createChannelInvite, createGuild, createRole} from '@app/api/guild/tests/GuildTestUtils';
import {getGatewayService, getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {
	getCacheService,
	getGuildAuditLogService,
	getGuildRepository,
	getLimitConfigService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {MaxGuildRolesError} from '@fluxer/errors/src/domains/guild/MaxGuildRolesError';
import type {GuildResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';

describe('Guild role capacity scope', () => {
	let harness: ApiTestHarness;
	let owner: TestAccount;
	let guild: GuildResponse;
	let service: GuildRoleService;

	beforeEach(async () => {
		harness = await createApiTestHarness();
		owner = await createTestAccount(harness);
		guild = await createGuild(harness, owner.token, 'Role capacity');
		const limits = getLimitConfigService();
		const snapshot = limits.getConfigSnapshot();
		await limits.updateConfig({
			...snapshot,
			rules: [
				...snapshot.rules,
				{
					id: 'admin_role_capacity',
					filters: {guildFeatures: [GuildFeatures.MORE_EMOJI]},
					limits: {max_guild_roles: 300},
				},
			],
		});
		service = new GuildRoleService(
			getGuildRepository(),
			getSnowflakeService(),
			getCacheService(),
			getGatewayService(),
			getGuildAuditLogService(),
			limits,
			getUserRepository(),
		);
	});

	afterEach(async () => {
		await harness?.shutdown();
	});

	async function seedRoles(target: GuildResponse, count: number, override: boolean): Promise<void> {
		const guildId = createGuildID(BigInt(target.id));
		const repository = getGuildRepository();
		if (override) {
			await repository.upsertPartial(guildId, {features: new Set([GuildFeatures.MORE_EMOJI])});
		}
		const everyone = await repository.getRole(guildIdToRoleId(guildId), guildId);
		if (!everyone) throw new Error('Missing @everyone fixture');
		for (let index = 1; index < count; index++) {
			await repository.upsertRole({
				...everyone.toRow(),
				role_id: createRoleID(await getSnowflakeService().generate()),
				name: `Seed ${index}`,
				position: index,
			});
		}
		expect(await repository.countRoles(guildId)).toBe(count);
	}

	function createSystemRole() {
		return service.systemCreateRole({
			initiatorId: createUserID(BigInt(owner.userId)),
			guildId: createGuildID(BigInt(guild.id)),
			data: {name: 'Bot role', color: 0, permissions: Permissions.VIEW_CHANNEL},
		});
	}

	test('guild_override_allows_role_251', async () => {
		await seedRoles(guild, 250, true);
		const role = await createRole(harness, owner.token, guild.id, {name: 'Role 251'});
		expect(role.name).toBe('Role 251');
		expect(await getGuildRepository().countRoles(createGuildID(BigInt(guild.id)))).toBe(251);
	});

	test('bot_managed_role_uses_guild_scope', async () => {
		await seedRoles(guild, 250, true);
		const role = await createSystemRole();
		expect(role.permissions).toBe(Permissions.VIEW_CHANNEL.toString());
		expect(await getGuildRepository().countRoles(createGuildID(BigInt(guild.id)))).toBe(251);
	});

	test('permission_and_other_guild_unchanged', async () => {
		await seedRoles(guild, 250, true);
		const member = await createTestAccount(harness);
		const invite = await createChannelInvite(harness, owner.token, guild.system_channel_id!);
		await acceptInvite(harness, member.token, invite.code);
		await createBuilder(harness, member.token)
			.post(`/guilds/${guild.id}/roles`)
			.body({name: 'Unauthorized'})
			.expect(HTTP_STATUS.FORBIDDEN, 'MISSING_PERMISSIONS')
			.execute();
		expect(await getGuildRepository().countRoles(createGuildID(BigInt(guild.id)))).toBe(250);
		const control = await createGuild(harness, owner.token, 'Control');
		await seedRoles(control, 250, false);
		await createBuilder(harness, owner.token)
			.post(`/guilds/${control.id}/roles`)
			.body({name: 'Over capacity'})
			.expect(HTTP_STATUS.BAD_REQUEST, 'MAX_GUILD_ROLES')
			.execute();
		expect(await getGuildRepository().countRoles(createGuildID(BigInt(control.id)))).toBe(250);
	});

	test.each([false, true])('last slot counts @everyone and rejects the next role (system=%s)', async (system) => {
		await seedRoles(guild, 299, true);
		if (system) {
			await createSystemRole();
			await expect(createSystemRole()).rejects.toBeInstanceOf(MaxGuildRolesError);
		} else {
			await createRole(harness, owner.token, guild.id, {name: 'Last slot'});
			await createBuilder(harness, owner.token)
				.post(`/guilds/${guild.id}/roles`)
				.body({name: 'No slot'})
				.expect(HTTP_STATUS.BAD_REQUEST, 'MAX_GUILD_ROLES')
				.execute();
		}
		expect(await getGuildRepository().countRoles(createGuildID(BigInt(guild.id)))).toBe(300);
	});

	test('control guild rejects system role 251', async () => {
		await seedRoles(guild, 250, false);
		await expect(createSystemRole()).rejects.toBeInstanceOf(MaxGuildRolesError);
		expect(await getGuildRepository().countRoles(createGuildID(BigInt(guild.id)))).toBe(250);
	});
});

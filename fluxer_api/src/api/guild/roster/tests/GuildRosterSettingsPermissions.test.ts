// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createChannelID, createRoleID, createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {
	createRosterSettingsFixture,
	type RosterSettingsFixture,
} from '@app/api/guild/roster/tests/GuildRosterSettingsTestUtils';
import {
	acceptInvite,
	addMemberRole,
	createChannelInvite,
	createRole,
	updateRole,
} from '@app/api/guild/tests/GuildTestUtils';
import {getGatewayService} from '@app/api/middleware/ServiceRegistry';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import type {GuildRoleResponse} from '@fluxer/schema/src/domains/guild/GuildRoleSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

describe('Guild roster settings permissions', () => {
	let harness: ApiTestHarness;
	let fixture: RosterSettingsFixture;
	let member: TestAccount;
	let role: GuildRoleResponse;
	let originalApplicationId: string | undefined;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		originalApplicationId = Config.instance.rosterBotApplicationId;
		await harness.reset();
		fixture = await createRosterSettingsFixture(harness);
		member = await createTestAccount(harness);
		const invite = await createChannelInvite(harness, fixture.owner.token, fixture.data.announce_channel_id);
		await acceptInvite(harness, member.token, invite.code);
		role = await createRole(harness, fixture.owner.token, fixture.guild.id, {
			name: 'Event manager',
			permissions: (
				Permissions.MANAGE_GUILD |
				Permissions.VIEW_CHANNEL |
				Permissions.CONNECT |
				Permissions.MOVE_MEMBERS |
				Permissions.SEND_MESSAGES
			).toString(),
		});
		await addMemberRole(harness, fixture.owner.token, fixture.guild.id, member.userId, role.id);
	});
	afterEach(() => {
		Config.instance.rosterBotApplicationId = originalApplicationId;
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	async function deny(channelId: string, permission: bigint): Promise<void> {
		await createBuilder(harness, fixture.owner.token)
			.put(`/channels/${channelId}/permissions/${role.id}`)
			.body({type: 0, allow: '0', deny: permission.toString()})
			.expect(204)
			.execute();
	}

	it('refuses an event room where the caller lacks MOVE_MEMBERS', async () => {
		const gateway = getGatewayService();
		const params = {guildId: fixture.guildId, userId: createUserID(BigInt(member.userId))};
		expect((await gateway.getUserPermissions(params)) & Permissions.MOVE_MEMBERS).toBe(Permissions.MOVE_MEMBERS);
		await deny(fixture.voice.id, Permissions.MOVE_MEMBERS);
		const permissions = vi.spyOn(gateway, 'getUserPermissions');
		await fixture.create(fixture.data, member.token).expect(403, APIErrorCodes.MISSING_PERMISSIONS).execute();
		expect(permissions).toHaveBeenCalledWith({...params, channelId: createChannelID(BigInt(fixture.voice.id))});
		expect(await fixture.repository.listByGuild(fixture.guildId)).toEqual([]);
	});

	it('refuses an event room the caller cannot see or join', async () => {
		for (const permission of [Permissions.VIEW_CHANNEL, Permissions.CONNECT]) {
			await deny(fixture.voice.id, permission);
			await fixture.create(fixture.data, member.token).expect(403, APIErrorCodes.MISSING_PERMISSIONS).execute();
		}
	});

	it('refuses an announce channel where the caller cannot send', async () => {
		await deny(fixture.data.announce_channel_id, Permissions.SEND_MESSAGES);
		await fixture.create(fixture.data, member.token).expect(403, APIErrorCodes.MISSING_PERMISSIONS).execute();
	});

	it('refuses a role that is not mentionable unless the caller has MENTION_EVERYONE', async () => {
		const body = {...fixture.data, mention_role_id: role.id};
		await fixture.create(body, member.token).expect(403, APIErrorCodes.MISSING_PERMISSIONS).execute();
		await updateRole(harness, fixture.owner.token, fixture.guild.id, role.id, {mentionable: true});
		await fixture.create(body, member.token).execute();
		await updateRole(harness, fixture.owner.token, fixture.guild.id, role.id, {
			mentionable: false,
			permissions: (BigInt(role.permissions) | Permissions.MENTION_EVERYONE).toString(),
		});
		await fixture.create(body, member.token).execute();
		await deny(fixture.data.announce_channel_id, Permissions.MENTION_EVERYONE);
		await fixture.create(body, member.token).expect(403, APIErrorCodes.MISSING_PERMISSIONS).execute();
	});

	it('PATCH re-runs the channel and role checks', async () => {
		const row = await fixture.seed();
		const path = `${fixture.base}/${row.event_id}`;
		const patch = (body: object) => createBuilder(harness, member.token).patch(path).body(body);
		await deny(fixture.voice.id, Permissions.VIEW_CHANNEL);
		await patch({name: 'Changed'}).expect(403, APIErrorCodes.MISSING_PERMISSIONS).execute();
		await deny(fixture.voice.id, 0n);
		await deny(fixture.data.announce_channel_id, Permissions.SEND_MESSAGES);
		await patch({enabled: false}).expect(403, APIErrorCodes.MISSING_PERMISSIONS).execute();
		await deny(fixture.data.announce_channel_id, 0n);
		await patch({mention_role_id: role.id}).expect(403, APIErrorCodes.MISSING_PERMISSIONS).execute();
		await fixture.repository.update({...row, mention_role_id: createRoleID(BigInt(role.id))}, row.version);
		await patch({name: 'Changed'}).expect(403, APIErrorCodes.MISSING_PERMISSIONS).execute();
		await patch({mention_role_id: null}).execute();
		expect((await fixture.repository.get(fixture.guildId, row.event_id))?.mention_role_id).toBeNull();
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createEmojiID, createGuildID, createRoleID, createUserID} from '@app/api/BrandedTypes';
import {
	acceptInvite,
	createChannelInvite,
	createGuild,
	createRole,
	getRoles,
	updateMember,
	updateRolePositions,
} from '@app/api/guild/tests/GuildTestUtils';
import {getGuildRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import type {GuildResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';
import type {GuildRoleResponse} from '@fluxer/schema/src/domains/guild/GuildRoleSchemas';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

describe('Guild role appearance', () => {
	let harness: ApiTestHarness;
	let owner: TestAccount;
	let guild: GuildResponse;
	let role: GuildRoleResponse;

	beforeEach(async () => {
		harness = await createApiTestHarness();
		owner = await createTestAccount(harness);
		guild = await createGuild(harness, owner.token, 'Role appearance');
		role = await createRole(harness, owner.token, guild.id, {name: 'Decorated'});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await harness?.shutdown();
	});

	async function setLevel(level: number) {
		await createBuilder(harness, '')
			.post(`/test/guilds/${guild.id}/features`)
			.body({
				add_features:
					level === 2
						? [GuildFeatures.BOOST_LEVEL_1, GuildFeatures.BOOST_LEVEL_2]
						: level === 1
							? [GuildFeatures.BOOST_LEVEL_1]
							: [],
				remove_features: level === 0 ? [GuildFeatures.BOOST_LEVEL_1, GuildFeatures.BOOST_LEVEL_2] : [],
			})
			.execute();
	}

	function patch(data: Record<string, unknown>, status = 200, token = owner.token) {
		return createBuilder<GuildRoleResponse>(harness, token)
			.patch(`/guilds/${guild.id}/roles/${role.id}`)
			.body(data)
			.expect(status)
			.execute();
	}

	test('S0 rejects new icons and S1 accepts one Unicode emoji', async () => {
		await patch({unicode_emoji: '🎉'}, 400);
		await setLevel(1);
		expect((await patch({unicode_emoji: '🎉'})).unicode_emoji).toBe('🎉');
	});

	test('S1 rejects gradients and S2 accepts black as the second color', async () => {
		await setLevel(1);
		await patch({color_secondary: 0}, 400);
		await setLevel(2);
		expect((await patch({color: 0x123456, color_secondary: 0})).color_secondary).toBe(0);
		expect((await patch({color_secondary: 0xffffff})).color_secondary).toBe(0xffffff);
	});

	test('downgrade preserves omitted and unchanged appearance but permits explicit null', async () => {
		await setLevel(2);
		await patch({unicode_emoji: '🎉', color_secondary: 0xabcdef});
		await setLevel(0);
		const renamed = await patch({name: 'Renamed'});
		expect(renamed).toMatchObject({name: 'Renamed', unicode_emoji: '🎉', color_secondary: 0xabcdef});
		expect(await patch({color: 0x654321})).toMatchObject({color: 0x654321, color_secondary: 0xabcdef});
		expect(await patch({unicode_emoji: '🎉', color_secondary: 0xabcdef})).toMatchObject({
			unicode_emoji: '🎉',
			color_secondary: 0xabcdef,
		});
		await patch({unicode_emoji: '🌟'}, 400);
		await patch({color_secondary: 0x123456}, 400);
		expect(await patch({unicode_emoji: null, color_secondary: null, icon_emoji_id: null})).toMatchObject({
			unicode_emoji: null,
			color_secondary: null,
			icon_emoji_id: null,
		});
	});

	test('HTTP empty Unicode string keeps the shared null-clearing behavior', async () => {
		await setLevel(1);
		await patch({unicode_emoji: '🎉'});
		await setLevel(0);
		expect((await patch({unicode_emoji: ''})).unicode_emoji).toBeNull();
	});

	test.each(['plain text', '🎉🌟', ' '])('rejects invalid Unicode icon %s', async (unicode) => {
		await setLevel(1);
		await patch({unicode_emoji: unicode}, 400);
	});

	test.each([-1, 0x1000000, 1.5, 'red'])('rejects invalid secondary color %s', async (color) => {
		await setLevel(2);
		await patch({color_secondary: color}, 400);
	});

	test('accepts only existing same-guild emojis, keeps a deleted icon unchanged and permits clearing', async () => {
		await setLevel(1);
		const repository = getGuildRepository();
		const guildId = createGuildID(BigInt(guild.id));
		const foreign = await createGuild(harness, owner.token, 'Foreign');
		const emojiId = createEmojiID(123456789012345678n);
		const foreignEmojiId = createEmojiID(123456789012345679n);
		for (const [id, targetGuild] of [
			[emojiId, guildId],
			[foreignEmojiId, createGuildID(BigInt(foreign.id))],
		] as const) {
			await repository.upsertEmoji({
				guild_id: targetGuild,
				emoji_id: id,
				creator_id: createUserID(BigInt(owner.userId)),
				name: 'icon',
				animated: true,
				version: 1,
			});
		}
		await patch({icon_emoji_id: foreignEmojiId.toString()}, 400);
		await patch({icon_emoji_id: '123456789012345680'}, 400);
		expect((await patch({icon_emoji_id: emojiId.toString()})).icon_emoji_id).toBe(emojiId.toString());
		expect((await repository.getRole(createRoleID(BigInt(role.id)), guildId))?.toRow().icon_emoji_id).toBe(emojiId);
		await patch({unicode_emoji: '🎉'}, 400);
		expect(await patch({unicode_emoji: '🎉', icon_emoji_id: null})).toMatchObject({
			unicode_emoji: '🎉',
			icon_emoji_id: null,
		});
		await patch({unicode_emoji: null, icon_emoji_id: emojiId.toString()});
		await repository.deleteEmoji(guildId, emojiId);
		await setLevel(0);
		expect((await patch({name: 'Deleted icon', icon_emoji_id: emojiId.toString()})).icon_emoji_id).toBe(
			emojiId.toString(),
		);
		expect((await patch({icon_emoji_id: null})).icon_emoji_id).toBeNull();
		expect((await repository.getRole(createRoleID(BigInt(role.id)), guildId))?.toRow().icon_emoji_id).toBeNull();
	});

	test('creation applies the same entitlements and persists appearance', async () => {
		const create = (data: Record<string, unknown>, status = 200) =>
			createBuilder<GuildRoleResponse>(harness, owner.token)
				.post(`/guilds/${guild.id}/roles`)
				.body({name: 'New role', ...data})
				.expect(status)
				.execute();
		await create({unicode_emoji: '🎉'}, 400);
		await setLevel(2);
		expect(await create({unicode_emoji: '🎉', color_secondary: 123})).toMatchObject({
			unicode_emoji: '🎉',
			color_secondary: 123,
			icon_emoji_id: null,
		});
	});

	test('template import drops icons without the target guild entitlement', async () => {
		const importedGuild = await createBuilder<GuildResponse>(harness, owner.token)
			.post('/guilds')
			.body({
				name: 'Template target',
				template: {name: 'Source', channels: [], roles: [{id: 1, name: 'Icon', unicode_emoji: '🎉'}]},
			})
			.expect(200)
			.execute();
		const roles = await getRoles(harness, owner.token, importedGuild.id);
		expect(roles.some((role) => role.name === 'Icon')).toBe(true);
		for (const role of roles) {
			expect(role.unicode_emoji).toBeNull();
			expect(role.icon_emoji_id).toBeNull();
		}
	});

	test('appearance still requires MANAGE_ROLES', async () => {
		await setLevel(2);
		const member = await createTestAccount(harness);
		const invite = await createChannelInvite(harness, owner.token, guild.system_channel_id!);
		await acceptInvite(harness, member.token, invite.code);
		await patch({unicode_emoji: '🎉'}, 403, member.token);
	});

	describe.each(['outsider', 'member'] as const)('unauthorized %s', (kind) => {
		test.each(['create', 'update', 'delete', 'positions', 'hoist', 'resetHoist'] as const)(
			'rejects %s',
			async (operation) => {
				const caller = await createTestAccount(harness);
				if (kind === 'member') {
					const invite = await createChannelInvite(harness, owner.token, guild.system_channel_id!);
					await acceptInvite(harness, caller.token, invite.code);
				}
				const route = {
					create: {method: 'post', path: '/roles', body: {name: 'Rejected'}},
					update: {method: 'patch', path: `/roles/${role.id}`, body: {}},
					delete: {method: 'delete', path: `/roles/${role.id}`, body: undefined},
					positions: {method: 'patch', path: '/roles', body: [{id: role.id, position: 1}]},
					hoist: {method: 'patch', path: '/roles/hoist-positions', body: [{id: role.id, hoist_position: 1}]},
					resetHoist: {method: 'delete', path: '/roles/hoist-positions', body: undefined},
				} as const;
				const {method, path, body} = route[operation];
				await createBuilder(harness, caller.token)
					[method](`/guilds/${guild.id}${path}`)
					.body(body)
					.expect(kind === 'member' ? 403 : 404, kind === 'member' ? 'MISSING_PERMISSIONS' : 'UNKNOWN_GUILD')
					.execute();
			},
		);
	});

	test('MANAGE_ROLES cannot change an equal or higher role appearance', async () => {
		await setLevel(2);
		const member = await createTestAccount(harness);
		const invite = await createChannelInvite(harness, owner.token, guild.system_channel_id!);
		await acceptInvite(harness, member.token, invite.code);
		const manager = await createRole(harness, owner.token, guild.id, {
			name: 'Manager',
			permissions: Permissions.MANAGE_ROLES.toString(),
		});
		await updateMember(harness, owner.token, guild.id, member.userId, {roles: [manager.id]});
		await updateRolePositions(harness, owner.token, guild.id, [
			{id: role.id, position: 2},
			{id: manager.id, position: 1},
		]);
		await patch({unicode_emoji: '🎉', color_secondary: 123}, 403, member.token);
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createChannel,
	createRole,
	getChannel,
	setupTestGuildWithMembers,
} from '@app/api/channel/tests/ChannelTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AuditLogActionType} from '@fluxer/constants/src/AuditLogActionType';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {VOICE_ROOM_THEME_IDS} from '@fluxer/constants/src/VoiceRoomThemes';
import type {ChannelResponse} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const THEME = VOICE_ROOM_THEME_IDS[0];

interface AuditLogResponse {
	audit_log_entries: Array<{
		target_id: string | null;
		changes?: Array<{key: string; old_value?: unknown; new_value?: unknown}>;
	}>;
}

describe('Voice channel room theme', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	async function patchChannel(token: string, channelId: string, body: Record<string, unknown>, status = 200) {
		return createBuilder<ChannelResponse>(harness, token)
			.patch(`/channels/${channelId}`)
			.body(body)
			.expect(status)
			.execute();
	}

	async function themedVoiceChannel() {
		const setup = await setupTestGuildWithMembers(harness, 1);
		const voice = await createChannel(harness, setup.owner.token, setup.guild.id, 'lounge', ChannelTypes.GUILD_VOICE);
		const themed = await patchChannel(setup.owner.token, voice.id, {room_theme: THEME});
		expect(themed.room_theme).toBe(THEME);
		return {...setup, voice};
	}

	it('keeps room_theme when only the name changes', async () => {
		const {owner, voice} = await themedVoiceChannel();
		const renamed = await patchChannel(owner.token, voice.id, {name: 'renamed-lounge'});
		expect(renamed.name).toBe('renamed-lounge');
		expect(renamed.room_theme).toBe(THEME);
		expect((await getChannel(harness, owner.token, voice.id)).room_theme).toBe(THEME);
	});

	it('keeps room_theme when permission overwrites change', async () => {
		const {owner, guild, voice} = await themedVoiceChannel();
		const role = await createRole(harness, owner.token, guild.id, {name: 'Listeners'});
		const dispatchSpy = vi.spyOn(NoopGatewayService.prototype, 'dispatchGuild');
		try {
			await createBuilder(harness, owner.token)
				.put(`/channels/${voice.id}/permissions/${role.id}`)
				.body({type: 0, allow: Permissions.CONNECT.toString(), deny: '0'})
				.expect(HTTP_STATUS.NO_CONTENT)
				.execute();
			const updates = dispatchSpy.mock.calls.filter(
				([params]) => params.event === 'CHANNEL_UPDATE' && (params.data as ChannelResponse).id === voice.id,
			);
			expect(updates.length).toBeGreaterThan(0);
			for (const [params] of updates) {
				expect((params.data as ChannelResponse).room_theme).toBe(THEME);
			}
		} finally {
			dispatchSpy.mockRestore();
		}
		expect((await getChannel(harness, owner.token, voice.id)).room_theme).toBe(THEME);
	});

	it('keeps room_theme on position reorder', async () => {
		const {owner, guild, voice} = await themedVoiceChannel();
		await createBuilder(harness, owner.token)
			.patch(`/guilds/${guild.id}/channels`)
			.body([{id: voice.id, position: 0}])
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		expect((await getChannel(harness, owner.token, voice.id)).room_theme).toBe(THEME);
	});

	it('sets and clears (null) room_theme on a voice channel', async () => {
		const {owner, voice} = await themedVoiceChannel();
		expect((await getChannel(harness, owner.token, voice.id)).room_theme).toBe(THEME);
		const cleared = await patchChannel(owner.token, voice.id, {room_theme: null});
		expect(cleared.room_theme).toBeNull();
		expect((await getChannel(harness, owner.token, voice.id)).room_theme).toBeNull();
	});

	it('unknown theme → 400', async () => {
		const {owner, voice} = await themedVoiceChannel();
		await patchChannel(owner.token, voice.id, {room_theme: 'not-a-room'}, HTTP_STATUS.BAD_REQUEST);
		expect((await getChannel(harness, owner.token, voice.id)).room_theme).toBe(THEME);
	});

	it('text channel ignores room_theme', async () => {
		const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
		const text = await createChannel(harness, owner.token, guild.id, 'chat');
		const updated = await patchChannel(owner.token, text.id, {room_theme: THEME});
		expect(updated.room_theme ?? null).toBeNull();
		expect((await getChannel(harness, owner.token, text.id)).room_theme ?? null).toBeNull();
	});

	it('requires MANAGE_CHANNELS (403)', async () => {
		const {owner, members, guild} = await setupTestGuildWithMembers(harness, 1);
		const voice = await createChannel(harness, owner.token, guild.id, 'lounge', ChannelTypes.GUILD_VOICE);
		await patchChannel(members[0]!.token, voice.id, {room_theme: THEME}, HTTP_STATUS.FORBIDDEN);
		expect((await getChannel(harness, owner.token, voice.id)).room_theme ?? null).toBeNull();
	});

	it('CHANNEL_UPDATE carries room_theme', async () => {
		const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
		const voice = await createChannel(harness, owner.token, guild.id, 'lounge', ChannelTypes.GUILD_VOICE);
		const dispatchSpy = vi.spyOn(NoopGatewayService.prototype, 'dispatchGuild');
		try {
			await patchChannel(owner.token, voice.id, {room_theme: THEME});
			const updates = dispatchSpy.mock.calls.filter(
				([params]) => params.event === 'CHANNEL_UPDATE' && (params.data as ChannelResponse).id === voice.id,
			);
			expect(updates).toHaveLength(1);
			expect(updates[0]![0].guildId.toString()).toBe(guild.id);
			expect((updates[0]![0].data as ChannelResponse).room_theme).toBe(THEME);
		} finally {
			dispatchSpy.mockRestore();
		}
	});

	it('audit log change includes room_theme', async () => {
		const {owner, guild} = await setupTestGuildWithMembers(harness, 0);
		const voice = await createChannel(harness, owner.token, guild.id, 'lounge', ChannelTypes.GUILD_VOICE);
		await patchChannel(owner.token, voice.id, {room_theme: THEME});
		const log = await createBuilder<AuditLogResponse>(harness, owner.token)
			.get(`/guilds/${guild.id}/audit-logs?action_type=${AuditLogActionType.CHANNEL_UPDATE}`)
			.expect(HTTP_STATUS.OK)
			.execute();
		const entry = log.audit_log_entries.find((candidate) => candidate.target_id === voice.id);
		expect(entry?.changes).toEqual([{key: 'room_theme', old_value: null, new_value: THEME}]);
	});
});

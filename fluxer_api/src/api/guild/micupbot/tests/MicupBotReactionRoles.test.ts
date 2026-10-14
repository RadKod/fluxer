// SPDX-License-Identifier: AGPL-3.0-or-later

import {createEmojiID} from '@app/api/BrandedTypes';
import {updateRole} from '@app/api/channel/tests/ChannelTestUtils';
import type {MicupBotReactionRolePanelRow} from '@app/api/database/types/MicupBotTypes';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {MICUPBOT_TEXT} from '@app/api/guild/micupbot/MicupBotConstants';
import {
	createMicupBotReactionRoleRunner,
	type MicupBotReactionRolePayload,
} from '@app/api/guild/micupbot/MicupBotReactionRoles';
import {useMemberFixture} from '@app/api/guild/micupbot/tests/MicupBotMemberTestUtils';
import {Logger} from '@app/api/Logger';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {expect, it, vi} from 'vitest';

const fixture = useMemberFixture();
async function panelFixture(mode: MicupBotReactionRolePanelRow['mode'] = 'normal') {
	const f = await fixture();
	const {message} = await f.deps.channelService.messages.send.sendMessage({
		viewer: {kind: 'user', userId: f.botId, bot: true, capable: true},
		user: (await f.deps.userRepository.findUnique(f.botId))!,
		channelId: f.channelId,
		requestCache: createRequestCache(),
		data: {content: 'Choose a role', allowed_mentions: {parse: []}},
	});
	const entries = f.roles.map((roleId, i) => ({emoji: {name: i ? '🟢' : '🔵', id: null}, role_id: String(roleId)}));
	const panel: MicupBotReactionRolePanelRow = {
		guild_id: f.guildId,
		channel_id: f.channelId,
		message_id: message.id,
		mode,
		title: 'Roles',
		description: null,
		panel_entries: JSON.stringify(entries),
		created_by: f.botId,
		created_at: new Date(),
	};
	await f.repository.putPanel(panel);
	const payload: MicupBotReactionRolePayload = {
		kind: 'add',
		guild_id: String(f.guildId),
		channel_id: String(f.channelId),
		message_id: String(message.id),
		user_id: String(f.userId),
		emoji_name: '🔵',
		emoji_id: null,
		at: Date.now(),
	};
	return {
		...f,
		panel,
		payload,
		runner: createMicupBotReactionRoleRunner(f.deps),
		interactions: f.deps.channelRepository.messageInteractions,
	};
}

it("add then remove processed out of order ends with the reaction's real state", async () => {
	const f = await panelFixture();
	await f.interactions.addReaction(f.channelId, f.panel.message_id, f.userId, '🔵');
	await f.runner.run(f.payload);
	expect((await f.deps.guildRepository.getMember(f.guildId, f.userId))!.roleIds.has(f.roles[0]!)).toBe(true);
	await f.interactions.removeReaction(f.channelId, f.panel.message_id, f.userId, '🔵');
	await f.runner.run({...f.payload, kind: 'remove'});
	await f.runner.run(f.payload);
	expect((await f.deps.guildRepository.getMember(f.guildId, f.userId))!.roleIds.size).toBe(0);
	await f.interactions.addReaction(f.channelId, f.panel.message_id, f.userId, '🔵');
	await f.runner.run(f.payload);
	await f.runner.run({...f.payload, kind: 'remove'});
	expect((await f.deps.guildRepository.getMember(f.guildId, f.userId))!.roleIds.has(f.roles[0]!)).toBe(true);
	expect(f.revoke).toHaveBeenCalledWith(expect.objectContaining({userId: f.botId}), MICUPBOT_TEXT.audit.reactionRole);
});

it("unique mode takes the panel's other roles", async () => {
	const f = await panelFixture('unique');
	const member = (await f.deps.guildRepository.getMember(f.guildId, f.userId))!;
	await f.deps.guildRepository.upsertMember({...member.toRow(), role_ids: new Set([f.roles[1]!])});
	await f.interactions.addReaction(f.channelId, f.panel.message_id, f.userId, '🔵');
	const lock = vi.spyOn(f.deps.kvClient, 'acquireLock');
	await f.runner.run(f.payload);
	expect((await f.deps.guildRepository.getMember(f.guildId, f.userId))!.roleIds).toEqual(new Set([f.roles[0]!]));
	expect(f.grant).toHaveBeenCalledWith(
		expect.objectContaining({userId: f.botId, targetId: f.userId, roleId: f.roles[0]}),
		MICUPBOT_TEXT.audit.reactionRole,
	);
	expect(f.revoke).toHaveBeenCalledWith(
		expect.objectContaining({userId: f.botId, targetId: f.userId, roleId: f.roles[1]}),
		MICUPBOT_TEXT.audit.reactionRole,
	);
	expect(lock.mock.calls.filter(([key]) => key === `micupbot:mlock:${f.guildId}:${f.userId}`)).toHaveLength(2);
});

it.each(['same panel', 'different panels'])('concurrent unique choices reread the member (%s)', async (scenario) => {
	const f = await panelFixture('unique');
	let secondMessageId = f.panel.message_id;
	if (scenario === 'different panels') {
		const {message} = await f.deps.channelService.messages.send.sendMessage({
			viewer: {kind: 'user', userId: f.botId, bot: true, capable: true},
			user: (await f.deps.userRepository.findUnique(f.botId))!,
			channelId: f.channelId,
			requestCache: createRequestCache(),
			data: {content: 'Choose another role', allowed_mentions: {parse: []}},
		});
		secondMessageId = message.id;
		await f.repository.putPanel({...f.panel, message_id: secondMessageId});
	}
	await f.interactions.addReaction(f.channelId, f.panel.message_id, f.userId, '🔵');
	await f.interactions.addReaction(f.channelId, secondMessageId, f.userId, '🟢');
	const getRole = f.deps.guildRepository.getRole.bind(f.deps.guildRepository);
	const entered = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	vi.spyOn(f.deps.guildRepository, 'getRole').mockImplementation(async (...args) => {
		if (args[0] === f.roles[0]) {
			entered.resolve();
			await resume.promise;
		}
		return getRole(...args);
	});
	const acquire = vi.spyOn(f.deps.kvClient, 'acquireLock');
	const first = f.runner.run(f.payload);
	await entered.promise;
	const second = f.runner.run({...f.payload, message_id: String(secondMessageId), emoji_name: '🟢'});
	try {
		await vi.waitFor(() => {
			const keys = acquire.mock.calls.map(([key]) => key);
			expect(keys.some((key, index) => keys.indexOf(key) < index)).toBe(true);
		});
	} finally {
		resume.resolve();
		await Promise.all([first, second]);
	}
	expect((await f.deps.guildRepository.getMember(f.guildId, f.userId))!.roleIds).toEqual(new Set([f.roles[1]!]));
});

it('add_only never takes the role back', async () => {
	const f = await panelFixture('add_only');
	await f.interactions.addReaction(f.channelId, f.panel.message_id, f.userId, '🔵');
	await f.runner.run(f.payload);
	await f.interactions.removeReaction(f.channelId, f.panel.message_id, f.userId, '🔵');
	await f.runner.run({...f.payload, kind: 'remove'});
	expect(f.revoke).not.toHaveBeenCalled();
	expect((await f.deps.guildRepository.getMember(f.guildId, f.userId))!.roleIds.has(f.roles[0]!)).toBe(true);
});

it('an emoji not on the panel does nothing', async () => {
	const f = await panelFixture();
	const check = vi.spyOn(f.interactions, 'checkUserReactionExists');
	const rate = vi.spyOn(f.deps.kvClient, 'checkLeakyBucketLimit');
	await f.runner.run({...f.payload, emoji_name: '🟣'});
	await f.runner.run({...f.payload, emoji_id: '555'});
	expect(check).not.toHaveBeenCalled();
	expect(rate).not.toHaveBeenCalled();
	expect(f.grant).not.toHaveBeenCalled();
});

it('a role made elevated after saving is skipped', async () => {
	const f = await panelFixture('unique');
	await updateRole(f.harness, f.owner.token, f.guild.id, String(f.roles[0]), {
		permissions: Permissions.ADMINISTRATOR.toString(),
	});
	const member = (await f.deps.guildRepository.getMember(f.guildId, f.userId))!;
	await f.deps.guildRepository.upsertMember({...member.toRow(), role_ids: new Set([f.roles[1]!])});
	await f.interactions.addReaction(f.channelId, f.panel.message_id, f.userId, '🔵');
	const debug = vi.spyOn(Logger.child({}), 'debug');
	await f.runner.run(f.payload);
	expect(f.grant).not.toHaveBeenCalled();
	expect(f.revoke).not.toHaveBeenCalled();
	expect((await f.deps.guildRepository.getMember(f.guildId, f.userId))!.roleIds).toEqual(new Set([f.roles[1]!]));
	expect(debug).toHaveBeenCalledWith(expect.objectContaining({skipped: 1}), expect.any(String));
});

it('a temporary member cannot gain or lose reaction roles', async () => {
	const f = await panelFixture();
	const member = (await f.deps.guildRepository.getMember(f.guildId, f.userId))!;
	await f.deps.guildRepository.upsertMember({...member.toRow(), temporary: true, role_ids: new Set([f.roles[0]!])});
	await f.runner.run({...f.payload, kind: 'remove'});
	await f.interactions.addReaction(f.channelId, f.panel.message_id, f.userId, '🔵');
	await f.runner.run(f.payload);
	expect(f.grant).not.toHaveBeenCalled();
	expect(f.revoke).not.toHaveBeenCalled();
	expect((await f.deps.guildRepository.getMember(f.guildId, f.userId))!.isTemporary).toBe(true);
});

it('custom emoji IDs must match and reactions use the user bucket', async () => {
	const f = await panelFixture();
	await f.repository.putPanel({
		...f.panel,
		panel_entries: JSON.stringify([{emoji: {name: 'blue', id: '555'}, role_id: String(f.roles[0])}]),
	});
	await f.interactions.addReaction(f.channelId, f.panel.message_id, f.userId, 'blue', createEmojiID(555n));
	const rate = vi.spyOn(f.deps.kvClient, 'checkLeakyBucketLimit');
	const check = vi.spyOn(f.interactions, 'checkUserReactionExists');
	await f.runner.run({...f.payload, emoji_name: 'blue', emoji_id: '555'});
	expect(f.grant).toHaveBeenCalledOnce();
	expect(check).toHaveBeenCalledWith(f.channelId, f.panel.message_id, f.userId, 'blue', createEmojiID(555n));
	expect(rate).toHaveBeenCalledWith(`micupbot:rr:${f.guildId}:${f.userId}`, 10, 10000, 1);
	f.grant.mockClear();
	rate.mockResolvedValue({
		allowed: false,
		limit: 10,
		remaining: 0,
		resetAfterMs: 10000,
		resetAtMs: Date.now() + 10000,
		retryAfterMs: 10000,
	});
	await f.runner.run({...f.payload, emoji_name: 'blue', emoji_id: '555'});
	expect(f.grant).not.toHaveBeenCalled();
});

it('a mismatched custom emoji removal keeps the role while the stored reaction remains', async () => {
	const f = await panelFixture();
	await f.repository.putPanel({
		...f.panel,
		panel_entries: JSON.stringify([{emoji: {name: 'old_blue', id: '555'}, role_id: String(f.roles[0])}]),
	});
	const emojiId = createEmojiID(555n);
	await f.interactions.addReaction(f.channelId, f.panel.message_id, f.userId, 'old_blue', emojiId);
	await f.runner.run({...f.payload, emoji_name: 'old_blue', emoji_id: '555'});
	await f.interactions.removeReaction(f.channelId, f.panel.message_id, f.userId, 'new_blue', emojiId);
	expect(
		await f.interactions.checkUserReactionExists(f.channelId, f.panel.message_id, f.userId, 'old_blue', emojiId),
	).toBe(true);
	await f.runner.run({...f.payload, kind: 'remove', emoji_name: 'new_blue', emoji_id: '555'});
	expect(f.revoke).not.toHaveBeenCalled();
	expect((await f.deps.guildRepository.getMember(f.guildId, f.userId))!.roleIds).toEqual(new Set([f.roles[0]!]));
});

it('disabled jobs and missing or mismatched panels cannot change roles', async () => {
	const f = await panelFixture();
	const panel = vi.spyOn(f.repository, 'getPanel');
	overrideLimits({feature_micupbot: 0});
	await f.runner.run(f.payload);
	expect(panel).not.toHaveBeenCalled();
	overrideLimits({feature_micupbot: 1});
	await f.runner.run({...f.payload, channel_id: '999'});
	await f.repository.deletePanel(f.guildId, f.panel.message_id);
	await f.runner.run(f.payload);
	expect(f.grant).not.toHaveBeenCalled();
	expect(f.revoke).not.toHaveBeenCalled();
});

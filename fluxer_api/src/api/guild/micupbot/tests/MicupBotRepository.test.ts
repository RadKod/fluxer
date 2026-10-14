// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createUserID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {
	type MicupBotAutomodRuleRow,
	type MicupBotGuildSettingsRow,
	micupBotLevelBucket,
	micupBotSlotOf,
} from '@app/api/database/types/MicupBotTypes';
import {MicupBotRepository} from '@app/api/guild/micupbot/MicupBotRepository';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';

const g = createGuildID(20n << 22n),
	u = createUserID(3n << 22n),
	now = new Date('2026-10-02T00:00:00Z');
const settings: MicupBotGuildSettingsRow = {
	guild_id: g,
	commands_enabled: false,
	levels_enabled: false,
	automod_enabled: false,
	welcome_enabled: false,
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
	updated_by: u,
	updated_at: now,
	version: 0,
};
const rule = (name: MicupBotAutomodRuleRow['rule']): MicupBotAutomodRuleRow => ({
	guild_id: g,
	rule: name,
	enabled: true,
	action: 'delete_warn',
	threshold: 0,
	mute_seconds: 600,
	words: null,
	allowed_domains: null,
	exempt_role_ids: null,
	exempt_channel_ids: null,
	updated_by: u,
	updated_at: now,
});
const repository = new MicupBotRepository();
let executor: InMemoryCassandraQueryExecutor;
beforeEach(() => {
	executor = new InMemoryCassandraQueryExecutor();
	setCassandraQueryExecutorForTesting(executor);
});
afterEach(() => {
	vi.restoreAllMocks();
	setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
});
it('settings write applies only at the expected version', async () => {
	expect(await repository.putSettings(settings, null)).toBe(true);
	expect(await repository.putSettings({...settings, commands_enabled: true}, null)).toBe(false);
	const current = await repository.getSettings(g);
	expect(current?.version).toBe(0);
	expect(await repository.putSettings({...settings, commands_enabled: true}, 0)).toBe(true);
	expect(await repository.putSettings(settings, 0)).toBe(false);
	expect(await repository.getSettings(g)).toEqual({...settings, commands_enabled: true, version: 1});
});
it('replaceRules removes rules left out', async () => {
	await repository.replaceRules(g, [rule('links'), rule('words')]);
	const batch = vi.spyOn(executor, 'executeBatch');
	await repository.replaceRules(g, [{...rule('words'), enabled: false}]);
	expect(await repository.listRules(g)).toEqual([{...rule('words'), enabled: false}]);
	expect(batch).toHaveBeenCalledTimes(1);
	expect(batch.mock.calls[0]![1]).not.toBe(false);
	await repository.replaceRules(g, []);
	expect(await repository.listRules(g)).toEqual([]);
});
it('member levels page by bucket', async () => {
	const next = createUserID((19n << 22n) + 1n),
		other = createUserID(4n << 22n);
	await repository.setMemberXp(g, next, 200n);
	await repository.setMemberXp(g, u, 100n);
	await repository.setMemberXp(g, other, 500n);
	expect(await repository.listMemberLevelsPage(g, micupBotLevelBucket(u), null, 1)).toEqual([{userId: u, xp: 100n}]);
	expect(await repository.listMemberLevelsPage(g, micupBotLevelBucket(u), u, 5)).toEqual([{userId: next, xp: 200n}]);
	expect(await repository.getMemberXp(g, u)).toBe(100n);
	await repository.deleteMemberLevel(g, u);
	expect(await repository.getMemberXp(g, u)).toBeNull();
});
it('addWarning also records the user guild', async () => {
	const batch = vi.spyOn(executor, 'executeBatch');
	await repository.addWarning({
		guild_id: g,
		user_id: u,
		warning_id: 1n,
		moderator_id: u,
		reason: 'Reason',
		created_at: now,
	});
	expect(await repository.listUserGuilds(u)).toEqual([g]);
	expect(batch.mock.calls[0]![0]).toHaveLength(2);
	expect(batch.mock.calls[0]![1]).not.toBe(false);
});
it('warnings list newest first and count stops at 101', async () => {
	for (let n = 1; n <= 105; n++)
		await repository.addWarning({
			guild_id: g,
			user_id: u,
			warning_id: BigInt(n),
			moderator_id: u,
			reason: 'Reason',
			created_at: now,
		});
	expect((await repository.listWarnings(g, u, 2)).map((r) => r.warning_id)).toEqual([105n, 104n]);
	expect(await repository.listWarnings(g, u, 200)).toHaveLength(100);
	expect(await repository.countWarnings(g, u)).toBe(101);
	expect(await repository.deleteWarning(g, u, 105n)).toBe(true);
	expect(await repository.deleteWarning(g, u, 105n)).toBe(false);
	await repository.deleteWarnings(g, u);
	expect(await repository.countWarnings(g, u)).toBe(0);
});
it('voice slot rows add and remove', async () => {
	const next = createGuildID((4116n << 22n) + 1n),
		other = createGuildID(21n << 22n);
	for (const guild of [g, next, other]) await repository.setVoiceGuild(guild, true);
	expect(await repository.listVoiceSlot(micupBotSlotOf(g), null, 1)).toEqual([g]);
	expect(await repository.listVoiceSlot(micupBotSlotOf(g), g, 10)).toEqual([next]);
	await repository.setVoiceGuild(g, false);
	expect(await repository.listVoiceSlot(micupBotSlotOf(g), null, 10)).toEqual([next]);
});
it('user guilds list and delete', async () => {
	await repository.addUserGuild(u, g);
	await repository.addUserGuild(u, g);
	expect(await repository.listUserGuilds(u)).toEqual([g]);
	await repository.deleteUserGuilds(u);
	expect(await repository.listUserGuilds(u)).toEqual([]);
});

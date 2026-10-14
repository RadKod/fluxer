// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineTable} from '@app/api/database/CassandraTableDsl';
import {
	MICUPBOT_AUTOMOD_RULE_COLUMNS,
	MICUPBOT_GUILD_SETTINGS_COLUMNS,
	MICUPBOT_LEVEL_REWARD_COLUMNS,
	MICUPBOT_MEMBER_LEVEL_COLUMNS,
	MICUPBOT_REACTION_ROLE_PANEL_COLUMNS,
	MICUPBOT_USER_GUILD_COLUMNS,
	MICUPBOT_VOICE_GUILD_BY_SLOT_COLUMNS,
	MICUPBOT_WARNING_COLUMNS,
	type MicupBotAutomodRuleRow,
	type MicupBotGuildSettingsRow,
	type MicupBotLevelRewardRow,
	type MicupBotMemberLevelRow,
	type MicupBotReactionRolePanelRow,
	type MicupBotUserGuildRow,
	type MicupBotVoiceGuildBySlotRow,
	type MicupBotWarningRow,
} from '@app/api/database/types/MicupBotTypes';
export const MicupBotGuildSettings = defineTable<MicupBotGuildSettingsRow, 'guild_id', 'guild_id'>({
	name: 'micupbot_guild_settings',
	columns: MICUPBOT_GUILD_SETTINGS_COLUMNS,
	primaryKey: ['guild_id'],
	partitionKey: ['guild_id'],
});
export const MicupBotAutomodRules = defineTable<MicupBotAutomodRuleRow, 'guild_id' | 'rule', 'guild_id'>({
	name: 'micupbot_automod_rules',
	columns: MICUPBOT_AUTOMOD_RULE_COLUMNS,
	primaryKey: ['guild_id', 'rule'],
	partitionKey: ['guild_id'],
});
export const MicupBotReactionRolePanels = defineTable<
	MicupBotReactionRolePanelRow,
	'guild_id' | 'message_id',
	'guild_id'
>({
	name: 'micupbot_reaction_role_panels',
	columns: MICUPBOT_REACTION_ROLE_PANEL_COLUMNS,
	primaryKey: ['guild_id', 'message_id'],
	partitionKey: ['guild_id'],
});
export const MicupBotLevelRewards = defineTable<MicupBotLevelRewardRow, 'guild_id' | 'level', 'guild_id'>({
	name: 'micupbot_level_rewards',
	columns: MICUPBOT_LEVEL_REWARD_COLUMNS,
	primaryKey: ['guild_id', 'level'],
	partitionKey: ['guild_id'],
});

// TEMPORARY: 16 buckets; above 100 MB per partition, dual-write a new 64-bucket table and switch reads.
export const MicupBotMemberLevels = defineTable<
	MicupBotMemberLevelRow,
	'guild_id' | 'bucket' | 'user_id',
	'guild_id' | 'bucket'
>({
	name: 'micupbot_member_levels',
	columns: MICUPBOT_MEMBER_LEVEL_COLUMNS,
	primaryKey: ['guild_id', 'bucket', 'user_id'],
	partitionKey: ['guild_id', 'bucket'],
});
export const MicupBotWarnings = defineTable<
	MicupBotWarningRow,
	'guild_id' | 'user_id' | 'warning_id',
	'guild_id' | 'user_id'
>({
	name: 'micupbot_warnings',
	columns: MICUPBOT_WARNING_COLUMNS,
	primaryKey: ['guild_id', 'user_id', 'warning_id'],
	partitionKey: ['guild_id', 'user_id'],
});
export const MicupBotVoiceGuildsBySlot = defineTable<MicupBotVoiceGuildBySlotRow, 'slot' | 'guild_id', 'slot'>({
	name: 'micupbot_voice_guilds_by_slot',
	columns: MICUPBOT_VOICE_GUILD_BY_SLOT_COLUMNS,
	primaryKey: ['slot', 'guild_id'],
	partitionKey: ['slot'],
});
export const MicupBotUserGuilds = defineTable<MicupBotUserGuildRow, 'user_id' | 'guild_id', 'user_id'>({
	name: 'micupbot_user_guilds',
	columns: MICUPBOT_USER_GUILD_COLUMNS,
	primaryKey: ['user_id', 'guild_id'],
	partitionKey: ['user_id'],
});

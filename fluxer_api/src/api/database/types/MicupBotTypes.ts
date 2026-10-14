// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, GuildID, MessageID, RoleID, UserID} from '@app/api/BrandedTypes';

export interface MicupBotGuildSettingsRow {
	guild_id: GuildID;
	commands_enabled: boolean;
	levels_enabled: boolean;
	automod_enabled: boolean;
	welcome_enabled: boolean;
	welcome_channel_id: ChannelID | null;
	welcome_message: string | null;
	welcome_embed: boolean;
	goodbye_enabled: boolean;
	goodbye_channel_id: ChannelID | null;
	goodbye_message: string | null;
	goodbye_embed: boolean;
	autorole_ids: Set<RoleID> | null;
	level_up_message_enabled: boolean;
	level_up_channel_id: ChannelID | null;
	level_up_message: string | null;
	no_xp_channel_ids: Set<ChannelID> | null;
	no_xp_role_ids: Set<RoleID> | null;
	voice_xp_enabled: boolean;
	updated_by: UserID;
	updated_at: Date;
	version: number;
}
export const MICUPBOT_GUILD_SETTINGS_COLUMNS = [
	'guild_id',
	'commands_enabled',
	'levels_enabled',
	'automod_enabled',
	'welcome_enabled',
	'welcome_channel_id',
	'welcome_message',
	'welcome_embed',
	'goodbye_enabled',
	'goodbye_channel_id',
	'goodbye_message',
	'goodbye_embed',
	'autorole_ids',
	'level_up_message_enabled',
	'level_up_channel_id',
	'level_up_message',
	'no_xp_channel_ids',
	'no_xp_role_ids',
	'voice_xp_enabled',
	'updated_by',
	'updated_at',
	'version',
] as const satisfies ReadonlyArray<keyof MicupBotGuildSettingsRow>;

export interface MicupBotAutomodRuleRow {
	guild_id: GuildID;
	rule: 'spam' | 'invites' | 'links' | 'words' | 'mentions' | 'caps';
	enabled: boolean;
	action: 'delete' | 'delete_warn' | 'delete_mute';
	threshold: number;
	mute_seconds: number;
	words: Set<string> | null;
	allowed_domains: Set<string> | null;
	exempt_role_ids: Set<RoleID> | null;
	exempt_channel_ids: Set<ChannelID> | null;
	updated_by: UserID;
	updated_at: Date;
}
export const MICUPBOT_AUTOMOD_RULE_COLUMNS = [
	'guild_id',
	'rule',
	'enabled',
	'action',
	'threshold',
	'mute_seconds',
	'words',
	'allowed_domains',
	'exempt_role_ids',
	'exempt_channel_ids',
	'updated_by',
	'updated_at',
] as const satisfies ReadonlyArray<keyof MicupBotAutomodRuleRow>;

export interface MicupBotReactionRolePanelRow {
	guild_id: GuildID;
	message_id: MessageID;
	channel_id: ChannelID;
	mode: 'normal' | 'unique' | 'add_only';
	title: string;
	description: string | null;
	panel_entries: string;
	created_by: UserID;
	created_at: Date;
}
export const MICUPBOT_REACTION_ROLE_PANEL_COLUMNS = [
	'guild_id',
	'message_id',
	'channel_id',
	'mode',
	'title',
	'description',
	'panel_entries',
	'created_by',
	'created_at',
] as const satisfies ReadonlyArray<keyof MicupBotReactionRolePanelRow>;

export interface MicupBotLevelRewardRow {
	guild_id: GuildID;
	level: number;
	role_id: RoleID;
	updated_by: UserID;
	updated_at: Date;
}
export const MICUPBOT_LEVEL_REWARD_COLUMNS = [
	'guild_id',
	'level',
	'role_id',
	'updated_by',
	'updated_at',
] as const satisfies ReadonlyArray<keyof MicupBotLevelRewardRow>;

export interface MicupBotMemberLevelRow {
	guild_id: GuildID;
	bucket: number;
	user_id: UserID;
	xp: bigint;
	updated_at: Date;
}
export const MICUPBOT_MEMBER_LEVEL_COLUMNS = [
	'guild_id',
	'bucket',
	'user_id',
	'xp',
	'updated_at',
] as const satisfies ReadonlyArray<keyof MicupBotMemberLevelRow>;

export interface MicupBotWarningRow {
	guild_id: GuildID;
	user_id: UserID;
	warning_id: bigint;
	moderator_id: UserID;
	reason: string;
	created_at: Date;
}
export const MICUPBOT_WARNING_COLUMNS = [
	'guild_id',
	'user_id',
	'warning_id',
	'moderator_id',
	'reason',
	'created_at',
] as const satisfies ReadonlyArray<keyof MicupBotWarningRow>;

export interface MicupBotVoiceGuildBySlotRow {
	slot: number;
	guild_id: GuildID;
}
export const MICUPBOT_VOICE_GUILD_BY_SLOT_COLUMNS = ['slot', 'guild_id'] as const satisfies ReadonlyArray<
	keyof MicupBotVoiceGuildBySlotRow
>;

export interface MicupBotUserGuildRow {
	user_id: UserID;
	guild_id: GuildID;
	updated_at: Date;
}
export const MICUPBOT_USER_GUILD_COLUMNS = ['user_id', 'guild_id', 'updated_at'] as const satisfies ReadonlyArray<
	keyof MicupBotUserGuildRow
>;

export const MICUPBOT_LEVEL_BUCKETS = 16;
export const MICUPBOT_SLOT_COUNT = 4096;
export const MICUPBOT_XP_COUNTER = 'micupbot_xp';
export const MICUPBOT_XP_DIRTY_SET = 'micupbot_xp';
export function micupBotLevelBucket(userId: UserID): number {
	return Number((BigInt(userId) >> 22n) % 16n);
}
export function micupBotSlotOf(guildId: GuildID): number {
	return Number((BigInt(guildId) >> 22n) % 4096n);
}
export function micupBotXpCounterId(guildId: GuildID, userId: UserID): string {
	return `${guildId}:${userId}`;
}

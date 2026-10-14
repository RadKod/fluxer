// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	MICUPBOT_AUTOMOD_ACTIONS,
	MICUPBOT_AUTOMOD_RULES,
	MICUPBOT_LIMITS,
	MICUPBOT_PANEL_MODES,
} from '@fluxer/schema/src/domains/micupbot/MicupBotRequestSchemas';
import {UserPartialResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {Int32Type, SnowflakeStringType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';
export const MicupBotSettings = z.object({
	commands_enabled: z.boolean(),
	levels_enabled: z.boolean(),
	automod_enabled: z.boolean(),
	welcome_enabled: z.boolean(),
	welcome_channel_id: SnowflakeStringType.nullable(),
	welcome_message: z.string().nullable(),
	welcome_embed: z.boolean(),
	goodbye_enabled: z.boolean(),
	goodbye_channel_id: SnowflakeStringType.nullable(),
	goodbye_message: z.string().nullable(),
	goodbye_embed: z.boolean(),
	autorole_ids: z.array(SnowflakeStringType),
	level_up_message_enabled: z.boolean(),
	level_up_channel_id: SnowflakeStringType.nullable(),
	level_up_message: z.string().nullable(),
	no_xp_channel_ids: z.array(SnowflakeStringType),
	no_xp_role_ids: z.array(SnowflakeStringType),
	voice_xp_enabled: z.boolean(),
	updated_at: z.string().nullable(),
});
export type MicupBotSettings = z.infer<typeof MicupBotSettings>;
export const MicupBotSettingsResponse = z.object({
	feature_enabled: z.boolean(),
	bot: z
		.object({
			application_id: SnowflakeStringType,
			user_id: SnowflakeStringType,
			in_guild: z.boolean(),
			mfa_blocked: z.boolean(),
		})
		.nullable(),
	invite_permissions: z.literal('1099780156480'),
	join_notification_conflict: z.boolean(),
	role_warnings: z.array(z.string()),
	settings: MicupBotSettings,
	default_messages: z.object({welcome: z.string(), goodbye: z.string(), level_up: z.string()}),
	limits: z.object({
		templateMax: z.literal(MICUPBOT_LIMITS.templateMax),
		autoroleMax: z.literal(MICUPBOT_LIMITS.autoroleMax),
		noXpChannelsMax: z.literal(MICUPBOT_LIMITS.noXpChannelsMax),
		noXpRolesMax: z.literal(MICUPBOT_LIMITS.noXpRolesMax),
		rulesMax: z.literal(MICUPBOT_LIMITS.rulesMax),
		wordsMax: z.literal(MICUPBOT_LIMITS.wordsMax),
		wordMin: z.literal(MICUPBOT_LIMITS.wordMin),
		wordMax: z.literal(MICUPBOT_LIMITS.wordMax),
		domainsMax: z.literal(MICUPBOT_LIMITS.domainsMax),
		exemptMax: z.literal(MICUPBOT_LIMITS.exemptMax),
		panelsMax: z.literal(MICUPBOT_LIMITS.panelsMax),
		panelEntriesMax: z.literal(MICUPBOT_LIMITS.panelEntriesMax),
		panelTitleMax: z.literal(MICUPBOT_LIMITS.panelTitleMax),
		panelDescriptionMax: z.literal(MICUPBOT_LIMITS.panelDescriptionMax),
		rewardsMax: z.literal(MICUPBOT_LIMITS.rewardsMax),
		levelMax: z.literal(MICUPBOT_LIMITS.levelMax),
		muteMinSeconds: z.literal(MICUPBOT_LIMITS.muteMinSeconds),
		muteMaxSeconds: z.literal(MICUPBOT_LIMITS.muteMaxSeconds),
		muteDefaultSeconds: z.literal(MICUPBOT_LIMITS.muteDefaultSeconds),
		warningsMax: z.literal(MICUPBOT_LIMITS.warningsMax),
		warningReasonMax: z.literal(MICUPBOT_LIMITS.warningReasonMax),
		leaderboardPage: z.literal(MICUPBOT_LIMITS.leaderboardPage),
		leaderboardMax: z.literal(MICUPBOT_LIMITS.leaderboardMax),
	}),
});
export type MicupBotSettingsResponse = z.infer<typeof MicupBotSettingsResponse>;
export const MicupBotAutomodRule = z.object({
	rule: z.enum(MICUPBOT_AUTOMOD_RULES),
	enabled: z.boolean(),
	action: z.enum(MICUPBOT_AUTOMOD_ACTIONS),
	threshold: Int32Type,
	mute_seconds: Int32Type,
	words: z.array(z.string()),
	allowed_domains: z.array(z.string()),
	exempt_role_ids: z.array(SnowflakeStringType),
	exempt_channel_ids: z.array(SnowflakeStringType),
});
export type MicupBotAutomodRule = z.infer<typeof MicupBotAutomodRule>;
export const MicupBotAutomodResponse = z.object({rules: z.array(MicupBotAutomodRule)});
export type MicupBotAutomodResponse = z.infer<typeof MicupBotAutomodResponse>;
export const MicupBotReactionRolePanelResponse = z.object({
	message_id: SnowflakeStringType,
	channel_id: SnowflakeStringType,
	mode: z.enum(MICUPBOT_PANEL_MODES),
	title: z.string(),
	description: z.string().nullable(),
	entries: z.array(
		z.object({emoji: z.object({name: z.string(), id: SnowflakeStringType.nullable()}), role_id: SnowflakeStringType}),
	),
	created_at: z.string(),
});
export type MicupBotReactionRolePanelResponse = z.infer<typeof MicupBotReactionRolePanelResponse>;
export const MicupBotReactionRolePanelListResponse = z.object({
	panels: z.array(MicupBotReactionRolePanelResponse),
	max_panels: Int32Type,
});
export type MicupBotReactionRolePanelListResponse = z.infer<typeof MicupBotReactionRolePanelListResponse>;
export const MicupBotLevelRewardsResponse = z.object({
	rewards: z.array(z.object({level: Int32Type, role_id: SnowflakeStringType})),
	max_rewards: Int32Type,
});
export type MicupBotLevelRewardsResponse = z.infer<typeof MicupBotLevelRewardsResponse>;
export const MicupBotLeaderboardResponse = z.object({
	levels_enabled: z.boolean(),
	total: Int32Type,
	entries: z.array(
		z.object({
			rank: Int32Type,
			user_id: SnowflakeStringType,
			xp: z.number(),
			level: Int32Type,
			user: UserPartialResponse.nullable(),
		}),
	),
});
export type MicupBotLeaderboardResponse = z.infer<typeof MicupBotLeaderboardResponse>;
export const MicupBotWarningListResponse = z.object({
	warnings: z.array(
		z.object({id: SnowflakeStringType, moderator_id: SnowflakeStringType, reason: z.string(), created_at: z.string()}),
	),
});
export type MicupBotWarningListResponse = z.infer<typeof MicupBotWarningListResponse>;

// SPDX-License-Identifier: AGPL-3.0-or-later

import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {GuildIdParam, GuildIdUserIdParam} from '@fluxer/schema/src/domains/common/CommonParamSchemas';
import {createStringType, Int32Type, SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

export const MICUPBOT_LIMITS = {
	templateMax: 1000,
	autoroleMax: 5,
	noXpChannelsMax: 50,
	noXpRolesMax: 50,
	rulesMax: 6,
	wordsMax: 200,
	wordMin: 3,
	wordMax: 64,
	domainsMax: 50,
	exemptMax: 50,
	panelsMax: 25,
	panelEntriesMax: 20,
	panelTitleMax: 100,
	panelDescriptionMax: 1000,
	rewardsMax: 25,
	levelMax: 500,
	muteMinSeconds: 60,
	muteMaxSeconds: 2_419_200,
	muteDefaultSeconds: 600,
	warningsMax: 100,
	warningReasonMax: 512,
	leaderboardPage: 100,
	leaderboardMax: 1000,
} as const;
export const MICUPBOT_AUTOMOD_RULES = ['spam', 'invites', 'links', 'words', 'mentions', 'caps'] as const;
export const MICUPBOT_AUTOMOD_ACTIONS = ['delete', 'delete_warn', 'delete_mute'] as const;
export const MICUPBOT_PANEL_MODES = ['normal', 'unique', 'add_only'] as const;
export const MICUPBOT_THRESHOLDS = {
	spam: {min: 3, max: 20, def: 5},
	mentions: {min: 3, max: 50, def: 5},
	caps: {min: 50, max: 100, def: 70},
} as const;
const distinct = <T>(values: Array<T>): boolean => new Set(values).size === values.length;
const uniqueIds = (max: number) =>
	z.array(SnowflakeType).max(max).refine(distinct, {message: ValidationErrorCodes.INVALID_FORMAT});
export const MicupBotSettingsUpdateRequest = z
	.object({
		commands_enabled: z.boolean(),
		levels_enabled: z.boolean(),
		automod_enabled: z.boolean(),
		welcome_enabled: z.boolean(),
		welcome_channel_id: SnowflakeType.nullable(),
		welcome_message: createStringType(1, 1000).nullable(),
		welcome_embed: z.boolean(),
		goodbye_enabled: z.boolean(),
		goodbye_channel_id: SnowflakeType.nullable(),
		goodbye_message: createStringType(1, 1000).nullable(),
		goodbye_embed: z.boolean(),
		autorole_ids: uniqueIds(5),
		level_up_message_enabled: z.boolean(),
		level_up_channel_id: SnowflakeType.nullable(),
		level_up_message: createStringType(1, 1000).nullable(),
		no_xp_channel_ids: uniqueIds(50),
		no_xp_role_ids: uniqueIds(50),
		voice_xp_enabled: z.boolean(),
	})
	.partial()
	.refine((data) => Object.values(data).some((value) => value !== undefined), {
		message: ValidationErrorCodes.INVALID_FORMAT,
	});
export type MicupBotSettingsUpdateRequest = z.infer<typeof MicupBotSettingsUpdateRequest>;
export const MicupBotAutomodRuleRequest = z
	.object({
		rule: z.enum(MICUPBOT_AUTOMOD_RULES),
		enabled: z.boolean(),
		action: z.enum(MICUPBOT_AUTOMOD_ACTIONS).default('delete_warn'),
		threshold: Int32Type,
		mute_seconds: Int32Type.min(60).max(2_419_200).default(600),
		// `*` is allowed only as a leading/trailing wildcard, and the word itself keeps 3+ characters.
		words: z
			.array(
				createStringType(3, 64).refine((word) => /^\*?[^*]{3,}\*?$/u.test(word), {
					message: ValidationErrorCodes.INVALID_FORMAT,
				}),
			)
			.max(200)
			.default([]),
		allowed_domains: z.array(createStringType(1, 253)).max(50).default([]),
		exempt_role_ids: uniqueIds(50).default([]),
		exempt_channel_ids: uniqueIds(50).default([]),
	})
	.superRefine((data, ctx) => {
		const threshold =
			data.rule === 'spam' || data.rule === 'mentions' || data.rule === 'caps'
				? MICUPBOT_THRESHOLDS[data.rule]
				: {min: 0, max: 0};
		if (data.threshold < threshold.min || data.threshold > threshold.max)
			ctx.addIssue({code: 'custom', path: ['threshold'], message: ValidationErrorCodes.INVALID_FORMAT});
		if (data.rule !== 'words' && data.words.length)
			ctx.addIssue({code: 'custom', path: ['words'], message: ValidationErrorCodes.INVALID_FORMAT});
		if (data.rule !== 'links' && data.allowed_domains.length)
			ctx.addIssue({code: 'custom', path: ['allowed_domains'], message: ValidationErrorCodes.INVALID_FORMAT});
	});
export type MicupBotAutomodRuleRequest = z.infer<typeof MicupBotAutomodRuleRequest>;
export const MicupBotAutomodUpdateRequest = z.object({
	rules: z
		.array(MicupBotAutomodRuleRequest)
		.max(6)
		.refine((rules) => distinct(rules.map((r) => r.rule)), {message: ValidationErrorCodes.INVALID_FORMAT}),
});
export type MicupBotAutomodUpdateRequest = z.infer<typeof MicupBotAutomodUpdateRequest>;
export const MicupBotReactionRolePanelCreateRequest = z.object({
	channel_id: SnowflakeType,
	mode: z.enum(MICUPBOT_PANEL_MODES).default('normal'),
	title: createStringType(1, 100),
	description: createStringType(0, 1000).optional(),
	entries: z
		.array(
			z.object({emoji: z.object({name: createStringType(1, 64), id: SnowflakeType.nullish()}), role_id: SnowflakeType}),
		)
		.min(1)
		.max(20)
		.refine(
			(entries) =>
				distinct(entries.map((e) => e.role_id)) &&
				distinct(entries.map((e) => (e.emoji.id == null ? `name:${e.emoji.name}` : `id:${e.emoji.id}`))),
			{message: ValidationErrorCodes.INVALID_FORMAT},
		),
});
export type MicupBotReactionRolePanelCreateRequest = z.infer<typeof MicupBotReactionRolePanelCreateRequest>;
export const MicupBotLevelRewardsUpdateRequest = z.object({
	rewards: z
		.array(z.object({level: Int32Type.min(1).max(500), role_id: SnowflakeType}))
		.max(25)
		.refine((rewards) => distinct(rewards.map((r) => r.level)), {message: ValidationErrorCodes.INVALID_FORMAT}),
});
export type MicupBotLevelRewardsUpdateRequest = z.infer<typeof MicupBotLevelRewardsUpdateRequest>;
export const MicupBotLeaderboardQuery = z.object({
	offset: z.coerce.number().int().min(0).max(900).default(0),
	limit: z.coerce.number().int().min(1).max(100).default(100),
});
export type MicupBotLeaderboardQuery = z.infer<typeof MicupBotLeaderboardQuery>;
export const GuildIdMessageIdParam = GuildIdParam.extend({message_id: SnowflakeType});
export const GuildIdUserIdWarningIdParam = GuildIdUserIdParam.extend({warning_id: SnowflakeType});

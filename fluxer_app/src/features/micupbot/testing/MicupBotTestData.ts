// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	MICUPBOT_AUTOMOD_RULES,
	MICUPBOT_LIMITS,
	MICUPBOT_THRESHOLDS,
} from '@fluxer/schema/src/domains/micupbot/MicupBotRequestSchemas';
import type {MicupBotSettingsResponse} from '@fluxer/schema/src/domains/micupbot/MicupBotResponseSchemas';

export const GUILD_ID = '1485064866382176262';
export function settingsResponse(extra: Partial<MicupBotSettingsResponse> = {}): MicupBotSettingsResponse {
	return {
		feature_enabled: true,
		bot: {application_id: '1485064866382176267', user_id: '1485064866382176267', in_guild: true, mfa_blocked: false},
		invite_permissions: '1099780156480',
		join_notification_conflict: false,
		role_warnings: [],
		limits: MICUPBOT_LIMITS,
		default_messages: {welcome: 'Welcome {user}', goodbye: 'Goodbye {user.name}', level_up: 'Level {level}'},
		settings: {
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
			autorole_ids: [],
			level_up_message_enabled: true,
			level_up_channel_id: null,
			level_up_message: null,
			no_xp_channel_ids: [],
			no_xp_role_ids: [],
			voice_xp_enabled: false,
			updated_at: null,
		},
		...extra,
	};
}

export function responseFor(path: string, data = settingsResponse()): unknown {
	if (path.endsWith('/settings')) return data;
	if (path.endsWith('/automod'))
		return {
			rules: MICUPBOT_AUTOMOD_RULES.map((rule) => ({
				rule,
				enabled: false,
				action: 'delete_warn',
				threshold: rule === 'spam' || rule === 'mentions' || rule === 'caps' ? MICUPBOT_THRESHOLDS[rule].def : 0,
				mute_seconds: 600,
				words: [],
				allowed_domains: [],
				exempt_role_ids: [],
				exempt_channel_ids: [],
			})),
		};
	if (path.endsWith('/reaction-roles')) return {panels: [], max_panels: MICUPBOT_LIMITS.panelsMax};
	if (path.endsWith('/level-rewards')) return {rewards: [], max_rewards: MICUPBOT_LIMITS.rewardsMax};
	if (path.includes('/leaderboard')) return {levels_enabled: false, total: 0, entries: []};
	if (path.endsWith('/public')) return {name: 'Official test application'};
	if (path.includes('/warnings/')) return {warnings: []};
	throw new Error(`Unexpected request: ${path}`);
}

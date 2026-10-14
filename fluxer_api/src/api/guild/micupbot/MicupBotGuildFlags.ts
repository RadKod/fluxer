// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID} from '@app/api/BrandedTypes';
import type {MicupBotAutomodRuleRow, MicupBotGuildSettingsRow} from '@app/api/database/types/MicupBotTypes';
import {mapGuildToGuildResponse} from '@app/api/guild/GuildModel';
import type {MicupBotRepository} from '@app/api/guild/micupbot/MicupBotRepository';
import type {IGuildRepositoryAggregate} from '@app/api/guild/repositories/IGuildRepositoryAggregate';
import {withGuildUpdateLock} from '@app/api/guild/services/GuildService';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import type {ICacheService} from '@pkgs/cache/src/ICacheService';

const FLAGS = [
	GuildFeatures.MICUPBOT_COMMANDS,
	GuildFeatures.MICUPBOT_LEVELS,
	GuildFeatures.MICUPBOT_AUTOMOD,
	GuildFeatures.MICUPBOT_JOIN,
];
export function desiredMicupBotFlags({
	settings,
	rules,
	botPresent,
}: {
	settings: MicupBotGuildSettingsRow | null;
	rules: Array<MicupBotAutomodRuleRow>;
	botPresent: boolean;
}): Set<string> {
	const flags = new Set<string>();
	if (!settings || !botPresent) return flags;
	if (settings.commands_enabled) flags.add(GuildFeatures.MICUPBOT_COMMANDS);
	if (settings.levels_enabled) flags.add(GuildFeatures.MICUPBOT_LEVELS);
	if (settings.automod_enabled && rules.some((r) => r.enabled)) flags.add(GuildFeatures.MICUPBOT_AUTOMOD);
	if (settings.welcome_enabled || settings.goodbye_enabled || (settings.autorole_ids?.size ?? 0) > 0)
		flags.add(GuildFeatures.MICUPBOT_JOIN);
	return flags;
}
export async function syncMicupBotGuildFlags({
	guildId,
	botPresent,
	deps,
}: {
	guildId: GuildID;
	botPresent: boolean;
	deps: {
		guildRepository: IGuildRepositoryAggregate;
		gatewayService: IGatewayService;
		cacheService: ICacheService;
		repository: MicupBotRepository;
	};
}): Promise<boolean> {
	const updated = await withGuildUpdateLock(deps.cacheService, guildId, async () => {
		const guild = await deps.guildRepository.findUnique(guildId);
		if (!guild) return null;
		const settings = await deps.repository.getSettings(guildId),
			rules = await deps.repository.listRules(guildId);
		const desired = desiredMicupBotFlags({settings, rules, botPresent}),
			features = new Set(guild.features);
		for (const flag of FLAGS) {
			if (desired.has(flag)) features.add(flag);
			else features.delete(flag);
		}
		if (features.size === guild.features.size && [...features].every((f) => guild.features.has(f))) return null;
		return deps.guildRepository.upsertPartial(guildId, {features}, guild.toRow());
	});
	if (!updated) return false;
	await deps.gatewayService.dispatchGuild({guildId, event: 'GUILD_UPDATE', data: mapGuildToGuildResponse(updated)});
	return true;
}

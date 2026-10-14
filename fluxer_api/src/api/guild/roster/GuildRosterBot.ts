// SPDX-License-Identifier: AGPL-3.0-or-later

import {type ApplicationID, applicationIdToUserId, createApplicationID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {resolveLimitSafe} from '@app/api/limits/LimitConfigUtils';
import {createLimitMatchContext} from '@app/api/limits/LimitMatchContextBuilder';
import {DEFAULT_RESTRICTED_LIMITS} from '@fluxer/limits/src/LimitDefaults';
import {SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';

let cachedConfiguredId: string | undefined;
let cachedApplicationId: ApplicationID | null = null;

export function rosterBotApplicationId(): ApplicationID | null {
	const configuredId = Config.instance.rosterBotApplicationId;
	if (configuredId !== cachedConfiguredId) {
		const parsed = SnowflakeType.safeParse(configuredId);
		cachedApplicationId = parsed.success && parsed.data > 0n ? createApplicationID(parsed.data) : null;
		cachedConfiguredId = configuredId;
	}
	return cachedApplicationId;
}

export function rosterBotUserId(): UserID | null {
	const applicationId = rosterBotApplicationId();
	return applicationId === null ? null : applicationIdToUserId(applicationId);
}

export function isGuildRosterLive(limitConfigService: LimitConfigService): boolean {
	return (
		rosterBotApplicationId() !== null &&
		resolveLimitSafe(
			limitConfigService.getConfigSnapshot(),
			createLimitMatchContext({user: null}),
			'feature_guild_roster',
			DEFAULT_RESTRICTED_LIMITS.feature_guild_roster,
		) !== 0
	);
}

// SPDX-License-Identifier: AGPL-3.0-or-later

import {type ApplicationID, applicationIdToUserId, createApplicationID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {resolveLimitSafe} from '@app/api/limits/LimitConfigUtils';
import {createLimitMatchContext} from '@app/api/limits/LimitMatchContextBuilder';
import {DEFAULT_RESTRICTED_LIMITS} from '@fluxer/limits/src/LimitDefaults';
import {SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
export function micupBotApplicationId(): ApplicationID | null {
	const result = SnowflakeType.safeParse(Config.instance.micupBotApplicationId);
	return result.success && result.data > 0n ? createApplicationID(result.data) : null;
}
export function micupBotUserId(): UserID | null {
	const id = micupBotApplicationId();
	return id === null ? null : applicationIdToUserId(id);
}
export function isMicupBotLive(limitConfigService: LimitConfigService): boolean {
	return (
		micupBotApplicationId() !== null &&
		resolveLimitSafe(
			limitConfigService.getConfigSnapshot(),
			createLimitMatchContext({user: null}),
			'feature_micupbot',
			DEFAULT_RESTRICTED_LIMITS.feature_micupbot,
		) !== 0
	);
}

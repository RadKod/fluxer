// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {resolveLimitSafe} from '@app/api/limits/LimitConfigUtils';
import {createLimitMatchContext} from '@app/api/limits/LimitMatchContextBuilder';
import type {IUserRepository} from '@app/api/user/IUserRepository';
import {ContentWarningLevel} from '@fluxer/constants/src/GuildConstants';
import {FeatureTemporarilyDisabledError} from '@fluxer/errors/src/domains/core/FeatureTemporarilyDisabledError';
import type {LimitMatchContext} from '@fluxer/limits/src/LimitTypes';

export interface MatureContentSettings {
	readonly nsfw: boolean | null;
	readonly contentWarningLevel: number | null;
	readonly contentWarningText: string | null;
}

// While feature_mature_content_settings is 0 a write may keep or clear these settings, but not turn one on or set new warning text.
export async function assertMatureContentSettingsWrite(params: {
	limitConfigService: LimitConfigService;
	userRepository: IUserRepository;
	userId: UserID;
	current: MatureContentSettings;
	next: MatureContentSettings;
}): Promise<void> {
	const {current, next} = params;
	const turnsOn =
		(next.nsfw === true && current.nsfw !== true) ||
		(next.contentWarningLevel === ContentWarningLevel.CONTENT_WARNING &&
			current.contentWarningLevel !== ContentWarningLevel.CONTENT_WARNING) ||
		(next.contentWarningText !== null && next.contentWarningText !== current.contentWarningText);
	if (!turnsOn) return;
	const user = await params.userRepository.findUnique(params.userId);
	assertMatureContentSettingsEnabled(params.limitConfigService, createLimitMatchContext({user}));
}

export function isMatureContentSettingsEnabled(
	limitConfigService: LimitConfigService,
	ctx: LimitMatchContext,
): boolean {
	return resolveLimitSafe(limitConfigService.getConfigSnapshot(), ctx, 'feature_mature_content_settings', 0) !== 0;
}

export function assertMatureContentSettingsEnabled(
	limitConfigService: LimitConfigService,
	ctx: LimitMatchContext,
): void {
	if (!isMatureContentSettingsEnabled(limitConfigService, ctx)) {
		throw new FeatureTemporarilyDisabledError();
	}
}

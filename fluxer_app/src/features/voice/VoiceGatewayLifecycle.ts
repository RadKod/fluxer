// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GatewayErrorData} from '@app/features/gateway/transport/GatewaySocket';
import type {GuildReadyData} from '@app/features/gateway/types/GatewayGuildTypes';
import SessionManager from '@app/features/platform/state/AuthSession';
import UsernameSelection from '@app/features/user/state/UsernameSelection';
import Users from '@app/features/user/state/Users';
import {isUsernameSelectionRequired} from '@app/features/user/utils/UsernameSelectionGateUtils';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';

export function seedVoiceStatesFromReady(guilds: Array<GuildReadyData>): void {
	MediaEngine.handleGatewayReady(guilds);
}

export function reportGatewayErrorToVoice(error: GatewayErrorData): void {
	if (isUsernameSelectionRequired(error)) {
		UsernameSelection.requireSelection(SessionManager.currentAccountKey, Users.currentUser?.identityVersion);
	}
	MediaEngine.handleGatewayError(error);
}

export function teardownVoiceForFatalGatewayCrash(): void {
	MediaEngine.cleanup();
}

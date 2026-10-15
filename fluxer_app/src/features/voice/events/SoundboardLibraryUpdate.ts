// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import Users from '@app/features/user/state/Users';
import SoundboardLibrary, {type SoundboardLibraryUpdatePayload} from '@app/features/voice/state/SoundboardLibrary';

export function handleSoundboardLibraryUpdate(
	data: SoundboardLibraryUpdatePayload,
	context: GatewayHandlerContext,
): void {
	if (context.accountKey !== Users.viewAccountKey) return;
	SoundboardLibrary.applyUpdate(data);
}

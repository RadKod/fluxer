// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandMicPort} from '@app/features/activities/band/flow/BandMicGuard';
import * as VoiceStateCommands from '@app/features/devtools/commands/VoiceStateCommands';
import Keybind from '@app/features/input/state/InputKeybind';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import LocalVoiceState from '@app/features/voice/state/LocalVoiceState';

// The call's own controls, used the way the voice settings menu and the mute button use them.
export const VOICE_MIC_PORT: BandMicPort = {
	hasPushToTalkKey: () => Keybind.hasPushToTalkKeybind(),
	transmitMode: () => Keybind.transmitMode,
	setTransmitMode: (mode) => {
		Keybind.setTransmitMode(mode);
		MediaEngine.handlePushToTalkModeChange();
	},
	isMuted: () => VoiceStateCommands.getCurrentSelfMute(),
	isDeafened: () => LocalVoiceState.getSelfDeaf(),
	toggleMute: () => VoiceStateCommands.toggleSelfMute(null),
};

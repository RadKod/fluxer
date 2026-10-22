// SPDX-License-Identifier: AGPL-3.0-or-later

import {type BandMicPort, recoverBandMicHold} from '@app/features/activities/band/flow/BandMicGuard';
import type {BandVoicePort} from '@app/features/activities/band/flow/BandSingerVoice';
import * as VoiceStateCommands from '@app/features/devtools/commands/VoiceStateCommands';
import Keybind, {KEYBIND_STORE_NAME} from '@app/features/input/state/InputKeybind';
import {awaitHydration} from '@app/features/platform/utils/MobXPersistence';
import UserSettings from '@app/features/user/state/UserSettings';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import LocalVoiceState from '@app/features/voice/state/LocalVoiceState';
import {setRemoteVoicePlaybackBoostExemptUserIds} from '@app/features/voice/state/RemoteVoicePlaybackBoost';
import VoiceProcessingOverride from '@app/features/voice/state/VoiceProcessingOverride';
import {when} from 'mobx';

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
	setMuted: (muted) => LocalVoiceState.updateSelfMute(muted),
};

// The call's processing for a singer: an override that is never saved, and the remote playback leveller.
export const VOICE_SINGER_PORT: BandVoicePort = {
	setSingerMic: (output) => VoiceProcessingOverride.setMusic(output),
	setUnlevelledVoices: (userIds) => setRemoteVoicePlaybackBoostExemptUserIds(userIds),
};

// Repairs a mic hold the last run left behind. It waits for the saved keybinds and voice state, and for the account
// settings: with sync on, those bring the other devices' transmit mode, which is the guard's push-to-talk if that run
// already sent it, and arriving after the repair they would put it straight back.
export function startBandMicHoldRecovery(): () => void {
	const settingsHydrated = when(() => UserSettings.isHydrated());
	Promise.all([settingsHydrated, awaitHydration(KEYBIND_STORE_NAME), awaitHydration('LocalVoiceState')]).then(
		() => recoverBandMicHold(VOICE_MIC_PORT),
		() => {},
	);
	return () => settingsHydrated.cancel();
}

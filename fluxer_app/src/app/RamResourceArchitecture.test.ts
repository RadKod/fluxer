// SPDX-License-Identifier: AGPL-3.0-or-later

import {readdirSync, readFileSync} from 'node:fs';
import {join, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RESOURCE_CALL =
	/\b(?:new\s+(?:AudioContext|OfflineAudioContext)|createMediaElementSource|getUserMedia|getDisplayMedia)\s*\(/;
const REVIEW_MESSAGE = 'RAM kuralları 1–3: sahip + söküm göster, listeye gerekçeyle ekle';

// Existing owners are a review baseline, not proof that their teardown follows the RAM rules.
const APP_OWNERS = [
	'features/channel/components/VoiceMessageRecorder.tsx',
	'features/devtools/commands/VoiceStateCommands.tsx',
	'features/notification/utils/SoundUtils.ts',
	'features/user/components/modals/tabs/hooks/useMicTest.tsx',
	'features/voice/components/VoiceMessageComposerModal.tsx',
	'features/voice/components/modals/screen_share_picker_modal/PickerGrid.tsx',
	'features/voice/engine/v2/VoiceEngineV2AppMediaExecutionAdapter.tsx',
	'features/voice/engine/voice_screen_share_manager/DeviceMediaCapture.ts',
	'features/voice/engine/voice_screen_share_manager/DisplayMediaCapture.ts',
	'features/voice/utils/InAppMediaSoundCapture.ts',
	'features/voice/utils/LinuxScreenShareAudio.ts',
	'features/voice/utils/VoiceDeviceManager.ts',
	'features/voice/utils/native_screen_capture_bridge/createChromiumPreviewBridge.ts',
];

const LIVEKIT_OWNERS = [
	'room/DeviceManager.ts',
	'room/Room.ts',
	'room/participant/LocalParticipant.ts',
	'room/track/LocalTrack.ts',
	'room/track/create.ts',
	'room/track/utils.ts',
	'room/utils.ts',
];

describe('RAM resource ownership architecture', () => {
	it.each([
		['src', APP_OWNERS],
		['pkgs/livekit-client/src', LIVEKIT_OWNERS],
	] as const)('keeps resource calls in the reviewed owners of %s', (directory, owners) => {
		const root = join(APP_ROOT, directory);
		const files = readdirSync(root, {recursive: true, encoding: 'utf8'})
			.map((file) => file.split(sep).join('/'))
			.filter((file) => /\.[cm]?[jt]sx?$/.test(file))
			.filter((file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file))
			.filter((file) => !/(?:^|\/)(?:__tests__|tests)\//.test(file));
		const actual = files.filter((file) => RESOURCE_CALL.test(readFileSync(join(root, file), 'utf8'))).sort();
		expect(actual, REVIEW_MESSAGE).toEqual([...owners].sort());
	});
});

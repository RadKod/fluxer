// SPDX-License-Identifier: AGPL-3.0-or-later

import {AccountScopedWork} from '@app/features/platform/state/AccountScopedWork';
import VoiceEngineV2AppSubscriptionAdapter from '@app/features/voice/engine/v2/VoiceEngineV2AppSubscriptionAdapter';
import {RoomCameraSubscriptions} from '@app/features/voice_scene/video/RoomCameraSubscriptions';

// The open room's camera subscriptions; VoiceSceneAvatar and the TV read qualityOf(identity).
const RoomCameraStore = new RoomCameraSubscriptions(VoiceEngineV2AppSubscriptionAdapter);
AccountScopedWork.registerCancellation(() => RoomCameraStore.releaseAll());
export default RoomCameraStore;

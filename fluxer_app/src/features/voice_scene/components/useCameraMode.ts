// SPDX-License-Identifier: AGPL-3.0-or-later

import type {SceneCameraMode, VoiceSceneHandle} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {useEffect, useState} from 'react';

export function useCameraMode(handle: VoiceSceneHandle | null): SceneCameraMode {
	const [mode, setMode] = useState<SceneCameraMode>(() => handle?.getCameraMode() ?? 'orbit');
	useEffect(() => {
		if (!handle) return;
		setMode(handle.getCameraMode());
		return handle.onCameraModeChange(setMode);
	}, [handle]);
	return handle ? mode : 'orbit';
}

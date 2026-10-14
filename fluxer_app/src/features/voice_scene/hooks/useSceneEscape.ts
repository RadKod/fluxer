// SPDX-License-Identifier: AGPL-3.0-or-later

import type {VoiceSceneHandle} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {useEffect} from 'react';

const OWN_ESCAPE_SELECTOR = 'input, textarea, select, [contenteditable="true"], [role="dialog"][aria-modal="true"]';

// Esc leaves the TV focus or the seat view for the room. Typing and modal dialogs keep their own Esc; popouts stop
// it before it reaches the window. A channel composer may have marked the event handled for itself (it always
// does), so that flag is not read here.
export function useSceneEscape(handle: VoiceSceneHandle): void {
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key !== 'Escape' || event.isComposing || handle.getCameraMode() === 'orbit') return;
			if (event.target instanceof Element && event.target.closest(OWN_ESCAPE_SELECTOR)) return;
			handle.exitToOrbit();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [handle]);
}

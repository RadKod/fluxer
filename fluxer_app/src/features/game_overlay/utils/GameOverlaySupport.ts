// SPDX-License-Identifier: AGPL-3.0-or-later

import {getElectronAPI, isNativeWindows} from '@app/features/ui/utils/NativeUtils';

// Windows desktop app only, and only builds whose preload exposes the overlay bridge.
export function isGameOverlaySupported(): boolean {
	return isNativeWindows() && getElectronAPI()?.setGameOverlayLayout != null;
}

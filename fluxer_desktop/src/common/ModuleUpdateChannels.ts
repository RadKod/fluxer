// SPDX-License-Identifier: AGPL-3.0-or-later

import type {DesktopModuleAPI} from '@fluxer/desktop_ipc/src/ModuleContract';

// sanalyer: upstream dropped the module pending-update channels from the shared contract (the renderer now reads
// DESKTOP_UPDATE_* from newer shells), but this shell still delivers renderer updates as modules and the renderer
// keeps the optional DesktopModuleAPI methods for shells like this one. The channel names are the ones the renderer
// has always used.
export const DESKTOP_MODULE_UPDATE_CHANNELS = Object.freeze({
	pendingUpdate: 'desktop-modules:pending-update',
	applyPendingUpdate: 'desktop-modules:apply-pending-update',
} as const);

export const DESKTOP_MODULE_UPDATE_EVENTS = Object.freeze({
	pendingUpdateChanged: 'desktop-modules:pending-update-changed',
} as const);

// The shared contract stopped exporting the pending-update payload type; derive it from the optional API method.
export type DesktopPendingModuleUpdate = NonNullable<
	Awaited<ReturnType<NonNullable<DesktopModuleAPI['pendingUpdate']>>>
>;

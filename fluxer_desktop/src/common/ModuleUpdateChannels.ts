// SPDX-License-Identifier: AGPL-3.0-or-later

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

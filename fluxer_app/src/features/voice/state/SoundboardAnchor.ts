// SPDX-License-Identifier: AGPL-3.0-or-later

// sanalyer: the voice panel's soundboard button registers itself here so the SOUNDBOARD_TOGGLE handler (button click
// or keybind) can anchor the soundboard popout to it. Without a mounted button the panel falls back to a modal.
export const SOUNDBOARD_POPOUT_KEY = 'soundboard-popout';
const anchors = new Set<HTMLElement>();

export function registerSoundboardAnchor(element: HTMLElement): () => void {
	anchors.add(element);
	return () => {
		anchors.delete(element);
	};
}

export function getSoundboardAnchor(): HTMLElement | null {
	let latest: HTMLElement | null = null;
	for (const element of anchors) {
		if (element.isConnected) latest = element;
	}
	return latest;
}

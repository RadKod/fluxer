// SPDX-License-Identifier: AGPL-3.0-or-later

import type React from 'react';
import {useEffect, useRef} from 'react';

function isTextEntry(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

// A plain key press (no modifier, not typed into a text field) with focus anywhere in the activity panel around `root`.
export function isBandPanelKey(root: HTMLElement | null, event: KeyboardEvent): boolean {
	if (event.altKey || event.ctrlKey || event.metaKey || isTextEntry(event.target)) return false;
	const panel = root?.closest('section') ?? root;
	return !!panel && event.target instanceof Node && panel.contains(event.target);
}

// Plain key presses while focus is anywhere in the activity panel around `rootRef`. The panel stops keys from bubbling
// past itself, so the listener runs in the capture phase.
export function useBandKeys(
	rootRef: React.RefObject<HTMLElement | null>,
	onKey: (key: string, event: KeyboardEvent) => void,
): void {
	const handler = useRef(onKey);
	handler.current = onKey;
	useEffect(() => {
		const listener = (event: KeyboardEvent) => {
			if (event.repeat || !isBandPanelKey(rootRef.current, event)) return;
			handler.current(event.key.toLowerCase(), event);
		};
		document.addEventListener('keydown', listener, true);
		return () => document.removeEventListener('keydown', listener, true);
	}, [rootRef]);
}

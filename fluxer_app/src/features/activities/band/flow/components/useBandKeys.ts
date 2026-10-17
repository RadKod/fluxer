// SPDX-License-Identifier: AGPL-3.0-or-later

import type React from 'react';
import {useEffect, useRef} from 'react';

function isTextEntry(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

// Plain key presses while focus is anywhere in the activity panel around `rootRef`, except in a text field. The panel
// stops keys from bubbling past itself, so the listener runs in the capture phase.
export function useBandKeys(
	rootRef: React.RefObject<HTMLElement | null>,
	onKey: (key: string, event: KeyboardEvent) => void,
): void {
	const handler = useRef(onKey);
	handler.current = onKey;
	useEffect(() => {
		const listener = (event: KeyboardEvent) => {
			if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || isTextEntry(event.target)) return;
			const root = rootRef.current;
			const panel = root?.closest('section') ?? root;
			if (!panel || !(event.target instanceof Node) || !panel.contains(event.target)) return;
			handler.current(event.key.toLowerCase(), event);
		};
		document.addEventListener('keydown', listener, true);
		return () => document.removeEventListener('keydown', listener, true);
	}, [rootRef]);
}

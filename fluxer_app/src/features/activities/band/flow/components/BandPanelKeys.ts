// SPDX-License-Identifier: AGPL-3.0-or-later

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

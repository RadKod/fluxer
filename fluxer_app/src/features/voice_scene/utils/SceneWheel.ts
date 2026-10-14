// SPDX-License-Identifier: AGPL-3.0-or-later

// DOM over the room's canvas (the TV, avatars, labels) hands the wheel on to the camera, unless the content under the
// pointer can still scroll that way itself (a list, a menu).
export function wheelStaysInside(event: WheelEvent, boundary: Element): boolean {
	for (
		let node = event.target instanceof Element ? event.target : null;
		node && node !== boundary;
		node = node.parentElement
	)
		if (canScroll(node, event.deltaY)) return true;
	return false;
}

function canScroll(element: Element, deltaY: number): boolean {
	if (!(element instanceof HTMLElement) || element.scrollHeight <= element.clientHeight) return false;
	const overflow = getComputedStyle(element).overflowY;
	if (overflow !== 'auto' && overflow !== 'scroll') return false;
	return deltaY < 0 ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight;
}

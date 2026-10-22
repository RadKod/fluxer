// SPDX-License-Identifier: AGPL-3.0-or-later

// Where the activity's View lives. The View (a canvas, an audio graph, a running song) is rendered once, through a
// portal, into one element that this dock owns and moves: into the tile, the expanded stage or the mini window, or
// into a hidden parking spot when none of them is on screen. Moving a DOM node does not touch React, so nothing
// remounts and the song plays on through every move; clipping, stacking, scrolling and the browser's fullscreen all
// follow the place it sits in, which overlaying a fixed box on top of a placeholder would not.

import styles from '@app/features/activities/components/ActivityViewDock.module.css';
import {action, makeObservable, observable} from 'mobx';

export type ActivityViewPlacement = 'mini' | 'tile' | 'stage';

// When two places are mounted at once (a navigation between them), the bigger one wins.
const PLACEMENT_PRIORITY: Readonly<Record<ActivityViewPlacement, number>> = {mini: 0, tile: 1, stage: 2};

interface ActivityViewSlot {
	readonly element: HTMLElement;
	readonly placement: ActivityViewPlacement;
	readonly order: number;
}

export class ActivityViewDock {
	// Null while the View is parked out of sight.
	placement: ActivityViewPlacement | null = null;
	// Focus is inside the View and the activity holds the keyboard: keys go to the game, not to chat.
	keysCaptured = false;

	private readonly slots: Array<ActivityViewSlot> = [];
	private slotCount = 0;
	private hostElement: HTMLDivElement | null = null;
	private parkingElement: HTMLDivElement | null = null;
	// Focus taken along a move that went through the parking spot: in one React commit the old place unmounts before
	// the new one registers, so the View is parked for an instant in between.
	private focusInTransit: HTMLElement | null = null;

	constructor(private readonly ownerDocument: () => Document = () => document) {
		makeObservable<ActivityViewDock, 'place'>(this, {
			placement: observable,
			keysCaptured: observable,
			setKeysCaptured: action,
			place: action,
		});
	}

	// The portal target. Created once and only ever moved, so React keeps the same tree under it.
	get host(): HTMLDivElement {
		if (!this.hostElement) {
			const host = this.ownerDocument().createElement('div');
			host.className = styles.host;
			host.dataset.activityViewHost = 'true';
			this.hostElement = host;
			// Read during render, so it goes straight to where place() would put it, without observable changes.
			(this.bestSlot()?.element ?? this.parking()).appendChild(host);
		}
		return this.hostElement;
	}

	register(element: HTMLElement, placement: ActivityViewPlacement): () => void {
		const slot: ActivityViewSlot = {element, placement, order: ++this.slotCount};
		this.slots.push(slot);
		this.place();
		return () => {
			const index = this.slots.indexOf(slot);
			if (index === -1) return;
			this.slots.splice(index, 1);
			this.place();
		};
	}

	setKeysCaptured(captured: boolean): void {
		this.keysCaptured = captured;
	}

	private bestSlot(): ActivityViewSlot | null {
		let best: ActivityViewSlot | null = null;
		for (const slot of this.slots) {
			if (
				!best ||
				PLACEMENT_PRIORITY[slot.placement] > PLACEMENT_PRIORITY[best.placement] ||
				(PLACEMENT_PRIORITY[slot.placement] === PLACEMENT_PRIORITY[best.placement] && slot.order > best.order)
			) {
				best = slot;
			}
		}
		return best;
	}

	private parking(): HTMLDivElement {
		const doc = this.ownerDocument();
		if (!this.parkingElement?.isConnected) {
			const parking = this.parkingElement ?? doc.createElement('div');
			parking.className = styles.parking;
			parking.setAttribute('aria-hidden', 'true');
			parking.inert = true;
			doc.body.appendChild(parking);
			this.parkingElement = parking;
		}
		return this.parkingElement;
	}

	private place(): void {
		const slot = this.bestSlot();
		this.placement = slot?.placement ?? null;
		const host = this.hostElement;
		if (!host) return;
		const target = slot?.element ?? this.parking();
		if (host.parentElement === target) return;
		// A moved node loses focus; a player in the middle of a song keeps the keyboard across the move.
		const active = this.ownerDocument().activeElement;
		const focused = active instanceof HTMLElement && host.contains(active) ? active : this.focusInTransit;
		target.appendChild(host);
		if (!focused || !host.contains(focused)) return;
		if (slot) {
			this.focusInTransit = null;
			focused.focus({preventScroll: true});
			return;
		}
		this.focusInTransit = focused;
		queueMicrotask(() => {
			if (this.focusInTransit === focused) this.focusInTransit = null;
		});
	}
}

export default new ActivityViewDock();

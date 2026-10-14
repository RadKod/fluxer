// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	ROOM_CAMERA_DOWNGRADE_HOLD_MS,
	ROOM_CAMERA_HIGH_MAX,
	ROOM_CAMERA_MAX,
	ROOM_CAMERA_MEDIUM_MAX,
	ROOM_CAMERA_UNSUBSCRIBE_GRACE_MS,
	type RoomCameraQuality,
} from '@app/features/voice_scene/video/CameraSubscriptionPlan';
import {action, makeObservable, observableRef} from 'mobx';

// Fluxer's managed camera path (VideoSubscriptionManager through the v2 subscription adapter); nothing else.
export interface RoomCameraVideoAdapter {
	subscribeToVideo(identity: string, element: HTMLElement | null, quality: RoomCameraQuality): void;
	setVideoQuality(identity: string, quality: RoomCameraQuality): void;
	unsubscribeFromVideo(identity: string): void;
}

const RANK: Record<RoomCameraQuality, number> = {low: 0, medium: 1, high: 2};

type Pending = {kind: 'downgrade' | 'release'; timer: ReturnType<typeof setTimeout>};

// while the room is open it is the only owner of camera subscriptions; unmounting releases all of them in the
// same commit, before the call grid's tiles take theirs. Upgrades and new cameras go at once; a downgrade waits 1 s and
// a camera that left the plan 2 s, so turning the view does not flap — unless waiting would break the caps.
// A camera a popout window takes over is handed to it untouched.
export class RoomCameraSubscriptions {
	planned: ReadonlyMap<string, RoomCameraQuality> = new Map();
	private readonly held = new Map<string, RoomCameraQuality>();
	private readonly pending = new Map<string, Pending>();
	// Left to a popout while the room held it; the manager may still keep the room's entry for it.
	private readonly handedOver = new Set<string>();

	constructor(private readonly adapter: RoomCameraVideoAdapter) {
		makeObservable<this, 'settle'>(this, {
			planned: observableRef,
			apply: action,
			releaseAll: action,
			settle: action,
		});
	}

	qualityOf(identity: string): RoomCameraQuality | null {
		return this.planned.get(identity) ?? null;
	}

	// Subscribed by the room, a camera on its way out (grace, downgrade hold) included.
	holds(identity: string): boolean {
		return this.held.has(identity);
	}

	apply(plan: ReadonlyMap<string, RoomCameraQuality>, externallyHeld: ReadonlySet<string> = new Set()): void {
		// Same plan as before → no new map, so avatars observing it do not re-render.
		if (!samePlan(plan, this.planned)) this.planned = plan;
		for (const identity of externallyHeld) {
			if (!this.held.has(identity)) continue;
			this.cancel(identity);
			this.held.delete(identity);
			this.handedOver.add(identity);
		}
		for (const [identity, quality] of this.held) {
			const wanted = plan.get(identity);
			if (wanted === undefined) this.defer(identity, 'release');
			else if (RANK[wanted] < RANK[quality]) this.defer(identity, 'downgrade');
			else this.cancel(identity);
		}
		const next = new Map(this.held);
		for (const [identity, quality] of plan) {
			const current = this.held.get(identity);
			if (current === undefined || RANK[quality] > RANK[current]) next.set(identity, quality);
		}
		if (!withinCaps(next)) for (const identity of [...this.pending.keys()]) this.settle(identity);
		for (const [identity, quality] of plan) {
			const current = this.held.get(identity);
			if (current === undefined) this.subscribe(identity, quality);
			else if (RANK[quality] > RANK[current]) this.adapter.setVideoQuality(identity, quality);
			else continue;
			this.held.set(identity, quality);
		}
	}

	releaseAll(): void {
		for (const {timer} of this.pending.values()) clearTimeout(timer);
		this.pending.clear();
		for (const identity of this.held.keys()) this.adapter.unsubscribeFromVideo(identity);
		this.held.clear();
		this.planned = new Map();
	}

	// The manager ignores the quality when it already has an entry (VideoSubscriptionManager.ts:68-76), so it is set
	// again; an entry the room left to a popout is cleared first so the subscription really happens.
	private subscribe(identity: string, quality: RoomCameraQuality): void {
		if (this.handedOver.delete(identity)) this.adapter.unsubscribeFromVideo(identity);
		this.adapter.subscribeToVideo(identity, null, quality);
		this.adapter.setVideoQuality(identity, quality);
	}

	private defer(identity: string, kind: Pending['kind']): void {
		if (this.pending.get(identity)?.kind === kind) return;
		this.cancel(identity);
		const delay = kind === 'release' ? ROOM_CAMERA_UNSUBSCRIBE_GRACE_MS : ROOM_CAMERA_DOWNGRADE_HOLD_MS;
		this.pending.set(identity, {kind, timer: setTimeout(() => this.settle(identity), delay)});
	}

	private cancel(identity: string): void {
		const entry = this.pending.get(identity);
		if (!entry) return;
		clearTimeout(entry.timer);
		this.pending.delete(identity);
	}

	// Brings one camera to the latest plan.
	private settle(identity: string): void {
		this.cancel(identity);
		const wanted = this.planned.get(identity);
		if (wanted === undefined) {
			this.adapter.unsubscribeFromVideo(identity);
			this.held.delete(identity);
		} else if (this.held.get(identity) !== wanted) {
			this.adapter.setVideoQuality(identity, wanted);
			this.held.set(identity, wanted);
		}
	}
}

function samePlan(a: ReadonlyMap<string, RoomCameraQuality>, b: ReadonlyMap<string, RoomCameraQuality>): boolean {
	if (a.size !== b.size) return false;
	for (const [identity, quality] of a) if (b.get(identity) !== quality) return false;
	return true;
}

function withinCaps(held: ReadonlyMap<string, RoomCameraQuality>): boolean {
	let medium = 0;
	let high = 0;
	for (const quality of held.values()) {
		if (quality === 'medium') medium++;
		if (quality === 'high') high++;
	}
	return held.size <= ROOM_CAMERA_MAX && medium <= ROOM_CAMERA_MEDIUM_MAX && high <= ROOM_CAMERA_HIGH_MAX;
}

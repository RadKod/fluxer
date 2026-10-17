// SPDX-License-Identifier: AGPL-3.0-or-later

// Runs BandRoomMachine wherever this client is the leader and routes my intents to whoever is. Leadership can move at
// any time (the session elects); the controller checks on every message and tick, so the new leader simply continues
// from the last broadcast state.

import type {BandIntent, BandState} from '@app/features/activities/band/BandProtocol';
import {
	type BandRoomContext,
	createBandRoomState,
	isBandState,
	parseBandIntent,
	reduceBandIntent,
	tickBandRoom,
} from '@app/features/activities/band/flow/BandRoomMachine';
import type {ActivityMessage, ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import {Logger} from '@app/features/platform/utils/AppLogger';

export const BAND_TICK_MS = 250;

const logger = new Logger('BandLeaderController');

export interface BandControllerTimers {
	setInterval(callback: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

const GLOBAL_TIMERS: BandControllerTimers = {
	setInterval: (callback, ms) => setInterval(callback, ms),
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class BandLeaderController {
	private unsubscribe: (() => void) | null = null;
	private interval: unknown = null;

	constructor(
		private readonly session: ActivitySession,
		private readonly context: () => BandRoomContext,
		private readonly timers: BandControllerTimers = GLOBAL_TIMERS,
	) {}

	get state(): BandState | null {
		return isBandState(this.session.state) ? this.session.state : null;
	}

	start(): void {
		if (this.unsubscribe) return;
		this.unsubscribe = this.session.onMessage((message) => this.handleMessage(message));
		this.interval = this.timers.setInterval(() => this.tick(), BAND_TICK_MS);
		this.tick();
	}

	stop(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.interval !== null) this.timers.clearInterval(this.interval);
		this.interval = null;
	}

	sendIntent(intent: BandIntent): void {
		if (this.session.isLeader) {
			this.apply(intent, this.session.me.userId);
			return;
		}
		const leader = this.session.leader;
		if (!leader) return;
		this.session.send(intent, {to: [leader.identity]}).catch((error: unknown) => {
			logger.warn('Intent did not reach the leader', {type: intent.t, error});
		});
	}

	tick(): void {
		if (!this.session.isLeader) return;
		const now = this.session.clock.now();
		const ctx = this.context();
		const current = this.state;
		this.commit(current, current ? tickBandRoom(current, now, ctx) : createBandRoomState(now, ctx));
	}

	private handleMessage({from, payload}: ActivityMessage): void {
		if (!this.session.isLeader) return;
		const intent = parseBandIntent(payload);
		if (intent) this.apply(intent, from.userId);
	}

	private apply(intent: BandIntent, fromUserId: string): void {
		const now = this.session.clock.now();
		const ctx = this.context();
		const current = this.state ?? createBandRoomState(now, ctx);
		this.commit(this.state, reduceBandIntent(current, intent, fromUserId, now, ctx));
	}

	private commit(previous: BandState | null, next: BandState): void {
		if (next === previous) return;
		if (!this.session.setState(next)) logger.warn('Band state was not broadcast', {phase: next.phase});
	}
}

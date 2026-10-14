// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GameActivity, PresenceRecord} from '@app/features/gateway/types/GatewayPresenceTypes';
import {action, makeObservable, observable} from 'mobx';

function sameActivity(left: GameActivity | null, right: GameActivity | null): boolean {
	if (left === right) return true;
	if (!left || !right || left.started_at !== right.started_at) return false;
	if ('game_id' in left) return 'game_id' in right && left.game_id === right.game_id;
	return 'manual_name' in right && left.manual_name === right.manual_name;
}

export class GameActivityStore {
	enabled = false;
	private rolloutEpoch = -1;
	private activities = new Map<string, GameActivity>();
	private listeners = new Map<string, Set<() => void>>();

	constructor() {
		makeObservable(this, {enabled: observable, handleRollout: action, resetRollout: action});
	}

	handleRollout(data: unknown): void {
		const rollout = data as {game_activity_enabled?: unknown; game_activity_epoch?: unknown} | null;
		if (
			!rollout ||
			typeof rollout.game_activity_enabled !== 'boolean' ||
			typeof rollout.game_activity_epoch !== 'number' ||
			!Number.isSafeInteger(rollout.game_activity_epoch) ||
			rollout.game_activity_epoch < 0
		) {
			this.enabled = false;
			this.reset();
			return;
		}
		if (rollout.game_activity_epoch < this.rolloutEpoch) return;
		this.rolloutEpoch = rollout.game_activity_epoch;
		this.enabled = rollout.game_activity_enabled;
		if (!this.enabled) this.reset();
	}

	resetRollout(): void {
		this.enabled = false;
		this.rolloutEpoch = -1;
		this.reset();
	}

	get(userId: string): GameActivity | null {
		return this.activities.get(userId) ?? null;
	}

	subscribe(userId: string, listener: () => void): () => void {
		if (!this.enabled) return () => {};
		let listeners = this.listeners.get(userId);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(userId, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.listeners.delete(userId);
		};
	}

	update(record: PresenceRecord): void {
		if (!this.enabled || record.guild_id != null || !Object.hasOwn(record, 'game_activity')) return;
		const activity = record.game_activity;
		if (activity === undefined) return;
		const userId = record.user.id;
		if (activity === null) {
			this.clear(userId);
			return;
		}
		if (sameActivity(this.get(userId), activity)) return;
		this.activities.set(userId, {...activity});
		this.notify(userId);
	}

	clear(userId: string): void {
		if (this.activities.delete(userId)) this.notify(userId);
	}

	reset(): void {
		this.replaceReady([]);
	}

	replaceReady(records: ReadonlyArray<PresenceRecord>): void {
		const previous = this.activities;
		const next = new Map<string, GameActivity>();
		for (const record of this.enabled ? records : []) {
			if (record.guild_id != null || !Object.hasOwn(record, 'game_activity')) continue;
			const userId = record.user.id;
			const activity = record.game_activity;
			if (activity === undefined) continue;
			if (activity === null) {
				next.delete(userId);
				continue;
			}
			const old = previous.get(userId) ?? null;
			next.set(userId, old && sameActivity(old, activity) ? old : {...activity});
		}
		this.activities = next;
		for (const userId of this.listeners.keys()) {
			if (!sameActivity(previous.get(userId) ?? null, this.get(userId))) this.notify(userId);
		}
	}

	private notify(userId: string): void {
		for (const listener of this.listeners.get(userId) ?? []) listener();
	}
}

export default new GameActivityStore();

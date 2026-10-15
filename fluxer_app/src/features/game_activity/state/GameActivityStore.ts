// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GameActivity, PresenceRecord} from '@app/features/gateway/types/GatewayPresenceTypes';
import {action, makeObservable, observable} from 'mobx';

function sameActivity(left: GameActivity | null, right: GameActivity | null): boolean {
	if (left === right) return true;
	if (!left || !right || left.started_at !== right.started_at) return false;
	if ('game_id' in left) return 'game_id' in right && left.game_id === right.game_id;
	return 'manual_name' in right && left.manual_name === right.manual_name;
}

const FRIEND_SCOPE = 'friend';

function scopeOf(record: PresenceRecord): string {
	return record.guild_id == null ? FRIEND_SCOPE : `guild:${record.guild_id}`;
}

function displayOf(scopes: ReadonlyMap<string, GameActivity> | undefined): GameActivity | null {
	if (!scopes) return null;
	return scopes.get(FRIEND_SCOPE) ?? scopes.values().next().value ?? null;
}

export class GameActivityStore {
	enabled = false;
	private rolloutEpoch = -1;
	private activities = new Map<string, Map<string, GameActivity>>();
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
		return displayOf(this.activities.get(userId));
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
		if (!this.enabled || !Object.hasOwn(record, 'game_activity')) return;
		const activity = record.game_activity;
		if (activity === undefined) return;
		const userId = record.user.id;
		const scope = scopeOf(record);
		if (activity === null) {
			this.removeScope(userId, scope);
			return;
		}
		const scopes = this.activities.get(userId) ?? new Map<string, GameActivity>();
		const old = scopes.get(scope);
		if (old && sameActivity(old, activity)) return;
		const before = displayOf(scopes);
		scopes.set(scope, {...activity});
		this.activities.set(userId, scopes);
		if (!sameActivity(before, displayOf(scopes))) this.notify(userId);
	}

	clearFriend(userId: string): void {
		this.removeScope(userId, FRIEND_SCOPE);
	}

	clear(userId: string): void {
		const before = this.get(userId);
		if (this.activities.delete(userId) && before) this.notify(userId);
	}

	clearGuild(guildId: string): void {
		const scope = `guild:${guildId}`;
		for (const userId of this.activities.keys()) this.removeScope(userId, scope);
	}

	reset(): void {
		this.replaceReady([]);
	}

	replaceReady(records: ReadonlyArray<PresenceRecord>): void {
		const previous = this.activities;
		const next = new Map<string, Map<string, GameActivity>>();
		for (const record of this.enabled ? records : []) {
			if (record.guild_id != null || !Object.hasOwn(record, 'game_activity')) continue;
			const userId = record.user.id;
			const activity = record.game_activity;
			if (activity === undefined) continue;
			if (activity === null) {
				next.delete(userId);
				continue;
			}
			const old = previous.get(userId)?.get(FRIEND_SCOPE);
			next.set(userId, new Map([[FRIEND_SCOPE, old && sameActivity(old, activity) ? old : {...activity}]]));
		}
		this.activities = next;
		for (const userId of this.listeners.keys()) {
			if (!sameActivity(displayOf(previous.get(userId)), this.get(userId))) this.notify(userId);
		}
	}

	private removeScope(userId: string, scope: string): void {
		const scopes = this.activities.get(userId);
		if (!scopes?.has(scope)) return;
		const before = displayOf(scopes);
		scopes.delete(scope);
		if (scopes.size === 0) this.activities.delete(userId);
		if (!sameActivity(before, displayOf(scopes))) this.notify(userId);
	}

	private notify(userId: string): void {
		for (const listener of this.listeners.get(userId) ?? []) listener();
	}
}

export default new GameActivityStore();

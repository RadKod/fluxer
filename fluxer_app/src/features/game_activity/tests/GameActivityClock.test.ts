// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	GameActivityMinuteClock,
	getGameActivityElapsed,
} from '@app/features/game_activity/state/GameActivityMinuteClock';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

describe('GameActivityMinuteClock', () => {
	let clock: GameActivityMinuteClock;
	let documentEvents: EventTarget;
	let hidden: boolean;
	const cleanups: Array<() => void> = [];

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(600_000);
		hidden = false;
		documentEvents = new EventTarget();
		vi.stubGlobal('document', {
			get hidden() {
				return hidden;
			},
			addEventListener: documentEvents.addEventListener.bind(documentEvents),
			removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
		});
		clock = new GameActivityMinuteClock();
	});

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	function subscribe(listener: () => void): () => void {
		const cleanup = clock.subscribe(listener);
		cleanups.push(cleanup);
		return cleanup;
	}

	function setHidden(value: boolean): void {
		hidden = value;
		documentEvents.dispatchEvent(new Event('visibilitychange'));
	}

	it('one_clock_for_visible_subscribers', () => {
		const first = vi.fn();
		const second = vi.fn();
		expect(vi.getTimerCount()).toBe(0);
		subscribe(first);
		subscribe(second);
		expect(vi.getTimerCount()).toBe(1);
		const snapshot = clock.getSnapshot();
		vi.advanceTimersByTime(59_999);
		expect(clock.getSnapshot()).toBe(snapshot);
		expect(first).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(clock.getSnapshot()).toBe(660_000);
		expect(first).toHaveBeenCalledOnce();
		expect(second).toHaveBeenCalledOnce();
	});

	it('hidden_document_no_tick_and_visible_resumes_once', () => {
		const listener = vi.fn();
		subscribe(listener);
		setHidden(true);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(180_000);
		expect(listener).not.toHaveBeenCalled();
		setHidden(false);
		expect(clock.getSnapshot()).toBe(780_000);
		expect(listener).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(60_000);
		expect(listener).toHaveBeenCalledTimes(2);
	});

	it('initial_hidden_document_waits_until_visible', () => {
		hidden = true;
		const listener = vi.fn();
		subscribe(listener);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(120_000);
		setHidden(false);
		expect(clock.getSnapshot()).toBe(720_000);
		expect(listener).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(1);
	});

	it('last_unsubscribe_stops_clock_and_removes_visibility_listener', () => {
		const listener = vi.fn();
		const first = subscribe(listener);
		const last = subscribe(vi.fn());
		expect(vi.getTimerCount()).toBe(1);
		first();
		expect(vi.getTimerCount()).toBe(1);
		last();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(120_000);
		setHidden(true);
		setHidden(false);
		expect(vi.getTimerCount()).toBe(0);
		expect(listener).not.toHaveBeenCalled();
	});

	it('reopening_refreshes_snapshot_without_per_user_timers', () => {
		const stop = subscribe(vi.fn());
		stop();
		vi.advanceTimersByTime(120_000);
		subscribe(vi.fn());
		expect(clock.getSnapshot()).toBe(720_000);
		expect(vi.getTimerCount()).toBe(1);
	});

	it('negative_duration_clamped', () => {
		expect(getGameActivityElapsed(700_000, 600_000)).toBe(0);
		expect(getGameActivityElapsed(500_000, 600_000)).toBe(100_000);
	});

	it('seven_day_start_not_rewritten', () => {
		const startedAt = 1000;
		const now = startedAt + 8 * 24 * 60 * 60 * 1000;
		expect(getGameActivityElapsed(startedAt, now)).toBe(8 * 24 * 60 * 60 * 1000);
	});

	it('wall_clock_changes_only_update_local_duration', () => {
		const listener = vi.fn();
		subscribe(listener);
		vi.setSystemTime(300_000);
		vi.advanceTimersByTime(60_000);
		expect(clock.getSnapshot()).toBe(360_000);
		expect(getGameActivityElapsed(500_000, clock.getSnapshot())).toBe(0);
		expect(listener).toHaveBeenCalledOnce();
	});
});

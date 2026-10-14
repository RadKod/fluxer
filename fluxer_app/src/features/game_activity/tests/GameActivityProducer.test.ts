// SPDX-License-Identifier: AGPL-3.0-or-later

import {GameActivityProducer} from '@app/features/game_activity/utils/DesktopGameActivityBridge';
import type {DesktopGameActivityState} from '@app/features/platform/types/Electron';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const game = {game_id: 'test-game', started_at: 1000};
const scan = (activity = game): DesktopGameActivityState => ({generation: 1, state: 'playing', activity, fresh: true});

describe('GameActivityProducer', () => {
	let sent: Array<unknown>;
	let presence: {status: string; afk: boolean; mobile: boolean; custom_status: {text: string}} | null;
	let producer: GameActivityProducer;
	beforeEach(() => {
		vi.useFakeTimers();
		sent = [];
		presence = {status: 'dnd', afk: true, mobile: false, custom_status: {text: 'keep'}};
		producer = new GameActivityProducer({
			getPresence: () => presence,
			send: (value) => {
				sent.push(value);
				return true;
			},
		});
		producer.setEnabled(true);
	});
	afterEach(() => {
		producer.stop();
		vi.useRealTimers();
	});
	it('op3_preserves_required_status', () => {
		producer.handleState(scan());
		vi.advanceTimersByTime(3000);
		expect(sent).toEqual([{...presence, game_activity: game}]);
	});
	it('no_hydrated_presence_no_send', () => {
		presence = null;
		producer.handleState(scan());
		vi.advanceTimersByTime(3000);
		expect(sent).toEqual([]);
	});
	it('unchanged_scan_no_fanout', () => {
		producer.handleState(scan());
		vi.advanceTimersByTime(3000);
		for (let i = 0; i < 3; i++) {
			vi.advanceTimersByTime(15000);
			producer.handleState(scan());
		}
		expect(sent).toHaveLength(1);
	});
	it('fresh_scan_renews_at_60s', () => {
		producer.handleState(scan());
		vi.advanceTimersByTime(3000);
		for (let i = 0; i < 3; i++) {
			vi.advanceTimersByTime(15000);
			producer.handleState(scan());
		}
		vi.advanceTimersByTime(15000);
		expect(sent).toEqual([
			{...presence, game_activity: game},
			{...presence, game_activity: game},
		]);
	});
	it('failed_scan_does_not_renew_and_clears_after_last_success', () => {
		producer.handleState(scan());
		vi.advanceTimersByTime(3000);
		producer.handleState({generation: 1, state: 'unavailable', activity: null, fresh: false});
		vi.advanceTimersByTime(56999);
		expect(sent).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(sent).toEqual([
			{...presence, game_activity: game},
			{...presence, game_activity: null},
		]);
	});
	it('null_bypasses_local_debounce', () => {
		producer.handleState(scan());
		vi.advanceTimersByTime(3000);
		producer.handleState(scan({game_id: 'other-game', started_at: 2000}));
		producer.handleState({generation: 1, state: 'idle', activity: null, fresh: true});
		expect(sent.at(-1)).toEqual({...presence, game_activity: null});
		vi.advanceTimersByTime(15000);
		expect(sent).toHaveLength(2);
	});
	it('off_cancels_pending_start', () => {
		producer.handleState(scan());
		producer.setEnabled(false);
		vi.advanceTimersByTime(15000);
		expect(sent).toEqual([{...presence, game_activity: null}]);
	});
	it('reconnect_requires_fresh_scan', () => {
		producer.handleState(scan());
		vi.advanceTimersByTime(3000);
		producer.disconnected();
		producer.setEnabled(true);
		vi.advanceTimersByTime(120000);
		expect(sent).toHaveLength(1);
		producer.handleState({...scan(), fresh: false});
		vi.advanceTimersByTime(3000);
		expect(sent).toHaveLength(1);
		producer.handleState(scan());
		vi.advanceTimersByTime(3000);
		expect(sent).toHaveLength(2);
	});
	it('continuous_changes_send_latest_within_15s', () => {
		producer.handleState(scan());
		for (let i = 1; i <= 7; i++) {
			vi.advanceTimersByTime(2000);
			producer.handleState(scan({game_id: `game-${i}`, started_at: i}));
		}
		vi.advanceTimersByTime(1000);
		expect(sent).toEqual([{...presence, game_activity: {game_id: 'game-7', started_at: 7}}]);
	});
	it('invisible_clears_and_does_not_send_playing', () => {
		producer.handleState(scan());
		vi.advanceTimersByTime(3000);
		presence = {...presence!, status: 'invisible'};
		producer.presenceChanged();
		expect(sent.at(-1)).toEqual({...presence, game_activity: null});
		producer.handleState(scan());
		vi.advanceTimersByTime(3000);
		expect(sent).toHaveLength(2);
	});
	it('failed_gateway_send_is_not_a_successful_lease', () => {
		producer.stop();
		let available = false;
		producer = new GameActivityProducer({
			getPresence: () => presence,
			send: (value) => {
				if (!available) return false;
				sent.push(value);
				return true;
			},
		});
		producer.setEnabled(true);
		producer.handleState(scan());
		vi.advanceTimersByTime(3000);
		expect(sent).toEqual([]);
		available = true;
		producer.handleState(scan());
		vi.advanceTimersByTime(3000);
		expect(sent).toHaveLength(1);
	});
	it('same_fresh_snapshot_cannot_renew_without_a_new_scan', () => {
		producer.handleState(scan());
		vi.advanceTimersByTime(3000);
		vi.advanceTimersByTime(60000);
		expect(sent).toEqual([
			{...presence, game_activity: game},
			{...presence, game_activity: null},
		]);
	});
	it('invalid_identity_is_never_sent', () => {
		producer.handleState({
			...scan(),
			activity: {game_id: 123, started_at: 1000} as unknown as DesktopGameActivityState['activity'],
		});
		vi.advanceTimersByTime(3000);
		expect(sent).toEqual([]);
	});
});

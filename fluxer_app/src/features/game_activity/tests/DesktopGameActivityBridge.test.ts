// SPDX-License-Identifier: AGPL-3.0-or-later

import GameActivityStore from '@app/features/game_activity/state/GameActivityStore';
import {DesktopGameActivityBridge} from '@app/features/game_activity/utils/DesktopGameActivityBridge';
import type {DesktopGameActivityState, ElectronAPI} from '@app/types/electron.d';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

describe('DesktopGameActivityBridge IPC fixture', () => {
	let api: Partial<ElectronAPI>;
	let callbacks: Array<(state: DesktopGameActivityState) => void>;
	let sent: Array<unknown>;
	let order: Array<string>;
	let bridge: DesktopGameActivityBridge;
	let enabled: boolean;
	beforeEach(() => {
		vi.useFakeTimers();
		GameActivityStore.resetRollout();
		GameActivityStore.handleRollout({game_activity_enabled: true, game_activity_epoch: 1});
		callbacks = [];
		sent = [];
		order = [];
		enabled = true;
		api = {
			gameActivityGetCapabilities: vi.fn(async () => ({version: 1 as const, supported: true})),
			gameActivityConfigure: vi.fn(async (request) => {
				order.push(`configure:${request.account_id}:${request.enabled}`);
				return {state: 'ok' as const};
			}),
			gameActivityGetState: vi.fn(async ({generation}) => ({
				generation,
				state: 'idle' as const,
				activity: null,
				fresh: true,
			})),
			onGameActivityState: vi.fn((callback) => {
				callbacks.push(callback);
				return () => {
					order.push('unsubscribe');
				};
			}),
			gameActivityListCandidates: vi.fn(async () => ({
				state: 'ok' as const,
				candidates: [{token: 'local-only', label: 'App'}],
			})),
			gameActivityListRules: vi.fn(async () => ({state: 'ok' as const, rules: []})),
			gameActivityAddRule: vi.fn(async () => ({state: 'ok' as const, rule_id: 'rule'})),
			gameActivityRemoveRule: vi.fn(async () => ({state: 'ok' as const})),
		};
		bridge = new DesktopGameActivityBridge({
			getApi: () => api,
			getPresence: () => ({status: 'online', afk: false, mobile: false, custom_status: null}),
			send: (value) => {
				sent.push(value);
				return true;
			},
			getEnabled: () => enabled,
			clearReceived: () => {
				order.push('clear');
			},
		});
	});
	afterEach(async () => {
		await bridge.setAccount(null);
		vi.useRealTimers();
	});
	const emitPlaying = (callback = callbacks.at(-1), generation?: number) => {
		const configured = vi.mocked(api.gameActivityConfigure!).mock.calls.at(-1)?.[0];
		callback?.({
			generation: generation ?? configured?.generation ?? 1,
			state: 'playing',
			activity: {game_id: 'test-game', started_at: 1000},
			fresh: true,
		});
	};
	it('rollout disabled overrides saved preferences and blocks manual IPC requests', async () => {
		GameActivityStore.handleRollout({game_activity_enabled: false, game_activity_epoch: 2});
		await bridge.setAccount('account-a');
		expect(api.gameActivityConfigure).toHaveBeenCalledWith({account_id: 'account-a', generation: 1, enabled: false});
		expect(api.gameActivityGetState).not.toHaveBeenCalled();
		expect(api.onGameActivityState).not.toHaveBeenCalled();
		expect(await bridge.listCandidates()).toEqual({state: 'unsupported'});
		expect(await bridge.listRules()).toEqual({state: 'unsupported'});
		expect(await bridge.addRule({token: 'old-token', manual_name: 'Game'})).toEqual({state: 'unsupported'});
		expect(await bridge.removeRule('old-rule')).toEqual({state: 'unsupported'});
		expect(api.gameActivityListCandidates).not.toHaveBeenCalled();
		expect(api.gameActivityListRules).not.toHaveBeenCalled();
		expect(api.gameActivityAddRule).not.toHaveBeenCalled();
		expect(api.gameActivityRemoveRule).not.toHaveBeenCalled();
		vi.advanceTimersByTime(120000);
		expect(sent).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});
	it.each([0, 3000])('live close at %sms cancels sends and reopening requires a fresh generation', async (delay) => {
		await bridge.setAccount('account-a');
		const old = callbacks[0];
		emitPlaying();
		vi.advanceTimersByTime(delay);
		const beforeClose = delay === 0 ? 0 : 1;
		expect(sent).toHaveLength(beforeClose);
		GameActivityStore.handleRollout({game_activity_enabled: false, game_activity_epoch: 2});
		await bridge.syncPolicy();
		expect(api.gameActivityConfigure).toHaveBeenLastCalledWith({
			account_id: 'account-a',
			generation: 2,
			enabled: false,
		});
		expect(bridge.activity).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
		emitPlaying(old);
		vi.advanceTimersByTime(120000);
		expect(sent).toHaveLength(beforeClose);
		GameActivityStore.handleRollout({game_activity_enabled: true, game_activity_epoch: 3});
		await bridge.syncPolicy();
		expect(sent).toHaveLength(beforeClose);
		emitPlaying(old);
		vi.advanceTimersByTime(3000);
		expect(sent).toHaveLength(beforeClose);
		emitPlaying();
		vi.advanceTimersByTime(3000);
		expect(sent).toHaveLength(beforeClose + 1);
	});
	it('sends the Spotify flag only to shells that advertise it and reconfigures when it changes', async () => {
		let spotify = true;
		bridge.initialize({
			getApi: () => api,
			getPresence: () => ({status: 'online', afk: false, mobile: false, custom_status: null}),
			send: (value) => {
				sent.push(value);
				return true;
			},
			getEnabled: () => enabled,
			getSpotifyEnabled: () => spotify,
		});
		await bridge.setAccount('account-a');
		expect(bridge.spotifySupported).toBe(false);
		expect(api.gameActivityConfigure).toHaveBeenLastCalledWith({account_id: 'account-a', generation: 1, enabled: true});
		api.gameActivityGetCapabilities = vi.fn(async () => ({version: 1 as const, supported: true, spotify: true}));
		await bridge.setAccount('account-b');
		expect(bridge.spotifySupported).toBe(true);
		expect(api.gameActivityConfigure).toHaveBeenLastCalledWith({
			account_id: 'account-b',
			generation: 2,
			enabled: true,
			spotify: true,
		});
		const calls = vi.mocked(api.gameActivityConfigure!).mock.calls.length;
		await bridge.syncPolicy();
		expect(vi.mocked(api.gameActivityConfigure!).mock.calls.length).toBe(calls);
		spotify = false;
		await bridge.syncPolicy();
		expect(api.gameActivityConfigure).toHaveBeenLastCalledWith({
			account_id: 'account-b',
			generation: 3,
			enabled: true,
			spotify: false,
		});
		spotify = true;
		enabled = false;
		await bridge.syncPolicy();
		expect(api.gameActivityConfigure).toHaveBeenLastCalledWith({
			account_id: 'account-b',
			generation: 4,
			enabled: false,
			spotify: false,
		});
	});
	it('legacy_bridge_display_only', async () => {
		api = {};
		await bridge.setAccount('account-a');
		vi.advanceTimersByTime(120000);
		expect(bridge.supported).toBe(false);
		expect(sent).toEqual([]);
	});
	it('unsupported_never_polls', async () => {
		api.gameActivityGetCapabilities = vi.fn(async () => ({version: 1 as const, supported: false}));
		await bridge.setAccount('account-a');
		vi.advanceTimersByTime(120000);
		expect(api.gameActivityConfigure).not.toHaveBeenCalled();
		expect(api.gameActivityGetState).not.toHaveBeenCalled();
		expect(api.onGameActivityState).not.toHaveBeenCalled();
	});
	it('v1_contract_names_match', async () => {
		await bridge.setAccount('account-a');
		expect(bridge.supported).toBe(true);
		expect(api.gameActivityConfigure).toHaveBeenCalledWith({account_id: 'account-a', generation: 1, enabled: true});
		expect(api.onGameActivityState).toHaveBeenCalledTimes(1);
	});
	it('stale_generation_cannot_send', async () => {
		await bridge.setAccount('account-a');
		const old = callbacks[0];
		expect(old).toBeTypeOf('function');
		await bridge.setAccount('account-b');
		const count = sent.length;
		emitPlaying(old);
		vi.advanceTimersByTime(3000);
		expect(sent).toHaveLength(count);
	});
	it('logout_unsubscribes_before_new_account', async () => {
		await bridge.setAccount('account-a');
		emitPlaying();
		vi.advanceTimersByTime(3000);
		order = [];
		await bridge.setAccount('account-b');
		expect(sent.at(-1)).toMatchObject({game_activity: null});
		expect(order.indexOf('configure:null:false')).toBeLessThan(order.indexOf('unsubscribe'));
		expect(order.indexOf('unsubscribe')).toBeLessThan(order.indexOf('configure:account-b:true'));
	});
	it('no_process_fields_in_gateway_payload', async () => {
		await bridge.setAccount('account-a');
		const generation = vi.mocked(api.gameActivityConfigure!).mock.calls.at(-1)?.[0].generation ?? 1;
		callbacks[0]?.({
			generation,
			state: 'playing' as const,
			fresh: true,
			activity: {
				game_id: 'test-game',
				started_at: 1000,
				pid: 99,
				exe: 'private.exe',
				path: 'private',
				token: 'local-only',
			} as DesktopGameActivityState['activity'],
		});
		vi.advanceTimersByTime(3000);
		expect(sent).toEqual([
			{
				status: 'online',
				afk: false,
				mobile: false,
				custom_status: null,
				game_activity: {game_id: 'test-game', started_at: 1000},
			},
		]);
	});
	it('off_latch_survives_authoritative_reread_until_explicit_retry', async () => {
		await bridge.setAccount('account-a');
		emitPlaying();
		vi.advanceTimersByTime(3000);
		await bridge.stopSharing();
		enabled = true;
		await bridge.syncPolicy();
		const count = sent.length;
		emitPlaying();
		vi.advanceTimersByTime(3000);
		expect(sent).toHaveLength(count);
		await bridge.refreshPolicy();
		emitPlaying();
		vi.advanceTimersByTime(3000);
		expect(sent).toHaveLength(count + 1);
	});
	it('no_sender_never_enables_scan', async () => {
		const unavailable = new DesktopGameActivityBridge({getApi: () => api, getEnabled: () => true});
		await unavailable.setAccount('account-a');
		expect(api.gameActivityConfigure).not.toHaveBeenCalled();
		expect(unavailable.supported).toBe(false);
	});
	it('candidate_tokens_only_return_to_main_via_v1_methods', async () => {
		await bridge.setAccount('account-a');
		expect(await bridge.listCandidates('next-page')).toEqual({
			state: 'ok',
			candidates: [{token: 'local-only', label: 'App'}],
		});
		await bridge.addRule({token: 'local-only', manual_name: 'My game'});
		await bridge.listRules();
		await bridge.removeRule('rule');
		expect(api.gameActivityListCandidates).toHaveBeenCalledWith({generation: 1, cursor: 'next-page'});
		expect(api.gameActivityAddRule).toHaveBeenCalledWith({generation: 1, token: 'local-only', manual_name: 'My game'});
		expect(api.gameActivityListRules).toHaveBeenCalledWith({generation: 1});
		expect(api.gameActivityRemoveRule).toHaveBeenCalledWith({generation: 1, rule_id: 'rule'});
		expect(sent).toEqual([]);
	});
	it('late_candidate_reply_does_not_cross_accounts', async () => {
		await bridge.setAccount('account-a');
		let finish!: (value: {state: 'ok'; candidates: Array<{token: string; label: string}>}) => void;
		api.gameActivityListCandidates = () =>
			new Promise((resolve) => {
				finish = resolve;
			});
		const reply = bridge.listCandidates();
		await bridge.setAccount('account-b');
		finish({state: 'ok', candidates: [{token: 'old-token', label: 'Old'}]});
		expect(await reply).toEqual({state: 'unsupported'});
	});
	it('event_generation_must_match_even_current_subscription', async () => {
		await bridge.setAccount('account-a');
		emitPlaying(undefined, 0);
		vi.advanceTimersByTime(3000);
		expect(sent).toEqual([]);
		expect(bridge.activity).toBeNull();
	});
	it('account_switch_cancels_debounced_old_activity', async () => {
		await bridge.setAccount('account-a');
		emitPlaying();
		await bridge.setAccount('account-b');
		vi.advanceTimersByTime(3000);
		expect(sent).toEqual([{status: 'online', afk: false, mobile: false, custom_status: null, game_activity: null}]);
	});
	it('reconnect_rejects_snapshot_and_old_subscription_until_new_scan', async () => {
		await bridge.setAccount('account-a');
		const old = callbacks[0];
		emitPlaying();
		vi.advanceTimersByTime(3000);
		await bridge.disconnected();
		await bridge.refreshPolicy();
		const count = sent.length;
		emitPlaying(old);
		vi.advanceTimersByTime(3000);
		expect(sent).toHaveLength(count);
		expect(api.gameActivityGetState).toHaveBeenCalledTimes(2);
		emitPlaying();
		vi.advanceTimersByTime(3000);
		expect(sent).toHaveLength(count + 1);
	});
	it('first_fresh_scan_before_subscription_is_read_once', async () => {
		api.gameActivityGetState = vi.fn(async ({generation}) => ({
			generation,
			state: 'playing' as const,
			activity: {game_id: 'early-game', started_at: 1000},
			fresh: true,
		}));
		await bridge.setAccount('account-a');
		vi.advanceTimersByTime(3000);
		expect(sent).toEqual([
			{
				status: 'online',
				afk: false,
				mobile: false,
				custom_status: null,
				game_activity: {game_id: 'early-game', started_at: 1000},
			},
		]);
		vi.advanceTimersByTime(15000);
		expect(api.gameActivityGetState).toHaveBeenCalledTimes(1);
	});
	it('old_generation_snapshot_cannot_replay_after_reconnect', async () => {
		api.gameActivityGetState = vi.fn(async () => ({
			generation: 0,
			state: 'playing' as const,
			activity: {game_id: 'old-game', started_at: 1000},
			fresh: true,
		}));
		await bridge.setAccount('account-a');
		vi.advanceTimersByTime(3000);
		expect(sent).toEqual([]);
		expect(bridge.activity).toBeNull();
	});
	it('expired_local_preview_is_cleared_without_another_main_event', async () => {
		await bridge.setAccount('account-a');
		emitPlaying();
		vi.advanceTimersByTime(3000);
		expect(bridge.activity).toEqual({game_id: 'test-game', started_at: 1000});
		vi.advanceTimersByTime(57000);
		expect(bridge.activity).toBeNull();
	});
	it('newer_idle_event_wins_over_delayed_snapshot', async () => {
		let finish!: (state: DesktopGameActivityState) => void;
		api.gameActivityGetState = () =>
			new Promise((resolve) => {
				finish = resolve;
			});
		const setup = bridge.setAccount('account-a');
		for (let i = 0; i < 10 && !finish; i++) await Promise.resolve();
		expect(finish).toBeTypeOf('function');
		const generation = vi.mocked(api.gameActivityConfigure!).mock.calls.at(-1)![0].generation;
		callbacks[0]({generation, state: 'idle', activity: null, fresh: true});
		finish({generation, state: 'playing', activity: {game_id: 'stale-game', started_at: 1000}, fresh: true});
		await setup;
		vi.advanceTimersByTime(3000);
		expect(sent).toEqual([]);
		expect(bridge.activity).toBeNull();
	});
	it.each(['logout', 'disconnect', 'off', 'rollout'] as const)('pending_enable_is_stopped_after_%s', async (action) => {
		let scanning = false;
		let finish!: () => void;
		api.gameActivityConfigure = vi.fn<NonNullable<ElectronAPI['gameActivityConfigure']>>((request) => {
			if (request.enabled)
				return new Promise((resolve) => {
					finish = () => {
						scanning = true;
						resolve({state: 'ok'});
					};
				});
			scanning = false;
			return Promise.resolve({state: 'ok'});
		});
		const opening = bridge.setAccount('account-a');
		for (let i = 0; i < 10 && !finish; i++) await Promise.resolve();
		expect(finish).toBeTypeOf('function');
		if (action === 'rollout') GameActivityStore.handleRollout({game_activity_enabled: false, game_activity_epoch: 2});
		const closing =
			action === 'logout'
				? bridge.setAccount(null)
				: action === 'disconnect'
					? bridge.disconnected()
					: action === 'rollout'
						? bridge.syncPolicy()
						: bridge.stopSharing();
		finish();
		await opening;
		await closing;
		expect(scanning).toBe(false);
		expect(api.gameActivityConfigure).toHaveBeenCalledWith({account_id: null, generation: 1, enabled: false});
		expect(api.onGameActivityState).not.toHaveBeenCalled();
	});
	it('configure_rejection_after_enable_side_effect_is_stopped', async () => {
		let scanning = false;
		api.gameActivityConfigure = vi.fn<NonNullable<ElectronAPI['gameActivityConfigure']>>(async (request) => {
			if (request.enabled) {
				scanning = true;
				throw new Error('Reply lost');
			}
			scanning = false;
			return {state: 'ok' as const};
		});
		await bridge.setAccount('account-a');
		expect(scanning).toBe(false);
		expect(bridge.supported).toBe(false);
		expect(api.gameActivityConfigure).toHaveBeenCalledWith({account_id: null, generation: 1, enabled: false});
	});
	it('failed_pending_stop_blocks_new_account_until_stop_ack', async () => {
		let finish!: () => void;
		let rejectStop = true;
		api.gameActivityConfigure = vi.fn<NonNullable<ElectronAPI['gameActivityConfigure']>>((request) => {
			if (request.enabled && request.account_id === 'account-a')
				return new Promise((resolve) => {
					finish = () => resolve({state: 'ok'});
				});
			if (!request.enabled && rejectStop) return Promise.reject(new Error('Stop not acknowledged'));
			return Promise.resolve({state: 'ok'});
		});
		const oldOpening = bridge.setAccount('account-a');
		for (let i = 0; i < 10 && !finish; i++) await Promise.resolve();
		expect(finish).toBeTypeOf('function');
		const newOpening = bridge.setAccount('account-b');
		finish();
		await oldOpening;
		await newOpening;
		expect(
			vi
				.mocked(api.gameActivityConfigure!)
				.mock.calls.filter(([request]) => request.account_id === 'account-b' && request.enabled),
		).toHaveLength(0);
		rejectStop = false;
		await bridge.refreshPolicy();
		expect(
			vi
				.mocked(api.gameActivityConfigure!)
				.mock.calls.filter(([request]) => request.account_id === 'account-b' && request.enabled),
		).toHaveLength(1);
	});
	it('obsolete_enable_waits_for_its_stop_ack_before_logout_resolves', async () => {
		let finishEnable!: () => void;
		let finishStop!: () => void;
		let enableCompleted = false;
		api.gameActivityConfigure = vi.fn<NonNullable<ElectronAPI['gameActivityConfigure']>>((request) => {
			if (request.enabled)
				return new Promise((resolve) => {
					finishEnable = () => {
						enableCompleted = true;
						resolve({state: 'ok'});
					};
				});
			if (enableCompleted)
				return new Promise((resolve) => {
					finishStop = () => resolve({state: 'ok'});
				});
			return Promise.resolve({state: 'ok'});
		});
		const opening = bridge.setAccount('account-a');
		for (let i = 0; i < 10 && !finishEnable; i++) await Promise.resolve();
		expect(finishEnable).toBeTypeOf('function');
		let closed = false;
		const closing = bridge.setAccount(null).then(() => {
			closed = true;
		});
		finishEnable();
		for (let i = 0; i < 10 && !finishStop; i++) await Promise.resolve();
		expect(finishStop).toBeTypeOf('function');
		expect(closed).toBe(false);
		finishStop();
		await opening;
		await closing;
		expect(closed).toBe(true);
	});
	it('old_configuration_is_stopped_before_new_account_starts', async () => {
		let finish!: () => void;
		let scanningAccount: string | null = null;
		api.gameActivityConfigure = vi.fn<NonNullable<ElectronAPI['gameActivityConfigure']>>((request) => {
			order.push(`${request.account_id}:${request.generation}:${request.enabled}`);
			if (request.enabled && request.account_id === 'account-a')
				return new Promise((resolve) => {
					finish = () => {
						scanningAccount = 'account-a';
						resolve({state: 'ok'});
					};
				});
			scanningAccount = request.enabled ? request.account_id : null;
			return Promise.resolve({state: 'ok'});
		});
		const oldOpening = bridge.setAccount('account-a');
		for (let i = 0; i < 10 && !finish; i++) await Promise.resolve();
		expect(finish).toBeTypeOf('function');
		const newOpening = bridge.setAccount('account-b');
		finish();
		await oldOpening;
		await newOpening;
		expect(scanningAccount).toBe('account-b');
		expect(order.lastIndexOf('null:1:false')).toBeLessThan(order.indexOf('account-b:2:true'));
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {VoiceEngineV2AppStatsHostAdapter} from '@app/features/voice/engine/v2/VoiceEngineV2AppStatsHostAdapter';
import type {Room} from 'livekit-client';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug() {}
	},
}));
vi.mock('@app/features/voice/engine/VoiceMediaGraphStore', () => ({
	voiceMediaGraphStore: {transition: vi.fn(), nowMs: () => 0},
}));

type Report = Record<string, unknown> & {id: string; type: string};
const reportMap = (reports: Array<Report>) => new Map(reports.map((report) => [report.id, report]));
const pair = (rtt: unknown, extra: Record<string, unknown> = {}): Report => ({
	id: 'pair',
	type: 'candidate-pair',
	state: 'succeeded',
	nominated: true,
	currentRoundTripTime: rtt,
	...extra,
});

function setup(publisherReports: Array<Report> = [], subscriberReports: Array<Report> = []) {
	const callbacks: Array<() => void> = [];
	const publisher = {getStats: vi.fn(async () => reportMap(publisherReports))};
	const subscriber = {getStats: vi.fn(async () => reportMap(subscriberReports))};
	const room = {engine: {client: {rtt: 100}, pcManager: {publisher, subscriber}}, numParticipants: 1};
	const adapter = new VoiceEngineV2AppStatsHostAdapter({
		now: () => 2000,
		scheduler: {
			setInterval: (fn) => {
				callbacks.push(fn);
				return callbacks.length;
			},
			clearInterval: vi.fn(),
		},
	});
	adapter.setRoom(room as unknown as Room);
	adapter.startLatencyTracking();
	adapter.startStatsTracking();
	const tick = async () => {
		callbacks[2]();
		await vi.waitFor(() =>
			expect(
				(adapter as unknown as {statsSnapshot: {context: {statsCollectionInFlight: boolean}}}).statsSnapshot.context
					.statsCollectionInFlight,
			).toBe(false),
		);
	};
	return {adapter, room, publisher, subscriber, callbacks, tick};
}

describe('voice ping media RTT', () => {
	it('uses the slower selected media path and retains independent signal RTT', async () => {
		const {adapter, callbacks, tick} = setup([pair(0.023)], [pair(0.045)]);
		await tick();
		expect(callbacks).toHaveLength(3);
		expect(adapter.currentLatency).toBe(45);
		expect(adapter.mediaLatency).toBe(45);
		expect(adapter.signalLatency).toBe(100);
		callbacks[0]();
		expect(adapter.latencyHistory.at(-1)?.latency).toBe(45);
		expect(adapter.averageLatency).toBe(45);
		expect((await adapter.collectStats()).rttMs).toBe(45);
	});

	it('prefers the transport-selected pair over other succeeded or nominated pairs', async () => {
		const {adapter, tick} = setup([
			pair(0.9, {id: 'old'}),
			pair(0.031, {nominated: false}),
			{id: 'transport', type: 'transport', selectedCandidatePairId: 'pair'},
		]);
		await tick();
		expect(adapter.currentLatency).toBe(31);
		expect(adapter.publisherTransport?.currentRoundTripTimeMs).toBe(31);
		expect((await adapter.collectStats()).rttMs).toBe(31);
	});

	it('preserves a measured zero instead of falling back to signal', async () => {
		const {adapter, tick} = setup([pair(0)]);
		await tick();
		expect(adapter.mediaLatency).toBe(0);
		expect(adapter.currentLatency).toBe(0);
		expect((await adapter.collectStats()).rttMs).toBe(0);
	});

	it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, -0.1])('rejects invalid media RTT %s', async (rtt) => {
		const {adapter, tick} = setup([pair(rtt)]);
		await tick();
		expect(adapter.mediaLatency).toBeNull();
		expect(adapter.currentLatency).toBe(100);
		expect((await adapter.collectStats()).rttMs).toBe(100);
	});

	it('does not infer selection from a succeeded pair alone', async () => {
		const {adapter, tick} = setup([pair(0.02, {nominated: undefined})]);
		await tick();
		expect(adapter.mediaLatency).toBeNull();
		expect(adapter.currentLatency).toBe(100);
	});

	it('prefers an explicitly selected pair when the transport omits the pair id', async () => {
		const {adapter, tick} = setup([pair(0.9, {id: 'old'}), pair(0.03, {selected: true})]);
		await tick();
		expect(adapter.currentLatency).toBe(30);
	});

	it('does not reuse a nominated pair when the transport-selected pair is missing', async () => {
		const {adapter, tick} = setup([
			pair(0.9),
			{id: 'transport', type: 'transport', selectedCandidatePairId: 'missing'},
		]);
		await tick();
		expect(adapter.mediaLatency).toBeNull();
		expect(adapter.currentLatency).toBe(100);
	});

	it('keeps a subscriber-only media path and invalidates it when tracking stops', async () => {
		const {adapter, tick} = setup([], [pair(0.04)]);
		await tick();
		expect(adapter.currentLatency).toBe(40);
		adapter.stopStatsTracking();
		expect(adapter.mediaLatency).toBeNull();
		expect(adapter.currentLatency).toBe(100);
	});

	it('drops the previous media value when a new sample has no selected pair', async () => {
		const {adapter, publisher, tick} = setup([pair(0.02)]);
		await tick();
		publisher.getStats.mockResolvedValue(reportMap([]));
		await tick();
		expect(adapter.mediaLatency).toBeNull();
		expect(adapter.currentLatency).toBe(100);
	});

	it('drops media values on collection failure and recovers on the next sample', async () => {
		const {adapter, publisher, tick} = setup([pair(0.02)]);
		await tick();
		publisher.getStats.mockRejectedValueOnce(new Error('closed'));
		await tick();
		expect(adapter.mediaLatency).toBeNull();
		expect(adapter.currentLatency).toBe(100);
		await tick();
		expect(adapter.mediaLatency).toBe(20);
	});

	it('drops old-room media and ignores delayed old-room stats', async () => {
		const {adapter, publisher, callbacks, tick} = setup([pair(0.02)]);
		await tick();
		let resolveStats!: (value: Map<string, Report>) => void;
		publisher.getStats.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveStats = resolve;
			}),
		);
		callbacks[2]();
		adapter.setRoom({engine: {client: {rtt: 75}}} as unknown as Room);
		expect(adapter.mediaLatency).toBeNull();
		expect(adapter.currentLatency).toBe(75);
		resolveStats(reportMap([pair(0.015)]));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(adapter.mediaLatency).toBeNull();
		expect(adapter.currentLatency).toBe(75);
	});

	it('clears media when peer connections disappear or tracking stops', async () => {
		const {adapter, room, tick} = setup([pair(0.02)]);
		await tick();
		Object.assign(room.engine, {pcManager: undefined});
		await tick();
		expect(adapter.mediaLatency).toBeNull();
		adapter.stopStatsTracking();
		adapter.setRoom(null);
		expect(adapter.currentLatency).toBeNull();
		expect(adapter.signalLatency).toBeNull();
	});

	it.each([0, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1])('validates signal fallback %s', async (rtt) => {
		const {adapter, room, callbacks, tick} = setup();
		Object.assign(room.engine.client, {rtt});
		await tick();
		callbacks[0]();
		expect(adapter.currentLatency).toBeNull();
		expect(adapter.signalLatency).toBeNull();
		expect((await adapter.collectStats()).rttMs).toBeNull();
	});

	it('uses the first signal pong when media RTT is never reported', async () => {
		const {adapter, room, callbacks, tick} = setup([pair(undefined)]);
		room.engine.client.rtt = 0;
		await tick();
		callbacks[0]();
		expect(adapter.displayLatency).toBeNull();
		expect(adapter.latencyHistory).toHaveLength(0);

		room.engine.client.rtt = 37;
		for (let sample = 0; sample < 3; sample++) {
			await tick();
			callbacks[0]();
			expect(adapter.mediaLatency).toBeNull();
			expect(adapter.signalLatency).toBe(37);
			expect(adapter.currentLatency).toBe(37);
			expect(adapter.displayLatency).toBe(37);
			expect((await adapter.collectStats()).rttMs).toBe(37);
		}
		expect(adapter.averageLatency).toBe(37);
		expect(adapter.latencyHistory.at(-1)?.latency).toBe(37);
	});
});

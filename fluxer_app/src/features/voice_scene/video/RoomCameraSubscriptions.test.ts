// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {
	planRoomCameras,
	ROOM_CAMERA_MAX,
	ROOM_CAMERA_MEDIUM_MAX,
} from '@app/features/voice_scene/video/CameraSubscriptionPlan';
import {RoomCameraSubscriptions} from '@app/features/voice_scene/video/RoomCameraSubscriptions';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

type Quality = 'low' | 'medium' | 'high';
type Call = {method: string; args: Array<unknown>};

// What the voice server is sending this viewer: one entry per subscribed camera, with its layer. Like Fluxer's
// VideoSubscriptionManager, subscribing over an existing entry keeps that entry's quality.
function fakeServer() {
	const sent = new Map<string, Quality>();
	const calls: Array<Call> = [];
	// Any method the controller reaches for is recorded; only the managed three do anything.
	const adapter = new Proxy(
		{},
		{
			get:
				(_target, method: string) =>
				(...args: Array<unknown>) => {
					calls.push({method, args});
					const [identity, second, third] = args as [string, unknown, Quality];
					if (method === 'subscribeToVideo' && !sent.has(identity)) sent.set(identity, third);
					if (method === 'setVideoQuality' && sent.has(identity)) sent.set(identity, second as Quality);
					if (method === 'unsubscribeFromVideo') sent.delete(identity);
				},
		},
	) as ConstructorParameters<typeof RoomCameraSubscriptions>[0];
	return {sent, calls, adapter};
}

const plan = (entries: Array<[string, Quality]>): ReadonlyMap<string, Quality> => new Map(entries);

function crowdPlan(offset: number) {
	const candidates = Array.from({length: 20}, (_, i) => ({
		identity: `p${i}`,
		visible: true,
		discPx: 120,
		distanceM: ((i + offset) % 20) + 1,
		sameTable: false,
		speakingRecently: false,
		seatOrder: i,
		locallyDisabled: false,
		externallyHeld: false,
	}));
	return planRoomCameras({enabled: true, candidates, tv: 'p19'});
}

function expectWithinCaps(sent: ReadonlyMap<string, Quality>): void {
	const values = [...sent.values()];
	expect(sent.size).toBeLessThanOrEqual(ROOM_CAMERA_MAX);
	expect(values.filter((quality) => quality === 'medium').length).toBeLessThanOrEqual(ROOM_CAMERA_MEDIUM_MAX);
	expect(values.filter((quality) => quality === 'high').length).toBeLessThanOrEqual(1);
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('RoomCameraSubscriptions', () => {
	it('subscribes with an explicit quality every time (M5)', () => {
		const {calls, adapter} = fakeServer();
		const subscriptions = new RoomCameraSubscriptions(adapter);
		subscriptions.apply(
			plan([
				['a', 'medium'],
				['b', 'low'],
				['tv', 'high'],
			]),
		);
		expect(calls).toEqual([
			{method: 'subscribeToVideo', args: ['a', null, 'medium']},
			{method: 'setVideoQuality', args: ['a', 'medium']},
			{method: 'subscribeToVideo', args: ['b', null, 'low']},
			{method: 'setVideoQuality', args: ['b', 'low']},
			{method: 'subscribeToVideo', args: ['tv', null, 'high']},
			{method: 'setVideoQuality', args: ['tv', 'high']},
		]);
		subscriptions.apply(
			plan([
				['a', 'medium'],
				['b', 'medium'],
				['tv', 'high'],
			]),
		);
		expect(calls.at(-1)).toEqual({method: 'setVideoQuality', args: ['b', 'medium']});
		for (const call of calls)
			expect(call.args.some((arg) => arg === 'low' || arg === 'medium' || arg === 'high')).toBe(true);
	});

	it('quality applied when an entry already exists', () => {
		const {sent, adapter} = fakeServer();
		// An entry the manager still has (another owner, a reconnect) at the top layer.
		sent.set('a', 'high');
		new RoomCameraSubscriptions(adapter).apply(plan([['a', 'low']]));
		expect(sent.get('a')).toBe('low');
	});

	it('popout-held camera never touched by the room', () => {
		const {sent, calls, adapter} = fakeServer();
		const subscriptions = new RoomCameraSubscriptions(adapter);
		subscriptions.apply(
			plan([
				['a', 'medium'],
				['b', 'low'],
			]),
		);
		// A popout window opens on `a`: its tile adopts the running subscription.
		calls.length = 0;
		subscriptions.apply(plan([['b', 'low']]), new Set(['a']));
		vi.advanceTimersByTime(5000);
		subscriptions.releaseAll();
		expect(calls.filter((call) => call.args[0] === 'a')).toEqual([]);
		expect(sent.get('a')).toBe('medium');
		// The popout closes (its tile drops the subscription); the room takes `a` again from a clean entry.
		subscriptions.apply(plan([['a', 'low']]));
		expect(calls.filter((call) => call.args[0] === 'a').map((call) => call.method)).toEqual([
			'unsubscribeFromVideo',
			'subscribeToVideo',
			'setVideoQuality',
		]);
		expect(sent.get('a')).toBe('low');
	});

	it('downgrade waits 1 s, upgrade at once', () => {
		const {sent, adapter} = fakeServer();
		const subscriptions = new RoomCameraSubscriptions(adapter);
		subscriptions.apply(plan([['a', 'low']]));
		subscriptions.apply(plan([['a', 'medium']]));
		expect(sent.get('a')).toBe('medium');
		subscriptions.apply(plan([['a', 'low']]));
		vi.advanceTimersByTime(999);
		expect(sent.get('a')).toBe('medium');
		vi.advanceTimersByTime(1);
		expect(sent.get('a')).toBe('low');
		// A dip shorter than a second never reaches the server.
		subscriptions.apply(plan([['a', 'medium']]));
		subscriptions.apply(plan([['a', 'low']]));
		vi.advanceTimersByTime(500);
		subscriptions.apply(plan([['a', 'medium']]));
		vi.advanceTimersByTime(2000);
		expect(sent.get('a')).toBe('medium');
	});

	it('unsubscribes 2 s after leaving the plan', () => {
		const {sent, calls, adapter} = fakeServer();
		const subscriptions = new RoomCameraSubscriptions(adapter);
		subscriptions.apply(
			plan([
				['a', 'low'],
				['b', 'low'],
			]),
		);
		subscriptions.apply(plan([['b', 'low']]));
		vi.advanceTimersByTime(1999);
		expect(sent.has('a')).toBe(true);
		vi.advanceTimersByTime(1);
		expect([...sent.keys()]).toEqual(['b']);
		// Turning away and back within the grace keeps the subscription: no off/on.
		subscriptions.apply(plan([]));
		vi.advanceTimersByTime(1500);
		subscriptions.apply(plan([['b', 'low']]));
		vi.advanceTimersByTime(5000);
		expect(calls.filter((call) => call.args[0] === 'b').map((call) => call.method)).toEqual([
			'subscribeToVideo',
			'setVideoQuality',
		]);
	});

	it('the grace never lets the held set exceed the caps', () => {
		const {sent, adapter} = fakeServer();
		const subscriptions = new RoomCameraSubscriptions(adapter);
		for (let step = 0; step < 20; step++) {
			subscriptions.apply(crowdPlan(step * 3));
			expectWithinCaps(sent);
			vi.advanceTimersByTime(300);
			expectWithinCaps(sent);
		}
	});

	it('room → grid → room leaves exactly the capped set subscribed (M6)', () => {
		const {sent, calls, adapter} = fakeServer();
		const room = crowdPlan(0);
		const subscriptions = new RoomCameraSubscriptions(adapter);
		subscriptions.apply(room);
		subscriptions.apply(crowdPlan(5));
		// The flat grid: its tile hook takes every visible camera with no quality (the top layer), outside this class.
		const grid = {
			mount: () => {
				for (let i = 0; i < 20; i++) sent.set(`p${i}`, 'high');
			},
			unmount: () => sent.clear(),
		};
		// React commits the room's cleanup before the grid's effects (one commit).
		subscriptions.releaseAll();
		expect(sent.size).toBe(0);
		grid.mount();
		vi.advanceTimersByTime(5000);
		expect(sent.size).toBe(20);
		grid.unmount();
		subscriptions.apply(room);
		expect(sent).toEqual(new Map(room));
		vi.advanceTimersByTime(5000);
		expect(sent).toEqual(new Map(room));
		expect(
			calls.every((call) => ['subscribeToVideo', 'setVideoQuality', 'unsubscribeFromVideo'].includes(call.method)),
		).toBe(true);
	});

	it('unmount releases everything it holds before the grid mounts', () => {
		const {sent, adapter} = fakeServer();
		const subscriptions = new RoomCameraSubscriptions(adapter);
		subscriptions.apply(
			plan([
				['a', 'medium'],
				['b', 'low'],
				['tv', 'high'],
			]),
		);
		// `b` waits out its grace, `a` its downgrade: both still go now, and no timer fires later.
		subscriptions.apply(
			plan([
				['a', 'low'],
				['tv', 'high'],
			]),
		);
		subscriptions.releaseAll();
		expect(sent.size).toBe(0);
		expect(subscriptions.planned.size).toBe(0);
		sent.set('a', 'high');
		vi.advanceTimersByTime(5000);
		expect(sent.get('a')).toBe('high');
	});

	it('exposes the latest plan for the avatars', () => {
		const {adapter} = fakeServer();
		const subscriptions = new RoomCameraSubscriptions(adapter);
		subscriptions.apply(plan([['a', 'low']]));
		expect(subscriptions.planned.has('a')).toBe(true);
		const first = subscriptions.planned;
		subscriptions.apply(plan([['a', 'low']]));
		// An unchanged plan keeps the same map: nothing observing it re-renders.
		expect(subscriptions.planned).toBe(first);
		subscriptions.apply(plan([]));
		expect(subscriptions.planned.has('a')).toBe(false);
	});

	it('never calls setSubscribed directly', () => {
		const source = readFileSync(new URL('./RoomCameraSubscriptions.ts', import.meta.url), 'utf8');
		expect(source).not.toMatch(/setSubscribed\(/);
	});
});

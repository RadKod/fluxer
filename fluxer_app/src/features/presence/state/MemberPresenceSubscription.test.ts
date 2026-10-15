// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const socket = vi.hoisted(() => ({updateGuildSubscriptions: vi.fn()}));
vi.mock('@app/features/gateway/transport/GatewaySessionPool', () => ({default: {foregroundConnection: {socket}}}));
vi.mock('@app/features/platform/state/AccountScopedWork', () => ({AccountScopedWork: {registerCancellation: vi.fn()}}));
const {default: MemberPresenceSubscription} = await import('@app/features/presence/state/MemberPresenceSubscription');

const membersSent = () =>
	socket.updateGuildSubscriptions.mock.calls
		.map(([payload]) => payload.subscriptions.g?.members)
		.filter((members): members is Array<string> => members !== undefined);

describe('MemberPresenceSubscription visible members', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		MemberPresenceSubscription.clearAll();
		socket.updateGuildSubscriptions.mockClear();
	});
	afterEach(() => {
		MemberPresenceSubscription.clearAll();
		vi.useRealTimers();
	});

	it('subscribes the visible rows in one batched gateway update', () => {
		MemberPresenceSubscription.setVisibleMembers('g', ['a', 'b', 'c']);
		expect(membersSent()).toEqual([]);

		vi.advanceTimersByTime(500);

		expect(membersSent()).toEqual([['a', 'b', 'c']]);
	});

	it('does nothing when the visible set is unchanged', () => {
		MemberPresenceSubscription.setVisibleMembers('g', ['a', 'b']);
		vi.advanceTimersByTime(500);
		const version = MemberPresenceSubscription.subscriptionVersion;

		MemberPresenceSubscription.setVisibleMembers('g', ['b', 'a']);
		vi.advanceTimersByTime(500);

		expect(membersSent()).toHaveLength(1);
		expect(MemberPresenceSubscription.subscriptionVersion).toBe(version);
	});

	it('keeps visible rows past the TTL and against popout unsubscribe', () => {
		MemberPresenceSubscription.setVisibleMembers('g', ['a']);
		MemberPresenceSubscription.touchMember('g', 'z');
		vi.advanceTimersByTime(6 * 60 * 1000);

		MemberPresenceSubscription.unsubscribe('g', 'a');

		expect(MemberPresenceSubscription.getSubscribedMembers('g')).toEqual(['a']);
	});

	it('never evicts visible rows when the LRU overflows', () => {
		MemberPresenceSubscription.setVisibleMembers('g', ['v']);
		for (let index = 0; index < 120; index += 1) {
			MemberPresenceSubscription.touchMember('g', `p${index}`);
		}

		const subscribed = MemberPresenceSubscription.getSubscribedMembers('g');
		expect(subscribed).toContain('v');
		expect(subscribed).toHaveLength(100);
	});

	it('lets rows that scrolled away age out normally', () => {
		MemberPresenceSubscription.setVisibleMembers('g', ['a', 'b']);
		MemberPresenceSubscription.setVisibleMembers('g', ['b']);
		expect(MemberPresenceSubscription.getSubscribedMembers('g').sort()).toEqual(['a', 'b']);

		vi.advanceTimersByTime(6 * 60 * 1000);

		expect(MemberPresenceSubscription.getSubscribedMembers('g')).toEqual(['b']);
	});

});

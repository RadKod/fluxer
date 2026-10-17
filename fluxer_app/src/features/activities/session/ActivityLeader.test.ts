// SPDX-License-Identifier: AGPL-3.0-or-later

import {electLeader} from '@app/features/activities/session/ActivityLeader';
import type {ActivityParticipant} from '@app/features/activities/session/ActivitySessionTypes';
import {describe, expect, it} from 'vitest';

function participant(userId: string, connectionId: string, joinedAt: number): ActivityParticipant {
	return {identity: `user_${userId}_${connectionId}`, userId, connectionId, joinedAt, isLocal: false};
}

describe('electLeader', () => {
	const early = participant('2', 'b', 1_000);
	const starter = participant('1', 'a', 5_000);
	const late = participant('3', 'c', 9_000);

	it('picks the starter while they are in the room', () => {
		expect(electLeader([late, early, starter], '1')).toBe(starter);
	});

	it('falls to whoever joined first once the starter is gone', () => {
		expect(electLeader([late, early], '1')).toBe(early);
	});

	it('takes the starter connection that joined first when they are on two devices', () => {
		const second = participant('1', 'z', 7_000);
		expect(electLeader([second, late, starter], '1')).toBe(starter);
	});

	it('breaks a same-second join by identity, so every client agrees', () => {
		const a = participant('5', 'x', 1_000);
		const b = participant('4', 'y', 1_000);
		expect(electLeader([a, b], '9')?.identity).toBe('user_4_y');
		expect(electLeader([b, a], '9')?.identity).toBe('user_4_y');
	});

	it('has no leader in an empty room', () => {
		expect(electLeader([], '1')).toBeNull();
	});
});

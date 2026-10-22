// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createScreenSharePiPSnapshot,
	type ScreenSharePiPConditions,
	type ScreenSharePiPSnapshot,
	selectScreenSharePiPCommands,
	selectScreenSharePiPMode,
	transitionScreenSharePiPSnapshot,
} from '@app/features/voice/state/ScreenSharePiPStateMachine';
import {describe, expect, it} from 'vitest';

const ELSEWHERE: ScreenSharePiPConditions = {
	connectedChannelId: '500',
	connectedGuildId: '7',
	activity: null,
	activityMiniWindowClosed: false,
	screenShare: null,
	selectedChannelId: '900',
	isMobile: false,
	disabledBySetting: false,
	disabledBySession: false,
};

const STREAM = {participantIdentity: 'user_2_b', userId: '2', connectionId: 'b'} as const;

function step(snapshot: ScreenSharePiPSnapshot, conditions: Partial<ScreenSharePiPConditions>): ScreenSharePiPSnapshot {
	return transitionScreenSharePiPSnapshot(snapshot, {
		type: 'conditions.changed',
		conditions: {...ELSEWHERE, ...conditions},
	});
}

describe('ScreenSharePiPStateMachine', () => {
	it('follows the activity I play out of the call', () => {
		const open = step(createScreenSharePiPSnapshot(), {activity: {sessionId: 's1'}});
		expect(selectScreenSharePiPMode(open)).toEqual({
			kind: 'open',
			content: {type: 'activity', channelId: '500', guildId: '7', sessionId: 's1'},
		});
		expect(selectScreenSharePiPCommands(open)).toEqual([
			{type: 'open', content: expect.objectContaining({type: 'activity'})},
		]);
		// Unchanged conditions change nothing: the window, and the game in it, stay put.
		expect(selectScreenSharePiPCommands(step(open, {activity: {sessionId: 's1'}}))).toEqual([]);
	});

	it('closes it in the call itself, on mobile and once I close it', () => {
		const open = step(createScreenSharePiPSnapshot(), {activity: {sessionId: 's1'}});
		for (const conditions of [
			{selectedChannelId: '500'},
			{isMobile: true},
			{activityMiniWindowClosed: true},
			{connectedChannelId: null},
		]) {
			const next = step(open, {activity: {sessionId: 's1'}, ...conditions});
			expect(selectScreenSharePiPMode(next)).toEqual({kind: 'closed'});
			expect(selectScreenSharePiPCommands(next)).toEqual([{type: 'close'}]);
		}
	});

	it('puts the activity ahead of a watched stream and gives the stream back when I leave the activity', () => {
		const stream = step(createScreenSharePiPSnapshot(), {screenShare: STREAM});
		expect(selectScreenSharePiPMode(stream)).toMatchObject({kind: 'open', content: {type: 'stream'}});
		const activity = step(stream, {screenShare: STREAM, activity: {sessionId: 's1'}});
		expect(selectScreenSharePiPCommands(activity)).toEqual([
			{type: 'close'},
			{type: 'open', content: expect.objectContaining({type: 'activity', sessionId: 's1'})},
		]);
		const back = step(activity, {screenShare: STREAM});
		expect(selectScreenSharePiPMode(back)).toMatchObject({kind: 'open', content: {type: 'stream'}});
	});

	it('is not held back by the screen share switches, which are about streams', () => {
		const open = step(createScreenSharePiPSnapshot(), {
			activity: {sessionId: 's1'},
			disabledBySetting: true,
			disabledBySession: true,
		});
		expect(selectScreenSharePiPMode(open)).toMatchObject({kind: 'open', content: {type: 'activity'}});
	});

	it('swaps the window for a new session', () => {
		const first = step(createScreenSharePiPSnapshot(), {activity: {sessionId: 's1'}});
		const second = step(first, {activity: {sessionId: 's2'}});
		expect(selectScreenSharePiPCommands(second)).toEqual([
			{type: 'close'},
			{type: 'open', content: expect.objectContaining({sessionId: 's2'})},
		]);
	});
});

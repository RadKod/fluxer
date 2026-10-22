// SPDX-License-Identifier: AGPL-3.0-or-later

import {encodeJamEvents} from '@app/features/activities/band/jam/JamMessages';
import {type JamRemotePlayer, JamRemotes} from '@app/features/activities/band/jam/JamRemotes';
import type {ActivityParticipant} from '@app/features/activities/session/ActivitySessionTypes';
import {describe, expect, it, vi} from 'vitest';

function participant(userId: string, connection = 'a', isLocal = false): ActivityParticipant {
	return {identity: `${userId}:${connection}`, userId, connectionId: connection, joinedAt: 0, isLocal};
}

function mockPlayer() {
	return {
		setRemoteInstrument: vi.fn<JamRemotePlayer['setRemoteInstrument']>(),
		removeRemote: vi.fn<JamRemotePlayer['removeRemote']>(),
		receive: vi.fn<JamRemotePlayer['receive']>(),
	};
}

const NOTE = encodeJamEvents([
	{kind: 'noteOn', time: 5_000, note: 60, velocity: 0.9, pinchHarmonic: 0, powerChord: false, clean: false},
]);

describe('JamRemotes', () => {
	it('plays a seated bandmate on their instrument, each connection on its own voice', () => {
		const player = mockPlayer();
		const remotes = new JamRemotes(player);
		remotes.updateSeats([{userId: 'u1', instrument: 'rhythm'}]);
		expect(remotes.receive(participant('u1'), NOTE)).toBe('u1');
		expect(remotes.receive(participant('u1'), NOTE)).toBe('u1');
		expect(remotes.receive(participant('u1', 'b'), NOTE)).toBe('u1');
		expect(player.setRemoteInstrument.mock.calls).toEqual([
			['u1:a', 'guitar'],
			['u1:b', 'guitar'],
		]);
		expect(player.receive.mock.calls).toEqual([
			['u1:a', NOTE],
			['u1:a', NOTE],
			['u1:b', NOTE],
		]);
		expect(remotes.userOf('u1:b')).toBe('u1');
	});

	it('drops notes from people without an instrument, my own connections and anything that is not a jam message', () => {
		const player = mockPlayer();
		const remotes = new JamRemotes(player);
		remotes.updateSeats([{userId: 'me', instrument: 'keys'}]);
		expect(remotes.receive(participant('u2'), NOTE)).toBeNull();
		expect(remotes.receive(participant('me', 'a', true), NOTE)).toBeNull();
		remotes.updateSeats([{userId: 'u2', instrument: 'keys'}]);
		expect(remotes.receive(participant('u2'), {t: 'band.cheer', kind: 'clap'})).toBeNull();
		expect(player.receive).not.toHaveBeenCalled();
	});

	it('follows instrument changes and lets go of someone who put theirs down', () => {
		const player = mockPlayer();
		const remotes = new JamRemotes(player);
		remotes.updateSeats([{userId: 'u1', instrument: 'bass'}]);
		remotes.receive(participant('u1'), NOTE);
		remotes.updateSeats([{userId: 'u1', instrument: 'drums'}]);
		expect(player.setRemoteInstrument).toHaveBeenLastCalledWith('u1:a', 'drums');
		remotes.updateSeats([]);
		expect(player.removeRemote).toHaveBeenCalledWith('u1:a');
		expect(remotes.userOf('u1:a')).toBeNull();
		expect(remotes.receive(participant('u1'), NOTE)).toBeNull();
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {BAND_JAM_START_MODE, type BandIntent, type BandState} from '@app/features/activities/band/BandProtocol';
import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import {reaction} from 'mobx';

// Opens the room in the mode its starter picked in the activity picker. The hint is taken only once I lead a settled
// room still on its first song pick, so it is spent at most once and never by a client that cannot act on it.
export function followBandStartMode(
	session: ActivitySession,
	phase: () => BandState['phase'] | null,
	takeStartMode: (sessionId: string) => string | null,
	send: (intent: BandIntent) => void,
): () => void {
	return reaction(
		() => session.isLeader && session.stateSettled && phase() === 'pick',
		(ready) => {
			if (ready && takeStartMode(session.sessionId) === BAND_JAM_START_MODE) send({t: 'band.jamStart'});
		},
		{fireImmediately: true},
	);
}

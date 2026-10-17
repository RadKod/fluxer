// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ActivityParticipant} from '@app/features/activities/session/ActivitySessionTypes';

function joinedEarlier(a: ActivityParticipant, b: ActivityParticipant): boolean {
	if (a.joinedAt !== b.joinedAt) return a.joinedAt < b.joinedAt;
	return a.identity < b.identity;
}

function earliest(participants: ReadonlyArray<ActivityParticipant>): ActivityParticipant | null {
	let best: ActivityParticipant | null = null;
	for (const participant of participants) {
		if (!best || joinedEarlier(participant, best)) best = participant;
	}
	return best;
}

// Every client runs this on the same room and gets the same answer: no election messages, no split leadership
// once the participant lists agree.
export function electLeader(
	participants: ReadonlyArray<ActivityParticipant>,
	startedBy: string,
): ActivityParticipant | null {
	const starter = earliest(participants.filter((participant) => participant.userId === startedBy));
	return starter ?? earliest(participants);
}

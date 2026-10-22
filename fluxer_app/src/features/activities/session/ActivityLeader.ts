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

// The connections taking part in the activity. Each client says for itself whether it joined; one that never said
// anything is counted in, because a client from before the join step plays whenever it is in the room. My own entry
// comes from `meJoined`, never from the room.
export function selectActivityMembers(
	participants: ReadonlyArray<ActivityParticipant>,
	announced: ReadonlyMap<string, boolean>,
	meJoined: boolean,
): Array<ActivityParticipant> {
	return participants.filter((participant) =>
		participant.isLocal ? meJoined : (announced.get(participant.identity) ?? true),
	);
}

// Every client runs this on the same members and gets the same answer: no election messages, no split leadership
// once the member lists agree. Callers pass members only, so the leader always takes part.
export function electLeader(
	members: ReadonlyArray<ActivityParticipant>,
	startedBy: string,
): ActivityParticipant | null {
	const starter = earliest(members.filter((participant) => participant.userId === startedBy));
	return starter ?? earliest(members);
}

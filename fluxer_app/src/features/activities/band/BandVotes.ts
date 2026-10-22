// SPDX-License-Identifier: AGPL-3.0-or-later

// How the pick step's votes stand. Kept apart from the room machine so the call tile can say which song is ahead
// without loading the game.

import type {BandVote} from '@app/features/activities/band/BandProtocol';

export interface BandVoteTally {
	readonly songId: string;
	readonly voterIds: ReadonlyArray<string>;
}

// Voted songs by vote count; on a tie, the song whose standing votes started first.
export function tallyVotes(votes: ReadonlyArray<BandVote>): Array<BandVoteTally> {
	const bySong = new Map<string, Array<string>>();
	for (const vote of votes) {
		const voters = bySong.get(vote.songId);
		if (voters) voters.push(vote.userId);
		else bySong.set(vote.songId, [vote.userId]);
	}
	return [...bySong]
		.map(([songId, voterIds]) => ({songId, voterIds}))
		.sort((a, b) => b.voterIds.length - a.voterIds.length);
}

// SPDX-License-Identifier: AGPL-3.0-or-later

import {parseVoiceParticipantIdentity} from '@app/features/voice/utils/VoiceParticipantIdentity';

const playbackBoostByIdentity = new Map<string, number>();
let exemptUserIds: ReadonlySet<string> = new Set();

export function getRemoteVoicePlaybackBoost(identity: string): number {
	return playbackBoostByIdentity.get(identity) ?? 1;
}

export function setRemoteVoicePlaybackBoost(identity: string, boost: number): void {
	if (!Number.isFinite(boost) || boost <= 1) {
		playbackBoostByIdentity.delete(identity);
		return;
	}
	playbackBoostByIdentity.set(identity, boost);
}

export function clearRemoteVoicePlaybackBoost(identity: string): void {
	playbackBoostByIdentity.delete(identity);
}

// People whose voice plays as sent, without the boost: the leveller breathes on a singer over music. The next
// analyser tick puts an exempt voice back to unity gain.
export function setRemoteVoicePlaybackBoostExemptUserIds(userIds: Iterable<string>): void {
	exemptUserIds = new Set(userIds);
}

export function isRemoteVoicePlaybackBoostExempt(identity: string): boolean {
	if (exemptUserIds.size === 0) return false;
	const {userId} = parseVoiceParticipantIdentity(identity);
	return userId !== '' && exemptUserIds.has(userId);
}

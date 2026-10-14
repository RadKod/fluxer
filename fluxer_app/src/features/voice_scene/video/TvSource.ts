// SPDX-License-Identifier: AGPL-3.0-or-later

import type {VoiceParticipantAvatarEntry} from '@app/features/voice/components/VoiceParticipantAvatarList';
import {buildVoiceParticipantIdentity} from '@app/features/voice/utils/VoiceParticipantIdentity';

export type TvSource = {kind: 'screen'; identity: string} | {kind: 'camera'; identity: string};

const identityOf = (entry: VoiceParticipantAvatarEntry): string =>
	buildVoiceParticipantIdentity(entry.userId, entry.connectionId);

// What this viewer may put on the TV: other people's screen shares first, then their cameras; none of mine.
export function tvSources(
	entries: ReadonlyArray<VoiceParticipantAvatarEntry>,
	myUserId: string | null,
): ReadonlyArray<TvSource> {
	const others = entries.filter((entry) => !entry.isLocal && entry.userId !== myUserId);
	return [
		...others
			.filter((entry) => entry.hasScreenShare)
			.map((entry) => ({kind: 'screen' as const, identity: identityOf(entry)})),
		...others
			.filter((entry) => entry.hasCamera)
			.map((entry) => ({kind: 'camera' as const, identity: identityOf(entry)})),
	];
}

// Today's behaviour: the first screen share takes the TV; cameras go there only when picked.
export function defaultTvSource(sources: ReadonlyArray<TvSource>): TvSource | null {
	return sources.find((source) => source.kind === 'screen') ?? null;
}

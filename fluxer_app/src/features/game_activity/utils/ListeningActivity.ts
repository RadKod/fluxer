// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GameActivity} from '@app/features/gateway/types/GatewayPresenceTypes';

// The desktop shell sends Spotify now playing as a manual_name "♫ Artist – Title" so the wire schema
// stays game-only; this prefix is how every client tells it apart from a game name.
export const LISTENING_ACTIVITY_PREFIX = '♫ ';

// "Artist – Title" for a Spotify listening activity, null for a game.
export function getListeningTrack(activity: GameActivity | null | undefined): string | null {
	if (!activity || !('manual_name' in activity) || !activity.manual_name.startsWith(LISTENING_ACTIVITY_PREFIX))
		return null;
	const track = activity.manual_name.slice(LISTENING_ACTIVITY_PREFIX.length).trim();
	return track.length > 0 ? track : null;
}

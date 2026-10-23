// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import type {VoiceActivityId} from '@fluxer/constants/src/VoiceActivityConstants';
import type {I18n, MessageDescriptor} from '@lingui/core';
import type {Icon} from '@phosphor-icons/react';
import type React from 'react';

export interface ActivityViewProps {
	readonly session: ActivitySession;
}

// The cover sizes: the picker card, the detail page's header, the call tile.
export type ActivityCoverSize = 'card' | 'hero' | 'tile';

export interface ActivityCoverProps {
	readonly size: ActivityCoverSize;
}

export interface ActivityStep {
	readonly title: MessageDescriptor;
	readonly body: MessageDescriptor;
}

// What the picker shows for something to start: its card and its detail page.
export interface ActivityPresentation {
	readonly name: MessageDescriptor;
	// One line under the name in the picker.
	readonly tagline: MessageDescriptor;
	// A short paragraph on the detail page.
	readonly description: MessageDescriptor;
	readonly minPlayers: number;
	readonly maxPlayers: number;
	// Fixed facts shown as chips on the detail page, after the player range and the content count.
	readonly facts: ReadonlyArray<MessageDescriptor>;
	readonly steps: ReadonlyArray<ActivityStep>;
	// Under the Start button: what starting does to the people in the channel.
	readonly startNote: MessageDescriptor;
	readonly Cover: React.ComponentType<ActivityCoverProps>;
	// How much there is to play ("133 songs"), once this client knows; null until then. Observable reads only.
	readonly contentCount?: (i18n: I18n) => string | null;
}

// A second way into an activity, with its own card in the picker. It starts the same activity on the server; only
// the starter's client knows the mode and opens the room in it (VoiceActivities.takeStartMode), so the wire and the
// other clients stay as they are.
export interface ActivityEntry extends ActivityPresentation {
	readonly startMode: string;
}

// One activity, written in this app by the team. Everything but the View is light and loads with the app: the picker,
// the call tile and the channel list read it for every activity. The View is mounted once for as long as I take part
// and moved between the call's tile, the expanded stage and the mini window; the session outlives it.
export interface ActivityDefinition extends ActivityPresentation {
	readonly id: VoiceActivityId;
	readonly icon: Icon;
	// On the call tile of someone taking part, written per activity so each language can inflect the name.
	readonly presence: MessageDescriptor;
	// Shown in the picker after the activity's own card.
	readonly entries?: ReadonlyArray<ActivityEntry>;
	// One line about what the session is doing, for the call tile of someone who has not joined. Observable reads only.
	readonly describeState?: (session: ActivitySession, i18n: I18n) => string | null;
	// What I am doing in it ("Guitar · 2:14"), for the mini window's header. May read the session clock, which is not
	// observable, so callers refresh it on a timer.
	readonly describeMine?: (session: ActivitySession, i18n: I18n) => string | null;
	// Whether the running View is worth showing in a call tile right now (a song on the highways, not a song list).
	// While it is not, a player's tile shows the summary card and the View waits, still mounted, out of sight.
	// Without it the tile always shows the View. Observable reads only.
	readonly showsInTile?: (session: ActivitySession) => boolean;
	readonly View: React.ComponentType<ActivityViewProps>;
}

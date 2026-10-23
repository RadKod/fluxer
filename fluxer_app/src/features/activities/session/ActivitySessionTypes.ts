// SPDX-License-Identifier: AGPL-3.0-or-later

import type {VoiceActivityId} from '@fluxer/constants/src/VoiceActivityConstants';

// One LiveKit connection in the voice channel. A user on two devices is two participants.
export interface ActivityParticipant {
	readonly identity: string;
	readonly userId: string;
	readonly connectionId: string;
	// ms since the epoch; LiveKit gives whole seconds, so ties are common and the identity breaks them.
	readonly joinedAt: number;
	readonly isLocal: boolean;
}

// `from` is the LiveKit sender, never a field of the payload. My own messages are not echoed back to me.
export interface ActivityMessage {
	readonly from: ActivityParticipant;
	readonly seq: number;
	readonly payload: unknown;
}

export interface ActivitySendOptions {
	// Participant identities; everyone in the room when left out.
	readonly to?: ReadonlyArray<string>;
	// Reliable (ordered, retried) by default. Lossy suits frequent updates where only the latest matters.
	readonly reliable?: boolean;
}

export interface ActivityClock {
	// Leader time minus my time. The leader's own offset is 0.
	readonly offsetMs: number;
	// Round trip of the sample the offset came from; null until the first one.
	readonly rttMs: number | null;
	readonly synced: boolean;
	// The leader's clock as seen from here, in ms since the epoch: the same instant on every client.
	now(): number;
}

// An activity's only contact with the call. Every field is MobX-observable, so an observer View re-renders on change;
// the on* methods are for code outside React and return their unsubscribe.
export interface ActivitySession {
	readonly activityId: VoiceActivityId;
	readonly sessionId: string;
	readonly channelId: string;
	readonly startedBy: string;
	readonly startedAt: number;
	readonly me: ActivityParticipant;
	// Everyone in the voice channel, taking part or not.
	readonly participants: ReadonlyArray<ActivityParticipant>;
	// The participants who joined the activity: only they play, count for the activity's rules and lead it.
	readonly members: ReadonlyArray<ActivityParticipant>;
	// Whether this connection joined. Joining and leaving happen outside the activity, in the call's own controls.
	readonly joined: boolean;
	// The starter while one of their connections is a member, else the member who joined the room first. Same on every
	// client; null while nobody takes part.
	readonly leader: ActivityParticipant | null;
	readonly isLeader: boolean;
	readonly clock: ActivityClock;
	// The leader's last state; only its broadcasts are taken. Late joiners ask the leader for it.
	readonly state: unknown;
	readonly stateVersion: number;
	// False while this client does not know the room's newest state yet: a newcomer waiting for the leader's answer,
	// or a leader that just took over and is still asking the room. setState refuses until it turns true; a leader
	// alone in the room is settled at once.
	readonly stateSettled: boolean;
	readonly keyboardCaptured: boolean;
	onParticipantsChanged(listener: (participants: ReadonlyArray<ActivityParticipant>) => void): () => void;
	onMembersChanged(listener: (members: ReadonlyArray<ActivityParticipant>) => void): () => void;
	send(payload: unknown, options?: ActivitySendOptions): Promise<void>;
	onMessage(handler: (message: ActivityMessage) => void): () => void;
	// Leader only, once settled; returns false elsewhere. The state must be JSON and fit in one message.
	setState(state: unknown): boolean;
	onStateChanged(listener: (state: unknown) => void): () => void;
	// On by default: while the activity has focus, push-to-talk and app shortcuts wait and keys stay in the activity.
	captureKeyboard(capture: boolean): void;
	end(): Promise<boolean>;
}

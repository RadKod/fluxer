// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import type {VoiceActivitySessionMetadata} from '@fluxer/constants/src/VoiceActivityConstants';
import {makeAutoObservable, observableRef} from 'mobx';

export type VoiceActivityRequest = 'start' | 'end';

// The activity of the voice channel I am connected to. The room metadata is the source; a REST reply only fills in
// until the metadata says the same.
//
// A running session never takes over anyone's screen: it shows as a tile in the call for everyone, and only the
// people who join play and hear it. Whether I joined is kept here by session id, so it survives the live session
// being rebuilt after a reconnect, and it is what the live session announces to the room.
class VoiceActivities {
	channelId: string | null = null;
	session: VoiceActivitySessionMetadata | null = null;
	live: ActivitySession | null = null;
	request: VoiceActivityRequest | null = null;
	joinedSessionId: string | null = null;
	// The activity fills the call's stage instead of sitting in the grid. Only ever set by the user.
	expanded = false;
	// The user closed the mini window that follows a joined activity out of the call; it comes back when they return
	// to the call or ask for the activity again.
	miniWindowClosed = false;

	constructor() {
		makeAutoObservable(this, {session: observableRef, live: observableRef}, {autoBind: true});
	}

	getSession(channelId: string): VoiceActivitySessionMetadata | null {
		return this.channelId === channelId ? this.session : null;
	}

	getLive(channelId: string): ActivitySession | null {
		const live = this.live;
		return live && live.channelId === channelId && live.sessionId === this.session?.session_id ? live : null;
	}

	get joined(): boolean {
		return this.session !== null && this.joinedSessionId === this.session.session_id;
	}

	isJoined(channelId: string): boolean {
		return this.getSession(channelId) !== null && this.joined;
	}

	isExpanded(channelId: string): boolean {
		return this.expanded && this.getSession(channelId) !== null;
	}

	handleSession(channelId: string | null, session: VoiceActivitySessionMetadata | null): void {
		if (channelId !== this.channelId) {
			this.channelId = channelId;
			this.request = null;
		}
		const next = channelId ? session : null;
		if (next?.session_id === this.session?.session_id) return;
		this.session = next;
		this.expanded = false;
		this.miniWindowClosed = false;
		// Starting a session joins it before the room metadata arrives; any other session starts unjoined.
		if (next?.session_id !== this.joinedSessionId) this.joinedSessionId = null;
	}

	setLive(live: ActivitySession | null): void {
		this.live = live;
	}

	setRequest(request: VoiceActivityRequest | null): void {
		this.request = request;
	}

	// By session id, so the starter is joined by the time the session arrives from the room metadata.
	join(sessionId: string): void {
		this.joinedSessionId = sessionId;
		this.miniWindowClosed = false;
	}

	leave(): void {
		this.joinedSessionId = null;
		this.expanded = false;
	}

	expand(): void {
		if (this.session) this.expanded = true;
	}

	collapse(): void {
		this.expanded = false;
	}

	closeMiniWindow(): void {
		this.miniWindowClosed = true;
	}

	reopenMiniWindow(): void {
		this.miniWindowClosed = false;
	}

	reset(): void {
		this.channelId = null;
		this.session = null;
		this.live = null;
		this.request = null;
		this.joinedSessionId = null;
		this.expanded = false;
		this.miniWindowClosed = false;
	}
}

export default new VoiceActivities();

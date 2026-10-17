// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import type {VoiceActivitySessionMetadata} from '@fluxer/constants/src/VoiceActivityConstants';
import {makeAutoObservable, observableRef} from 'mobx';

export type VoiceActivityRequest = 'start' | 'end';

// The activity of the voice channel I am connected to. The room metadata is the source; a REST reply only fills in
// until the metadata says the same.
class VoiceActivities {
	channelId: string | null = null;
	session: VoiceActivitySessionMetadata | null = null;
	live: ActivitySession | null = null;
	panelOpen = false;
	request: VoiceActivityRequest | null = null;
	// A session opens the panel by itself once: a reconnect or a re-read of the same session leaves a closed panel
	// closed.
	private autoOpenedSessionId: string | null = null;

	constructor() {
		makeAutoObservable<VoiceActivities, 'autoOpenedSessionId'>(
			this,
			{session: observableRef, live: observableRef, autoOpenedSessionId: false},
			{autoBind: true},
		);
	}

	getSession(channelId: string): VoiceActivitySessionMetadata | null {
		return this.channelId === channelId ? this.session : null;
	}

	getLive(channelId: string): ActivitySession | null {
		const live = this.live;
		return live && live.channelId === channelId && live.sessionId === this.session?.session_id ? live : null;
	}

	isPanelOpen(channelId: string): boolean {
		return this.panelOpen && this.getSession(channelId) !== null;
	}

	handleSession(channelId: string | null, session: VoiceActivitySessionMetadata | null): void {
		if (channelId !== this.channelId) {
			this.channelId = channelId;
			this.request = null;
		}
		const next = channelId ? session : null;
		if (next?.session_id === this.session?.session_id) return;
		this.session = next;
		if (!next) {
			this.panelOpen = false;
			return;
		}
		if (next.session_id !== this.autoOpenedSessionId) {
			this.autoOpenedSessionId = next.session_id;
			this.panelOpen = true;
		}
	}

	setLive(live: ActivitySession | null): void {
		this.live = live;
	}

	setRequest(request: VoiceActivityRequest | null): void {
		this.request = request;
	}

	openPanel(): void {
		if (this.session) this.panelOpen = true;
	}

	closePanel(): void {
		this.panelOpen = false;
	}

	togglePanel(): void {
		if (this.panelOpen) this.closePanel();
		else this.openPanel();
	}

	reset(): void {
		this.channelId = null;
		this.session = null;
		this.live = null;
		this.panelOpen = false;
		this.request = null;
		this.autoOpenedSessionId = null;
	}
}

export default new VoiceActivities();

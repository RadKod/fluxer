// SPDX-License-Identifier: AGPL-3.0-or-later

// An in-memory ActivitySession for the local band harness: no LiveKit, no gateway. I am always in the room, joined
// and, as the starter, the leader; simulated peers join through connectPeer (taking part unless told they only sit in
// the call) and talk to me (and each other) over a loopback that keeps the real wire rules: payloads are JSON-encoded through the real envelope, nothing echoes to its sender,
// `to` narrows delivery, and lossy messages can be dropped.

import {encodeActivityEnvelope} from '@app/features/activities/session/ActivityEnvelope';
import {electLeader} from '@app/features/activities/session/ActivityLeader';
import type {
	ActivityClock,
	ActivityMessage,
	ActivityParticipant,
	ActivitySendOptions,
	ActivitySession,
} from '@app/features/activities/session/ActivitySessionTypes';
import {buildVoiceParticipantIdentity} from '@app/features/voice/utils/VoiceParticipantIdentity';
import type {VoiceActivityId} from '@fluxer/constants/src/VoiceActivityConstants';
import {action, computed, makeObservable, observable, observableRef} from 'mobx';

export interface FakeActivitySessionOptions {
	readonly activityId: VoiceActivityId;
	readonly myUserId: string;
	readonly channelId?: string;
	readonly localNow?: () => number;
	// One-way delivery delay for every message and state broadcast.
	readonly latencyMs?: number;
	// Share of lossy (reliable: false) messages that never arrive, 0..1.
	readonly lossyDropRate?: number;
	readonly random?: () => number;
}

// The far end of one simulated participant: what it receives and how it sends.
export interface FakeActivityPeer {
	readonly participant: ActivityParticipant;
	readonly state: unknown;
	send(payload: unknown, options?: ActivitySendOptions): void;
	onMessage(handler: (message: ActivityMessage) => void): () => void;
	onStateChanged(listener: (state: unknown) => void): () => void;
	leave(): void;
}

class FakeActivityClock implements ActivityClock {
	readonly offsetMs = 0;
	readonly rttMs = 0;
	readonly synced = true;

	constructor(private readonly localNow: () => number) {}

	now(): number {
		return this.localNow();
	}
}

interface PeerEndpoint {
	readonly participant: ActivityParticipant;
	readonly messageHandlers: Set<(message: ActivityMessage) => void>;
	readonly stateListeners: Set<(state: unknown) => void>;
	state: unknown;
	seq: number;
}

let sessionCount = 0;

function wallClockNow(): number {
	return performance.timeOrigin + performance.now();
}

export class FakeActivitySession implements ActivitySession {
	readonly activityId: VoiceActivityId;
	readonly sessionId: string;
	readonly channelId: string;
	readonly startedBy: string;
	readonly startedAt: number;
	readonly clock: ActivityClock;
	readonly me: ActivityParticipant;
	participants: ReadonlyArray<ActivityParticipant> = [];
	members: ReadonlyArray<ActivityParticipant> = [];
	joined = true;
	leader: ActivityParticipant | null = null;
	state: unknown = null;
	stateVersion = 0;
	keyboardCaptured = true;
	ended = false;
	latencyMs: number;
	lossyDropRate: number;

	private readonly localNow: () => number;
	private readonly random: () => number;
	private readonly messageHandlers = new Set<(message: ActivityMessage) => void>();
	private readonly participantListeners = new Set<(participants: ReadonlyArray<ActivityParticipant>) => void>();
	private readonly memberListeners = new Set<(members: ReadonlyArray<ActivityParticipant>) => void>();
	// Peers in the call who have not joined the activity, by identity.
	private readonly onlyInCall = new Set<string>();
	private readonly stateListeners = new Set<(state: unknown) => void>();
	private readonly peers = new Map<string, PeerEndpoint>();
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();
	private seq = 0;
	private connectionCount = 0;

	constructor({
		activityId,
		myUserId,
		channelId = 'band-dev-channel',
		localNow = wallClockNow,
		latencyMs = 30,
		lossyDropRate = 0,
		random = Math.random,
	}: FakeActivitySessionOptions) {
		this.localNow = localNow;
		this.random = random;
		this.latencyMs = latencyMs;
		this.lossyDropRate = lossyDropRate;
		this.activityId = activityId;
		this.channelId = channelId;
		this.sessionId = `band-dev-${++sessionCount}`;
		this.startedBy = myUserId;
		this.startedAt = localNow();
		this.clock = new FakeActivityClock(localNow);
		this.me = this.newParticipant(myUserId, true);
		makeObservable<FakeActivitySession, 'refreshParticipants' | 'acceptState'>(this, {
			participants: observableRef,
			members: observableRef,
			joined: observable,
			setJoined: action,
			leader: observableRef,
			state: observableRef,
			stateVersion: observable,
			keyboardCaptured: observable,
			ended: observable,
			latencyMs: observable,
			lossyDropRate: observable,
			isLeader: computed,
			setState: action,
			captureKeyboard: action,
			end: action,
			setNetwork: action,
			refreshParticipants: action,
			acceptState: action,
		});
		this.refreshParticipants([this.me]);
	}

	get isLeader(): boolean {
		return this.leader?.identity === this.me.identity;
	}

	onParticipantsChanged(listener: (participants: ReadonlyArray<ActivityParticipant>) => void): () => void {
		this.participantListeners.add(listener);
		return () => this.participantListeners.delete(listener);
	}

	onMembersChanged(listener: (members: ReadonlyArray<ActivityParticipant>) => void): () => void {
		this.memberListeners.add(listener);
		return () => this.memberListeners.delete(listener);
	}

	onMessage(handler: (message: ActivityMessage) => void): () => void {
		this.messageHandlers.add(handler);
		return () => this.messageHandlers.delete(handler);
	}

	onStateChanged(listener: (state: unknown) => void): () => void {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}

	async send(payload: unknown, {to, reliable = true}: ActivitySendOptions = {}): Promise<void> {
		if (this.ended) return;
		const message = this.wireMessage(this.me, ++this.seq, payload);
		for (const peer of this.peers.values()) {
			if (to && !to.includes(peer.participant.identity)) continue;
			this.deliver(reliable, () => this.notifyAll(peer.messageHandlers, message));
		}
	}

	setState(state: unknown): boolean {
		if (this.ended || !this.isLeader) return false;
		const version = this.stateVersion + 1;
		const wire = this.wireMessage(this.me, version, {v: version, s: state}).payload as {s: unknown};
		this.acceptState(version, wire.s);
		for (const peer of this.peers.values()) {
			this.deliver(true, () => {
				peer.state = wire.s;
				this.notifyAll(peer.stateListeners, wire.s);
			});
		}
		return true;
	}

	// Leaving the activity while staying in the call, as the call's own Leave does.
	setJoined(joined: boolean): void {
		this.joined = joined;
	}

	captureKeyboard(capture: boolean): void {
		this.keyboardCaptured = capture;
	}

	async end(): Promise<boolean> {
		this.ended = true;
		return true;
	}

	setNetwork({latencyMs, lossyDropRate}: {latencyMs?: number; lossyDropRate?: number}): void {
		if (latencyMs !== undefined) this.latencyMs = Math.max(0, latencyMs);
		if (lossyDropRate !== undefined) this.lossyDropRate = Math.min(1, Math.max(0, lossyDropRate));
	}

	// A new participant in the room. It sees the leader's current state after one latency, like a late joiner whose
	// state request was answered. With `joined: false` it is only in the call: no seat, no say in the room's rules.
	connectPeer(userId: string, {joined = true}: {joined?: boolean} = {}): FakeActivityPeer {
		const participant = this.newParticipant(userId, false);
		if (!joined) this.onlyInCall.add(participant.identity);
		const endpoint: PeerEndpoint = {
			participant,
			messageHandlers: new Set(),
			stateListeners: new Set(),
			state: null,
			seq: 0,
		};
		this.peers.set(participant.identity, endpoint);
		this.refreshParticipants([this.me, ...[...this.peers.values()].map((peer) => peer.participant)]);
		const current = this.state;
		this.deliver(true, () => {
			if (!this.peers.has(participant.identity) || endpoint.state !== null) return;
			endpoint.state = current;
			this.notifyAll(endpoint.stateListeners, current);
		});

		return {
			participant,
			get state() {
				return endpoint.state;
			},
			send: (payload, options) => this.sendFromPeer(endpoint, payload, options),
			onMessage: (handler) => {
				endpoint.messageHandlers.add(handler);
				return () => endpoint.messageHandlers.delete(handler);
			},
			onStateChanged: (listener) => {
				endpoint.stateListeners.add(listener);
				return () => endpoint.stateListeners.delete(listener);
			},
			leave: () => this.disconnectPeer(participant.identity),
		};
	}

	dispose(): void {
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
		this.peers.clear();
		this.messageHandlers.clear();
		this.participantListeners.clear();
		this.memberListeners.clear();
		this.stateListeners.clear();
	}

	private sendFromPeer(endpoint: PeerEndpoint, payload: unknown, {to, reliable = true}: ActivitySendOptions = {}) {
		if (this.ended || !this.peers.has(endpoint.participant.identity)) return;
		const message = this.wireMessage(endpoint.participant, ++endpoint.seq, payload);
		if (!to || to.includes(this.me.identity)) {
			this.deliver(reliable, () => {
				if (this.peers.has(endpoint.participant.identity)) this.notifyAll(this.messageHandlers, message);
			});
		}
		for (const peer of this.peers.values()) {
			if (peer === endpoint || (to && !to.includes(peer.participant.identity))) continue;
			this.deliver(reliable, () => this.notifyAll(peer.messageHandlers, message));
		}
	}

	private disconnectPeer(identity: string): void {
		if (!this.peers.delete(identity)) return;
		this.onlyInCall.delete(identity);
		this.refreshParticipants([this.me, ...[...this.peers.values()].map((peer) => peer.participant)]);
	}

	private newParticipant(userId: string, isLocal: boolean): ActivityParticipant {
		const connectionId = `dev${++this.connectionCount}`;
		return {
			identity: buildVoiceParticipantIdentity(userId, connectionId),
			userId,
			connectionId,
			joinedAt: Math.floor(this.localNow()) + this.connectionCount,
			isLocal,
		};
	}

	// Same bytes the room would carry, decoded again on the far side, so non-JSON values and oversize payloads fail
	// here as they would live.
	private wireMessage(from: ActivityParticipant, seq: number, payload: unknown): ActivityMessage {
		const bytes = encodeActivityEnvelope('app', seq, payload);
		const decoded = JSON.parse(new TextDecoder().decode(bytes)) as {d?: unknown};
		return {from: {...from, isLocal: false}, seq, payload: decoded.d};
	}

	private deliver(reliable: boolean, run: () => void): void {
		if (!reliable && this.random() < this.lossyDropRate) return;
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			if (!this.ended) run();
		}, this.latencyMs);
		this.timers.add(timer);
	}

	private refreshParticipants(next: ReadonlyArray<ActivityParticipant>): void {
		this.participants = [...next].sort((a, b) => (a.identity < b.identity ? -1 : 1));
		this.members = this.participants.filter((participant) => !this.onlyInCall.has(participant.identity));
		this.leader = electLeader(this.members, this.startedBy);
		this.notifyAll(this.participantListeners, this.participants);
		this.notifyAll(this.memberListeners, this.members);
	}

	private acceptState(version: number, state: unknown): void {
		this.stateVersion = version;
		this.state = state;
		this.notifyAll(this.stateListeners, state);
	}

	private notifyAll<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
		for (const listener of [...listeners]) {
			try {
				listener(value);
			} catch (error) {
				console.error('[band-dev] activity listener threw', error);
			}
		}
	}
}

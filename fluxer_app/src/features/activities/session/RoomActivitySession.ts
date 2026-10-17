// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	ACTIVITY_CLOCK_PING_TIMEOUT_MS,
	ACTIVITY_CLOCK_RESYNC_MS,
	ACTIVITY_CLOCK_ROUNDS,
	type ActivityClockSample,
	activityClockSample,
	bestActivityClockSample,
} from '@app/features/activities/session/ActivityClockMath';
import {
	type ActivityEnvelope,
	type ActivityEnvelopeType,
	decodeActivityEnvelope,
	encodeActivityEnvelope,
} from '@app/features/activities/session/ActivityEnvelope';
import {electLeader} from '@app/features/activities/session/ActivityLeader';
import type {
	ActivityClock,
	ActivityMessage,
	ActivityParticipant,
	ActivitySendOptions,
	ActivitySession,
} from '@app/features/activities/session/ActivitySessionTypes';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {parseVoiceParticipantIdentity} from '@app/features/voice/utils/VoiceParticipantIdentity';
import {
	type VoiceActivityId,
	type VoiceActivitySessionMetadata,
	voiceActivityTopic,
} from '@fluxer/constants/src/VoiceActivityConstants';
import {type Participant, type RemoteParticipant, type Room, RoomEvent} from 'livekit-client';
import {action, computed, makeObservable, observable, observableRef} from 'mobx';

const logger = new Logger('RoomActivitySession');

const STATE_REQUEST_RETRY_MS = 2_000;
const STATE_REQUEST_ATTEMPTS = 5;

interface PendingPing {
	readonly identity: string;
	readonly sentAt: number;
	readonly timer: ReturnType<typeof setTimeout>;
	readonly resolve: (sample: ActivityClockSample | null) => void;
}

export interface RoomActivitySessionOptions {
	readonly room: Room;
	readonly channelId: string;
	readonly session: VoiceActivitySessionMetadata;
	readonly end: () => Promise<boolean>;
	readonly localNow?: () => number;
}

function wallClockNow(): number {
	return performance.timeOrigin + performance.now();
}

function toActivityParticipant(participant: Participant, isLocal: boolean): ActivityParticipant | null {
	const {userId, connectionId} = parseVoiceParticipantIdentity(participant.identity);
	if (!userId || !connectionId) return null;
	return {
		identity: participant.identity,
		userId,
		connectionId,
		joinedAt: participant.joinedAt?.getTime() ?? 0,
		isLocal,
	};
}

function sameParticipants(a: ReadonlyArray<ActivityParticipant>, b: ReadonlyArray<ActivityParticipant>): boolean {
	return a.length === b.length && a.every((p, i) => p.identity === b[i].identity && p.joinedAt === b[i].joinedAt);
}

function readNumber(data: unknown, key: string): number | null {
	if (typeof data !== 'object' || data === null) return null;
	const value = (data as Record<string, unknown>)[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

class RoomActivityClock implements ActivityClock {
	offsetMs = 0;
	rttMs: number | null = null;
	synced = false;

	constructor(private readonly localNow: () => number) {
		makeObservable(this, {
			offsetMs: observable,
			rttMs: observable,
			synced: observable,
			apply: action,
			becomeReference: action,
			unsync: action,
		});
	}

	now(): number {
		return this.localNow() + this.offsetMs;
	}

	apply(sample: ActivityClockSample): void {
		this.offsetMs = sample.offsetMs;
		this.rttMs = sample.rttMs;
		this.synced = true;
	}

	becomeReference(): void {
		this.offsetMs = 0;
		this.rttMs = 0;
		this.synced = true;
	}

	// The old offset stays until a new leader is measured: a running song is better off with it than with 0.
	unsync(): void {
		this.synced = false;
	}
}

// The live side of one session in one room. It runs while I am in the room, panel open or not, so a leader with
// the panel closed still answers clock pings and state requests.
export class RoomActivitySession implements ActivitySession {
	readonly activityId: VoiceActivityId;
	readonly sessionId: string;
	readonly channelId: string;
	readonly startedBy: string;
	readonly startedAt: number;
	readonly clock: RoomActivityClock;
	me: ActivityParticipant;
	participants: ReadonlyArray<ActivityParticipant> = [];
	leader: ActivityParticipant | null = null;
	state: unknown = null;
	stateVersion = 0;
	keyboardCaptured = true;

	private readonly room: Room;
	private readonly topic: string;
	private readonly localNow: () => number;
	private readonly endSession: () => Promise<boolean>;
	private readonly messageHandlers = new Set<(message: ActivityMessage) => void>();
	private readonly participantListeners = new Set<(participants: ReadonlyArray<ActivityParticipant>) => void>();
	private readonly stateListeners = new Set<(state: unknown) => void>();
	private readonly pendingPings = new Map<number, PendingPing>();
	private seq = 0;
	private pingCount = 0;
	private clockRun = 0;
	private clockTimer: ReturnType<typeof setInterval> | null = null;
	private stateRetryTimer: ReturnType<typeof setTimeout> | null = null;
	// Whose state I hold, and which leader answered my last request.
	private stateFrom: string | null = null;
	private stateAnsweredBy: string | null = null;
	private disposed = false;

	constructor({room, channelId, session, end, localNow = wallClockNow}: RoomActivitySessionOptions) {
		this.room = room;
		this.channelId = channelId;
		this.activityId = session.activity_id;
		this.sessionId = session.session_id;
		this.startedBy = session.started_by;
		this.startedAt = session.started_at;
		this.topic = voiceActivityTopic(session.session_id);
		this.localNow = localNow;
		this.endSession = end;
		this.clock = new RoomActivityClock(localNow);
		this.me = this.readMe();
		makeObservable<RoomActivitySession, 'refreshParticipants' | 'acceptState'>(this, {
			me: observableRef,
			participants: observableRef,
			leader: observableRef,
			state: observableRef,
			stateVersion: observable,
			keyboardCaptured: observable,
			isLeader: computed,
			setState: action,
			captureKeyboard: action,
			refreshParticipants: action,
			acceptState: action,
		});
		room.on(RoomEvent.DataReceived, this.handleData);
		room.on(RoomEvent.ParticipantConnected, this.handleRoster);
		room.on(RoomEvent.ParticipantDisconnected, this.handleRoster);
		room.on(RoomEvent.Connected, this.handleRoster);
		room.on(RoomEvent.Reconnected, this.handleReconnected);
		this.refreshParticipants();
	}

	get isLeader(): boolean {
		return this.leader?.identity === this.me.identity;
	}

	onParticipantsChanged(listener: (participants: ReadonlyArray<ActivityParticipant>) => void): () => void {
		this.participantListeners.add(listener);
		return () => this.participantListeners.delete(listener);
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
		if (this.disposed) return;
		await this.publish(this.envelope('app', payload), to, reliable);
	}

	setState(state: unknown): boolean {
		if (this.disposed || !this.isLeader) return false;
		const version = this.stateVersion + 1;
		const bytes = this.envelope('state', {v: version, s: state});
		this.acceptState(this.me.identity, version, state);
		void this.publishQuietly(bytes, undefined, true);
		return true;
	}

	captureKeyboard(capture: boolean): void {
		this.keyboardCaptured = capture;
	}

	end(): Promise<boolean> {
		return this.endSession();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.room.off(RoomEvent.DataReceived, this.handleData);
		this.room.off(RoomEvent.ParticipantConnected, this.handleRoster);
		this.room.off(RoomEvent.ParticipantDisconnected, this.handleRoster);
		this.room.off(RoomEvent.Connected, this.handleRoster);
		this.room.off(RoomEvent.Reconnected, this.handleReconnected);
		this.stopClockSync();
		if (this.stateRetryTimer) clearTimeout(this.stateRetryTimer);
		this.messageHandlers.clear();
		this.participantListeners.clear();
		this.stateListeners.clear();
	}

	private readMe(): ActivityParticipant {
		const local = this.room.localParticipant;
		return (
			toActivityParticipant(local, true) ?? {
				identity: local.identity,
				userId: '',
				connectionId: '',
				joinedAt: local.joinedAt?.getTime() ?? 0,
				isLocal: true,
			}
		);
	}

	private readonly handleRoster = (): void => {
		this.refreshParticipants();
	};

	private readonly handleReconnected = (): void => {
		this.refreshParticipants();
		// Whatever the leader sent while I was away is gone; ask again and remeasure.
		if (this.isLeader) return;
		this.requestState();
		void this.syncClock();
	};

	private refreshParticipants(): void {
		if (this.disposed) return;
		const me = this.readMe();
		const remote = [...this.room.remoteParticipants.values()]
			.map((participant) => toActivityParticipant(participant, false))
			.filter((participant): participant is ActivityParticipant => participant !== null);
		const next = (me.userId ? [me, ...remote] : remote).sort((a, b) => (a.identity < b.identity ? -1 : 1));
		const previousLeader = this.leader?.identity ?? null;
		this.me = me;
		const changed = !sameParticipants(this.participants, next);
		if (changed) this.participants = next;
		const leader = electLeader(next, this.startedBy);
		if (leader?.identity !== this.leader?.identity || leader?.joinedAt !== this.leader?.joinedAt) this.leader = leader;
		if (changed) for (const listener of this.participantListeners) this.notify(listener, next);
		if ((leader?.identity ?? null) !== previousLeader) this.handleLeaderChange();
	}

	private handleLeaderChange(): void {
		this.stopClockSync();
		if (!this.leader) return;
		if (this.isLeader) {
			this.clock.becomeReference();
			this.stateFrom = this.me.identity;
			return;
		}
		this.clock.unsync();
		this.clockTimer = setInterval(() => void this.syncClock(), ACTIVITY_CLOCK_RESYNC_MS);
		void this.syncClock();
		if (this.stateAnsweredBy !== this.leader.identity) this.requestState();
	}

	private readonly handleData = (
		payload: Uint8Array,
		participant?: RemoteParticipant,
		_kind?: unknown,
		topic?: string,
	): void => {
		if (this.disposed || topic !== this.topic || !participant) return;
		const sender = toActivityParticipant(participant, false);
		if (!sender) return;
		const envelope = decodeActivityEnvelope(payload, sender.identity);
		if (!envelope) {
			logger.debug('Dropped an unreadable activity message', {from: sender.identity});
			return;
		}
		this.route(envelope, sender);
	};

	private route(envelope: ActivityEnvelope, sender: ActivityParticipant): void {
		switch (envelope.type) {
			case 'app':
				for (const handler of this.messageHandlers) {
					this.notify(handler, {from: sender, seq: envelope.seq, payload: envelope.data});
				}
				return;
			case 'ping':
				this.answerPing(envelope);
				return;
			case 'pong':
				this.takePong(envelope);
				return;
			case 'state':
				this.takeState(envelope);
				return;
			case 'state_req':
				if (this.isLeader) {
					void this.publishSystem('state', {v: this.stateVersion, s: this.state}, [envelope.from], true);
				}
				return;
		}
	}

	// A synced follower answers too: its clock is the leader's as well as it knows it, which beats no answer while
	// two clients still disagree about the room.
	private answerPing(envelope: ActivityEnvelope): void {
		const id = readNumber(envelope.data, 'id');
		if (id === null || !(this.isLeader || this.clock.synced)) return;
		void this.publishSystem('pong', {id, at: this.clock.now()}, [envelope.from], false);
	}

	private takePong(envelope: ActivityEnvelope): void {
		const id = readNumber(envelope.data, 'id');
		const at = readNumber(envelope.data, 'at');
		const pending = id === null ? undefined : this.pendingPings.get(id);
		if (id === null || at === null || !pending || pending.identity !== envelope.from) return;
		clearTimeout(pending.timer);
		this.pendingPings.delete(id);
		pending.resolve(activityClockSample(pending.sentAt, at, this.localNow()));
	}

	private takeState(envelope: ActivityEnvelope): void {
		if (envelope.from !== this.leader?.identity) return;
		const version = readNumber(envelope.data, 'v');
		if (version === null || !Number.isSafeInteger(version) || version < 0) return;
		this.stateAnsweredBy = envelope.from;
		if (this.stateRetryTimer) clearTimeout(this.stateRetryTimer);
		this.stateRetryTimer = null;
		// Versions only grow under one leader; a new leader's first state replaces the old one's whatever its number.
		if (version <= this.stateVersion && envelope.from === this.stateFrom) return;
		this.acceptState(envelope.from, version, (envelope.data as {s?: unknown}).s ?? null);
	}

	private acceptState(from: string, version: number, state: unknown): void {
		this.stateFrom = from;
		this.stateVersion = version;
		this.state = state;
		for (const listener of this.stateListeners) this.notify(listener, state);
	}

	private requestState(attempt = 0): void {
		if (this.stateRetryTimer) clearTimeout(this.stateRetryTimer);
		this.stateRetryTimer = null;
		const leader = this.leader;
		if (this.disposed || !leader || leader.isLocal) return;
		this.stateAnsweredBy = null;
		// The leader drops data from someone it has not seen join yet, so a fresh joiner asks a few times.
		void this.publishSystem('state_req', undefined, [leader.identity], true);
		if (attempt + 1 >= STATE_REQUEST_ATTEMPTS) return;
		this.stateRetryTimer = setTimeout(() => {
			this.stateRetryTimer = null;
			if (this.stateAnsweredBy !== this.leader?.identity) this.requestState(attempt + 1);
		}, STATE_REQUEST_RETRY_MS);
	}

	private async syncClock(): Promise<void> {
		const leader = this.leader;
		if (this.disposed || !leader || leader.isLocal) return;
		const run = ++this.clockRun;
		const samples: Array<ActivityClockSample> = [];
		for (let round = 0; round < ACTIVITY_CLOCK_ROUNDS; round++) {
			const sample = await this.pingLeader(leader.identity);
			if (run !== this.clockRun || this.disposed) return;
			if (sample) samples.push(sample);
		}
		const best = bestActivityClockSample(samples);
		if (best) this.clock.apply(best);
	}

	private pingLeader(identity: string): Promise<ActivityClockSample | null> {
		return new Promise((resolve) => {
			const id = ++this.pingCount;
			const timer = setTimeout(() => {
				this.pendingPings.delete(id);
				resolve(null);
			}, ACTIVITY_CLOCK_PING_TIMEOUT_MS);
			this.pendingPings.set(id, {identity, sentAt: this.localNow(), timer, resolve});
			// Lossy: a late pong is a bad sample anyway, and a lost one only costs its round.
			void this.publishSystem('ping', {id}, [identity], false);
		});
	}

	private stopClockSync(): void {
		this.clockRun += 1;
		if (this.clockTimer) clearInterval(this.clockTimer);
		this.clockTimer = null;
		for (const pending of this.pendingPings.values()) {
			clearTimeout(pending.timer);
			pending.resolve(null);
		}
		this.pendingPings.clear();
	}

	// Throws for a message over the size limit, before anything is sent or changed.
	private envelope(type: ActivityEnvelopeType, data: unknown): Uint8Array<ArrayBuffer> {
		const bytes = encodeActivityEnvelope(type, this.seq + 1, data);
		this.seq += 1;
		return bytes;
	}

	private async publish(
		bytes: Uint8Array<ArrayBuffer>,
		to: ReadonlyArray<string> | undefined,
		reliable: boolean,
	): Promise<void> {
		await this.room.localParticipant.publishData(bytes, {
			reliable,
			topic: this.topic,
			destinationIdentities: to ? [...to] : undefined,
		});
	}

	private async publishQuietly(
		bytes: Uint8Array<ArrayBuffer>,
		to: ReadonlyArray<string> | undefined,
		reliable: boolean,
	): Promise<void> {
		try {
			await this.publish(bytes, to, reliable);
		} catch (error) {
			logger.debug('Failed to publish an activity message', error);
		}
	}

	private async publishSystem(
		type: ActivityEnvelopeType,
		data: unknown,
		to: ReadonlyArray<string> | undefined,
		reliable: boolean,
	): Promise<void> {
		let bytes: Uint8Array<ArrayBuffer>;
		try {
			bytes = this.envelope(type, data);
		} catch (error) {
			logger.warn('Activity system message too large', {type, error});
			return;
		}
		await this.publishQuietly(bytes, to, reliable);
	}

	private notify<T>(listener: (value: T) => void, value: T): void {
		try {
			listener(value);
		} catch (error) {
			logger.error('Activity listener threw', error);
		}
	}
}

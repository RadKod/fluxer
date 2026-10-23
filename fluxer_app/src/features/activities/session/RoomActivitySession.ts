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
import {electLeader, selectActivityMembers} from '@app/features/activities/session/ActivityLeader';
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
// A leader that takes over asks the whole room what it holds before it leads. Clients from before the leadership
// term never answer, so it waits for them only this many rounds of this long.
const LEADER_SYNC_RETRY_MS = 1_000;
const LEADER_SYNC_ATTEMPTS = 3;

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
	// Whether this connection takes part from the start (it started the session, or joined before a reconnect).
	readonly joined?: boolean;
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

function readBoolean(data: unknown, key: string): boolean | null {
	if (typeof data !== 'object' || data === null) return null;
	const value = (data as Record<string, unknown>)[key];
	return typeof value === 'boolean' ? value : null;
}

function sameParticipants(a: ReadonlyArray<ActivityParticipant>, b: ReadonlyArray<ActivityParticipant>): boolean {
	return a.length === b.length && a.every((p, i) => p.identity === b[i].identity && p.joinedAt === b[i].joinedAt);
}

function readNumber(data: unknown, key: string): number | null {
	if (typeof data !== 'object' || data === null) return null;
	const value = (data as Record<string, unknown>)[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readCount(data: unknown, key: string): number | null {
	const value = readNumber(data, key);
	return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// A state message: {v, s, term} from a leader, plus {copy, by} when a follower tells what it holds and which leader
// made it. The term counts leadership takeovers and outranks the version, which only grows within one term; it is
// null in states from clients that predate it.
interface HeldState {
	readonly term: number | null;
	readonly version: number;
	readonly state: unknown;
	readonly copy: boolean;
	readonly by: string | null;
}

function readHeldState(data: unknown): HeldState | null {
	const version = readCount(data, 'v');
	if (version === null) return null;
	const term = readCount(data, 'term');
	if (term === null && typeof data === 'object' && data !== null && 'term' in data) return null;
	const {s: state = null, by} = data as {s?: unknown; by?: unknown};
	return {term, version, state, copy: readBoolean(data, 'copy') === true, by: typeof by === 'string' ? by : null};
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

// The live side of one session in one room. It runs while I am in the room, joined or not: everyone follows the
// leader's state (the call shows it), and a leader whose activity is out of sight still answers pings and requests.
// Membership travels peer to peer: each client announces its own, answers a newcomer and anyone who asks, and the
// leader is elected among members only.
export class RoomActivitySession implements ActivitySession {
	readonly activityId: VoiceActivityId;
	readonly sessionId: string;
	readonly channelId: string;
	readonly startedBy: string;
	readonly startedAt: number;
	readonly clock: RoomActivityClock;
	me: ActivityParticipant;
	participants: ReadonlyArray<ActivityParticipant> = [];
	members: ReadonlyArray<ActivityParticipant> = [];
	joined: boolean;
	leader: ActivityParticipant | null = null;
	state: unknown = null;
	stateVersion = 0;
	stateSettled = false;
	keyboardCaptured = true;

	private readonly room: Room;
	private readonly topic: string;
	private readonly localNow: () => number;
	private readonly endSession: () => Promise<boolean>;
	private readonly messageHandlers = new Set<(message: ActivityMessage) => void>();
	private readonly participantListeners = new Set<(participants: ReadonlyArray<ActivityParticipant>) => void>();
	private readonly memberListeners = new Set<(members: ReadonlyArray<ActivityParticipant>) => void>();
	// What each remote connection last said about taking part, by identity.
	private readonly announcedMembership = new Map<string, boolean>();
	private readonly stateListeners = new Set<(state: unknown) => void>();
	private readonly pendingPings = new Map<number, PendingPing>();
	private seq = 0;
	private pingCount = 0;
	private clockRun = 0;
	private clockTimer: ReturnType<typeof setInterval> | null = null;
	private stateRetryTimer: ReturnType<typeof setTimeout> | null = null;
	// The leader that made the state I hold and under which term, and which leader answered my last request.
	private stateFrom: string | null = null;
	private stateTerm = 0;
	private stateAnsweredBy: string | null = null;
	// While I am a leader catching up with the room: who has not told me yet what they hold. Null otherwise.
	private syncPending: Set<string> | null = null;
	private syncTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;

	constructor({room, channelId, session, end, joined = false, localNow = wallClockNow}: RoomActivitySessionOptions) {
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
		this.joined = joined;
		this.me = this.readMe();
		makeObservable<
			RoomActivitySession,
			'refreshParticipants' | 'acceptState' | 'takeMembership' | 'markStateSettled' | 'settleLeadership'
		>(this, {
			me: observableRef,
			participants: observableRef,
			members: observableRef,
			joined: observable,
			leader: observableRef,
			state: observableRef,
			stateVersion: observable,
			stateSettled: observable,
			keyboardCaptured: observable,
			isLeader: computed,
			setState: action,
			captureKeyboard: action,
			setJoined: action,
			refreshParticipants: action,
			acceptState: action,
			takeMembership: action,
			markStateSettled: action,
			settleLeadership: action,
		});
		room.on(RoomEvent.DataReceived, this.handleData);
		room.on(RoomEvent.ParticipantConnected, this.handleParticipantConnected);
		room.on(RoomEvent.ParticipantDisconnected, this.handleParticipantDisconnected);
		room.on(RoomEvent.Connected, this.handleConnected);
		room.on(RoomEvent.Reconnected, this.handleReconnected);
		this.refreshParticipants();
		this.announceMembership();
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
		if (this.disposed) return;
		await this.publish(this.envelope('app', payload), to, reliable);
	}

	setState(state: unknown): boolean {
		if (this.disposed || !this.isLeader || !this.stateSettled) return false;
		this.broadcastState(state);
		return true;
	}

	captureKeyboard(capture: boolean): void {
		this.keyboardCaptured = capture;
	}

	setJoined(joined: boolean): void {
		if (this.disposed || this.joined === joined) return;
		this.joined = joined;
		this.refreshParticipants();
		void this.publishSystem('member', {joined}, undefined, true);
	}

	end(): Promise<boolean> {
		return this.endSession();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.room.off(RoomEvent.DataReceived, this.handleData);
		this.room.off(RoomEvent.ParticipantConnected, this.handleParticipantConnected);
		this.room.off(RoomEvent.ParticipantDisconnected, this.handleParticipantDisconnected);
		this.room.off(RoomEvent.Connected, this.handleConnected);
		this.room.off(RoomEvent.Reconnected, this.handleReconnected);
		this.stopClockSync();
		this.stopLeaderSync();
		if (this.stateRetryTimer) clearTimeout(this.stateRetryTimer);
		this.messageHandlers.clear();
		this.participantListeners.clear();
		this.memberListeners.clear();
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

	// A session made while the room was still connecting could not send its first announcement, and a leader that saw
	// nobody settled on nothing while the room may hold a state.
	private readonly handleConnected = (): void => {
		this.refreshParticipants();
		this.announceMembership();
		if (this.isLeader && !this.syncPending) this.syncAsLeader();
	};

	// The newcomer may not have its session yet, or may not see me yet: I tell it mine and ask for its own. Its own
	// announcement on start covers the opposite order.
	private readonly handleParticipantConnected = (participant?: RemoteParticipant): void => {
		this.refreshParticipants();
		if (!participant || this.disposed) return;
		void this.publishSystem('member', {joined: this.joined}, [participant.identity], true);
		void this.publishSystem('member_req', undefined, [participant.identity], true);
	};

	private readonly handleParticipantDisconnected = (participant?: RemoteParticipant): void => {
		if (participant) this.announcedMembership.delete(participant.identity);
		this.refreshParticipants();
		if (participant && this.syncPending?.delete(participant.identity) && this.syncPending.size === 0) {
			this.settleLeadership();
		}
	};

	private readonly handleReconnected = (): void => {
		this.refreshParticipants();
		this.announceMembership();
		// While I was away the room may have elected someone else who moved on, and what I sent may be lost. As leader
		// I catch up with the room and send my state again; as follower I ask again and remeasure.
		if (this.isLeader) {
			if (!this.syncPending) this.syncAsLeader();
			return;
		}
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
		const members = selectActivityMembers(next, this.announcedMembership, this.joined);
		const membersChanged = !sameParticipants(this.members, members);
		if (membersChanged) this.members = members;
		const leader = electLeader(members, this.startedBy);
		if (leader?.identity !== this.leader?.identity || leader?.joinedAt !== this.leader?.joinedAt) this.leader = leader;
		if (changed) for (const listener of this.participantListeners) this.notify(listener, next);
		if (membersChanged) for (const listener of this.memberListeners) this.notify(listener, members);
		if ((leader?.identity ?? null) !== previousLeader) this.handleLeaderChange();
	}

	// Mine to everyone, and a request for theirs: on start and after a reconnect, when what I knew may be stale.
	private announceMembership(): void {
		if (this.disposed) return;
		void this.publishSystem('member', {joined: this.joined}, undefined, true);
		void this.publishSystem('member_req', undefined, undefined, true);
	}

	private takeMembership(identity: string, joined: boolean): void {
		if (this.announcedMembership.get(identity) === joined) return;
		this.announcedMembership.set(identity, joined);
		this.refreshParticipants();
	}

	private handleLeaderChange(): void {
		this.stopClockSync();
		this.stopLeaderSync();
		if (!this.leader) return;
		if (this.isLeader) {
			this.clock.becomeReference();
			this.syncAsLeader();
			return;
		}
		this.clock.unsync();
		this.clockTimer = setInterval(() => void this.syncClock(), ACTIVITY_CLOCK_RESYNC_MS);
		void this.syncClock();
		if (this.stateAnsweredBy !== this.leader.identity) this.requestState();
		// The new leader may know less than I do (it was away, or missed the last broadcasts); it weighs my copy.
		this.offerState(this.leader.identity);
	}

	// Before leading, learn the newest state anyone in the room holds: a leader back from a dropped connection may
	// have been replaced by one that moved the room on. Alone, there is nobody to ask.
	private syncAsLeader(): void {
		const peers = this.participants.filter((participant) => !participant.isLocal).map((p) => p.identity);
		if (peers.length === 0) {
			this.settleLeadership();
			return;
		}
		this.markStateSettled(false);
		this.syncPending = new Set(peers);
		this.askRoomForState(0);
	}

	private askRoomForState(attempt: number): void {
		const pending = this.syncPending;
		if (this.disposed || !pending) return;
		void this.publishSystem('state_req', undefined, [...pending], true);
		this.syncTimer = setTimeout(() => {
			this.syncTimer = null;
			if (attempt + 1 >= LEADER_SYNC_ATTEMPTS) this.settleLeadership();
			else this.askRoomForState(attempt + 1);
		}, LEADER_SYNC_RETRY_MS);
	}

	private stopLeaderSync(): void {
		if (this.syncTimer) clearTimeout(this.syncTimer);
		this.syncTimer = null;
		this.syncPending = null;
	}

	// Leadership starts a new term, above every term I have seen, and the state I continue from goes out under it:
	// followers drop anything from an older term, so a leader that comes back with a stale copy cannot roll them back.
	private settleLeadership(): void {
		this.stopLeaderSync();
		if (this.disposed || !this.isLeader) return;
		this.stateTerm += 1;
		this.stateFrom = this.me.identity;
		this.markStateSettled(true);
		if (this.state === null) return;
		try {
			this.broadcastState(this.state);
		} catch (error) {
			logger.warn('Could not send the state again under the new term', error);
		}
	}

	private markStateSettled(settled: boolean): void {
		this.stateSettled = settled;
	}

	// Throws for a state over the size limit, before anything is sent or changed.
	private broadcastState(state: unknown): void {
		const version = this.stateVersion + 1;
		const bytes = this.envelope('state', {v: version, s: state, term: this.stateTerm});
		this.acceptState(this.me.identity, version, state, this.stateTerm);
		void this.publishQuietly(bytes, undefined, true);
	}

	private offerState(identity: string): void {
		const held = {v: this.stateVersion, s: this.state, term: this.stateTerm};
		const data = this.isLeader ? held : {...held, copy: true, ...(this.stateFrom && {by: this.stateFrom})};
		void this.publishSystem('state', data, [identity], true);
	}

	// Above zero when the given state is newer than mine: by term, then by version.
	private compareToMine(term: number, version: number): number {
		return term !== this.stateTerm ? term - this.stateTerm : version - this.stateVersion;
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
				if (this.isLeader) this.takeOffer(envelope);
				else this.takeState(envelope);
				return;
			case 'state_req':
				// A follower asks its leader, a leader catching up asks everyone; either way I say what I hold. While I
				// am catching up myself I have nothing reliable to say: my broadcast follows once I know.
				if (!this.syncPending) this.offerState(envelope.from);
				return;
			case 'member': {
				const joined = readBoolean(envelope.data, 'joined');
				if (joined !== null) this.takeMembership(envelope.from, joined);
				return;
			}
			case 'member_req':
				void this.publishSystem('member', {joined: this.joined}, [envelope.from], true);
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
		const held = readHeldState(envelope.data);
		if (!held) return;
		this.stateAnsweredBy = envelope.from;
		if (this.stateRetryTimer) clearTimeout(this.stateRetryTimer);
		this.stateRetryTimer = null;
		this.markStateSettled(true);
		// A state without a term comes from an older leader and is judged as that client would: anything from a
		// different leader than the last, or a higher version from the same one.
		if (held.term === null) {
			if (envelope.from !== this.stateFrom || held.version > this.stateVersion) {
				this.acceptState(envelope.from, held.version, held.state, this.stateTerm);
			}
			return;
		}
		const by = held.by ?? envelope.from;
		// Two leaders took the same term (one could not hear the room when it took over): neither copy outranks the
		// other, so I keep mine and the leader settles it, as for a leader that is behind.
		const fork = held.term === this.stateTerm && this.stateFrom !== null && by !== this.stateFrom;
		const order = this.compareToMine(held.term, held.version);
		if (order > 0 && !fork) this.acceptState(by, held.version, held.state, held.term);
		// My leader is behind what I hold (it led on a stale copy before it heard from me): it takes mine and moves on.
		else if (order < 0 || fork) this.offerState(envelope.from);
	}

	// As leader: any answer while I catch up, then a follower's copy newer than mine that I missed. Either way the
	// newest wins and goes out again under a fresh term. Another leader's own broadcasts (two clients that disagree
	// about the room for a moment) are not copies; taking those would have the two outbid each other forever.
	private takeOffer(envelope: ActivityEnvelope): void {
		const held = readHeldState(envelope.data);
		if (!held || (!this.syncPending && !held.copy)) return;
		const term = held.term ?? 0;
		const by = held.by ?? envelope.from;
		// Once I lead, a copy from another leader under my own term is a fork the room went on with; it wins.
		const fork = !this.syncPending && term === this.stateTerm && by !== this.me.identity;
		const newer = this.compareToMine(term, held.version) > 0 || fork;
		if (newer) this.acceptState(by, held.version, held.state, term);
		const pending = this.syncPending;
		if (pending) {
			pending.delete(envelope.from);
			if (pending.size === 0) this.settleLeadership();
			return;
		}
		if (newer) this.settleLeadership();
	}

	private acceptState(from: string, version: number, state: unknown, term: number): void {
		this.stateFrom = from;
		this.stateTerm = term;
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
		this.stateRetryTimer = setTimeout(() => {
			this.stateRetryTimer = null;
			if (this.stateAnsweredBy === this.leader?.identity) return;
			// Nobody answers: what I hold is all there is to know.
			if (attempt + 1 >= STATE_REQUEST_ATTEMPTS) this.markStateSettled(true);
			else this.requestState(attempt + 1);
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

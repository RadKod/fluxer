// SPDX-License-Identifier: AGPL-3.0-or-later

// Everything the band game keeps per session on this client: the leader controller, the song library, the crowd and
// the mic guard. It outlives the View on purpose: closing the panel must not stop the leader from running the room,
// nor drop a download in progress. One room exists at a time; it ends with its session.

import type {
	BandCheerKind,
	BandCheerMessage,
	BandIntent,
	BandSeat,
	BandState,
} from '@app/features/activities/band/BandProtocol';
import type {SongPackage} from '@app/features/activities/band/engine/SongPackage';
import {BandCrowd, isBandCheerKind} from '@app/features/activities/band/flow/BandCrowd';
import {BandLeaderController} from '@app/features/activities/band/flow/BandLeaderController';
import {BandMicGuard, type BandMicPort} from '@app/features/activities/band/flow/BandMicGuard';
import {VOICE_MIC_PORT} from '@app/features/activities/band/flow/BandMicPort';
import {type BandRoomContext, isBandState} from '@app/features/activities/band/flow/BandRoomMachine';
import {
	type BandLibraryFailure,
	BandSongLibrary,
	BandSongLibraryError,
} from '@app/features/activities/band/flow/BandSongLibrary';
import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import VoiceActivities from '@app/features/activities/state/VoiceActivities';
import {action, computed, makeObservable, observableRef, reaction} from 'mobx';

export type BandSongPackageState =
	| {readonly songId: string; readonly status: 'loading'}
	| {readonly songId: string; readonly status: 'ready'; readonly songPackage: SongPackage}
	| {readonly songId: string; readonly status: 'failed'; readonly reason: BandLibraryFailure};

export class BandRoom {
	readonly library: BandSongLibrary;
	readonly crowd = new BandCrowd();
	songPackage: BandSongPackageState | null = null;
	private readonly controller: BandLeaderController;
	private readonly micGuard: BandMicGuard;
	private readonly disposers: Array<() => void> = [];
	private disposed = false;

	constructor(
		readonly session: ActivitySession,
		{
			library = new BandSongLibrary(),
			micPort = VOICE_MIC_PORT,
		}: {library?: BandSongLibrary; micPort?: BandMicPort} = {},
	) {
		this.library = library;
		this.micGuard = new BandMicGuard(micPort);
		this.controller = new BandLeaderController(session, () => this.context);
		makeObservable<BandRoom, 'setSongPackage'>(this, {
			songPackage: observableRef,
			state: computed,
			context: computed,
			mySeat: computed,
			spectatorIds: computed,
			setSongPackage: action,
		});
		this.start();
	}

	get state(): BandState | null {
		return isBandState(this.session.state) ? this.session.state : null;
	}

	get myUserId(): string {
		return this.session.me.userId;
	}

	get context(): BandRoomContext {
		return {
			leaderId: this.session.leader?.userId ?? null,
			presentUserIds: new Set(this.session.participants.map((participant) => participant.userId)),
			songs: this.library.songsById,
		};
	}

	get mySeat(): BandSeat | undefined {
		const state = this.state;
		if (!state || state.phase === 'pick') return undefined;
		return state.seats.find((seat) => seat.userId === this.myUserId);
	}

	// Everyone in the room without a seat, one entry per person.
	get spectatorIds(): ReadonlyArray<string> {
		const state = this.state;
		const seated = new Set(state && state.phase !== 'pick' ? state.seats.map((seat) => seat.userId) : []);
		const ids = this.session.participants.map((participant) => participant.userId).filter((id) => !seated.has(id));
		return [...new Set(ids)];
	}

	send(intent: BandIntent): void {
		this.controller.sendIntent(intent);
	}

	cheer(kind: BandCheerKind): void {
		if (!this.crowd.receive(this.myUserId, kind, this.session.clock.now())) return;
		void this.session.send({t: 'band.cheer', kind}, {reliable: false});
	}

	retrySongPackage(): void {
		const current = this.songPackage;
		if (current?.status === 'failed') this.loadSongPackage(current.songId);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.micGuard.update(null);
		this.controller.stop();
		for (const dispose of this.disposers.splice(0)) dispose();
	}

	private start(): void {
		void this.library.load();
		this.controller.start();
		this.disposers.push(
			this.session.onMessage(({from, payload}) => {
				const cheer = payload as Partial<Record<keyof BandCheerMessage, unknown>> | null;
				if (cheer?.t === 'band.cheer' && isBandCheerKind(cheer.kind)) {
					this.crowd.receive(from.userId, cheer.kind, this.session.clock.now());
				}
			}),
			reaction(
				() => {
					const state = this.state;
					return state && state.phase !== 'pick' && this.library.status.status === 'ready' ? state.songId : null;
				},
				(songId) => {
					if (songId && this.songPackage?.songId !== songId) this.loadSongPackage(songId);
				},
				{fireImmediately: true},
			),
			// Voted songs start downloading during the 6 s countdown, so the winner is usually on disk by part picking.
			reaction(
				() => {
					const state = this.state;
					return state?.phase === 'pick' ? [...new Set(state.votes.map((vote) => vote.songId))].join(',') : '';
				},
				(voted) => {
					if (voted) this.library.prefetch(voted.split(','));
				},
			),
			reaction(
				() => (this.state?.phase === 'play' ? (this.mySeat?.part ?? null) : null),
				(part) => this.micGuard.update(part),
				{fireImmediately: true},
			),
			reaction(
				() => {
					const state = this.state;
					return state?.phase === 'play' ? `${state.songId}:${state.startAt}` : null;
				},
				(song) => {
					if (song) this.crowd.reset();
				},
			),
		);
	}

	private loadSongPackage(songId: string): void {
		this.setSongPackage({songId, status: 'loading'});
		this.library.ensure(songId).then(
			(songPackage) => {
				if (this.songPackage?.songId === songId) this.setSongPackage({songId, status: 'ready', songPackage});
			},
			(error: unknown) => {
				const reason = error instanceof BandSongLibraryError ? error.reason : 'corrupt';
				if (this.songPackage?.songId === songId) this.setSongPackage({songId, status: 'failed', reason});
			},
		);
	}

	private setSongPackage(state: BandSongPackageState): void {
		this.songPackage = state;
	}
}

let current: BandRoom | null = null;
let disposeLiveWatch: (() => void) | null = null;

// The room for this session, created on first use. The real call session ends when the store lets go of it; a session
// that never goes through the store (the local harness) lives until another session takes its place.
export function getBandRoom(session: ActivitySession): BandRoom {
	if (current?.session === session) return current;
	current?.dispose();
	disposeLiveWatch?.();
	const room = new BandRoom(session);
	current = room;
	disposeLiveWatch = reaction(
		() => VoiceActivities.live,
		(live, previous) => {
			if (previous !== room.session || live === room.session) return;
			room.dispose();
			disposeLiveWatch?.();
			disposeLiveWatch = null;
			if (current === room) current = null;
		},
	);
	return room;
}

// SPDX-License-Identifier: AGPL-3.0-or-later

// Everything the band game keeps per session on this client: the leader controller, the song library, the crowd, the
// mic guard and the singer's voice processing. It outlives the View on purpose: moving the View between the tile, the
// stage and the mini window must not stop the leader from running the room, nor drop a download in progress. One room
// exists at a time; it ends with its session or when I leave the activity.

import type {
	BandCheerKind,
	BandCheerMessage,
	BandIntent,
	BandSeat,
	BandState,
} from '@app/features/activities/band/BandProtocol';
import type {InstrumentPart} from '@app/features/activities/band/engine/ChartModel';
import {FREESTYLE_PARTS, freestyleSections, isFreestylePart} from '@app/features/activities/band/engine/FreestyleSolo';
import {type SongPackage, SongPackageError} from '@app/features/activities/band/engine/SongPackage';
import {BandCrowd, isBandCheerKind} from '@app/features/activities/band/flow/BandCrowd';
import {
	type BandPreferenceStorage,
	browserFreestyleStorage,
	readFreestyleSolo,
	writeFreestyleSolo,
} from '@app/features/activities/band/flow/BandFreestylePreference';
import {BandLeaderController} from '@app/features/activities/band/flow/BandLeaderController';
import {BandMicGuard, type BandMicPort} from '@app/features/activities/band/flow/BandMicGuard';
import {VOICE_MIC_PORT, VOICE_SINGER_PORT} from '@app/features/activities/band/flow/BandMicPort';
import {type BandRoomContext, isBandState} from '@app/features/activities/band/flow/BandRoomMachine';
import {
	BandSingerMic,
	type BandSingerOutput,
	type BandSingerOutputStorage,
	type BandVoicePort,
	browserSingerOutputStorage,
	readSingerOutput,
	writeSingerOutput,
} from '@app/features/activities/band/flow/BandSingerVoice';
import {
	type BandLibraryFailure,
	BandSongLibrary,
	BandSongLibraryError,
} from '@app/features/activities/band/flow/BandSongLibrary';
import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import VoiceActivities from '@app/features/activities/state/VoiceActivities';
import {action, compareStructural, computed, makeObservable, observable, observableRef, reaction} from 'mobx';

export type BandSongPackageState =
	| {readonly songId: string; readonly status: 'loading'}
	| {readonly songId: string; readonly status: 'ready'; readonly songPackage: SongPackage}
	| {readonly songId: string; readonly status: 'failed'; readonly reason: BandLibraryFailure};

const LOADED_RESEND_MS = 3_000;

export class BandRoom {
	readonly library: BandSongLibrary;
	readonly crowd = new BandCrowd();
	songPackage: BandSongPackageState | null = null;
	// What I hear the song on when I sing; remembered per user on this device.
	singerOutput: BandSingerOutput;
	// I play solo sections freestyle when my part has them; remembered per user on this device.
	freestyleSolo: boolean;
	private readonly controller: BandLeaderController;
	private readonly micGuard: BandMicGuard;
	private readonly singerMic: BandSingerMic;
	private readonly voicePort: BandVoicePort;
	private readonly singerOutputStorage: () => BandSingerOutputStorage;
	private readonly freestyleStorage: () => BandPreferenceStorage;
	private readonly disposers: Array<() => void> = [];
	private disposed = false;

	constructor(
		readonly session: ActivitySession,
		{
			library = new BandSongLibrary(),
			micPort = VOICE_MIC_PORT,
			voicePort = VOICE_SINGER_PORT,
			singerOutputStorage = browserSingerOutputStorage,
			freestyleStorage = browserFreestyleStorage,
		}: {
			library?: BandSongLibrary;
			micPort?: BandMicPort;
			voicePort?: BandVoicePort;
			singerOutputStorage?: () => BandSingerOutputStorage;
			freestyleStorage?: () => BandPreferenceStorage;
		} = {},
	) {
		this.library = library;
		this.micGuard = new BandMicGuard(micPort);
		this.voicePort = voicePort;
		this.singerOutputStorage = singerOutputStorage;
		this.singerOutput = readSingerOutput(singerOutputStorage, session.me.userId);
		this.freestyleStorage = freestyleStorage;
		this.freestyleSolo = readFreestyleSolo(freestyleStorage, session.me.userId);
		this.singerMic = new BandSingerMic(
			voicePort,
			() => session.clock.now(),
			() => this.singerOutput,
		);
		this.controller = new BandLeaderController(session, () => this.context);
		makeObservable<BandRoom, 'setSongPackage'>(this, {
			songPackage: observableRef,
			singerOutput: observable,
			setSingerOutput: action,
			freestyleSolo: observable,
			setFreestyleSolo: action,
			songFreestyleParts: computed,
			state: computed,
			context: computed,
			mySeat: computed,
			songLoaded: computed,
			songHasBigRockEnding: computed,
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
			presentUserIds: new Set(this.session.members.map((member) => member.userId)),
			songs: this.library.songsById,
		};
	}

	get mySeat(): BandSeat | undefined {
		const state = this.state;
		if (!state || state.phase === 'pick') return undefined;
		return state.seats.find((seat) => seat.userId === this.myUserId);
	}

	// The package of the room's current song is open on this client.
	get songLoaded(): boolean {
		const state = this.state;
		if (!state || state.phase === 'pick') return false;
		return this.songPackage?.songId === state.songId && this.songPackage.status === 'ready';
	}

	// The current song ends in a Big Rock Ending; known once its package is open here.
	get songHasBigRockEnding(): boolean {
		const loaded = this.songPackage;
		if (!this.songLoaded || loaded?.status !== 'ready') return false;
		try {
			return loaded.songPackage.chart().bigRockEnding !== null;
		} catch (error) {
			if (error instanceof SongPackageError) return false;
			throw error;
		}
	}

	// Parts of the current song with solo sections to play freestyle; known once its package is open here.
	get songFreestyleParts(): ReadonlySet<InstrumentPart> {
		const loaded = this.songPackage;
		if (!this.songLoaded || loaded?.status !== 'ready') return new Set();
		try {
			const chart = loaded.songPackage.chart();
			return new Set(
				FREESTYLE_PARTS.filter((part) => {
					const partChart = chart.partChart(part, 'expert');
					return partChart !== null && freestyleSections(partChart, chart.sections).length > 0;
				}),
			);
		} catch (error) {
			if (error instanceof SongPackageError) return new Set();
			throw error;
		}
	}

	// Everyone taking part without a seat, one entry per person. Someone in the call who has not joined is not watching.
	get spectatorIds(): ReadonlyArray<string> {
		const state = this.state;
		const seated = new Set(state && state.phase !== 'pick' ? state.seats.map((seat) => seat.userId) : []);
		const ids = this.session.members.map((member) => member.userId).filter((id) => !seated.has(id));
		return [...new Set(ids)];
	}

	send(intent: BandIntent): void {
		if (intent.t === 'band.ready' && intent.ready && !this.songLoaded) return;
		this.controller.sendIntent(intent);
	}

	cheer(kind: BandCheerKind): void {
		if (!this.crowd.receive(this.myUserId, kind, this.session.clock.now())) return;
		void this.session.send({t: 'band.cheer', kind}, {reliable: false});
	}

	setSingerOutput(output: BandSingerOutput): void {
		this.singerOutput = output;
		writeSingerOutput(this.singerOutputStorage, this.myUserId, output);
	}

	setFreestyleSolo(enabled: boolean): void {
		this.freestyleSolo = enabled;
		writeFreestyleSolo(this.freestyleStorage, this.myUserId, enabled);
	}

	retrySongPackage(): void {
		const current = this.songPackage;
		if (current?.status === 'failed') this.loadSongPackage(current.songId);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.micGuard.update(null);
		this.singerMic.release();
		this.voicePort.setUnlevelledVoices([]);
		this.controller.stop();
		for (const dispose of this.disposers.splice(0)) dispose();
	}

	private start(): void {
		void this.library.load();
		this.controller.start();
		// A reload or a closed window never reaches dispose. Capture runs this before the stores flush their pending
		// saves on the same event, so the mode put back here is among them.
		const releaseMic = (event: PageTransitionEvent) => {
			if (!event.persisted) this.micGuard.releaseForUnload();
		};
		window.addEventListener('pagehide', releaseMic, {capture: true});
		// Until the leader shows my seat loaded, the report goes again every few seconds: a lost message or a new leader
		// would otherwise leave me 'downloading' with the song on disk.
		const resendLoaded = setInterval(() => {
			const state = this.state;
			const seat = this.mySeat;
			if (state?.phase === 'select' && seat && seat.loaded !== true && this.songLoaded) {
				this.send({t: 'band.loaded', songId: state.songId});
			}
		}, LOADED_RESEND_MS);
		this.disposers.push(
			() => clearInterval(resendLoaded),
			() => window.removeEventListener('pagehide', releaseMic, {capture: true}),
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
			// The leader holds the song until every seat has its package. Sent whenever my seat does not show it yet, so a
			// seat taken after watching, or one under a new leader, reports again. Only with a seat: the leader drops it
			// otherwise, and a package already on disk would never report again once I sit down.
			reaction(
				() => {
					const state = this.state;
					const seat = this.mySeat;
					if (state?.phase !== 'select' || !seat || seat.loaded === true || !this.songLoaded) return null;
					return `${state.songId}:${seat.part}`;
				},
				(key) => {
					const state = this.state;
					if (key && state?.phase === 'select') this.send({t: 'band.loaded', songId: state.songId});
				},
				{fireImmediately: true},
			),
			// My freestyle choice follows me onto every seat that can take it; the leader keeps it on the seat.
			reaction(
				() => {
					const seat = this.mySeat;
					if (this.state?.phase !== 'select' || !seat || !isFreestylePart(seat.part)) return null;
					return (seat.freestyleSolo === true) === this.freestyleSolo ? null : this.freestyleSolo;
				},
				(enabled) => {
					if (enabled !== null) this.send({t: 'band.freestyleSolo', enabled});
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
			// Switched during the countdown and back at the song's end; never in between.
			reaction(
				() => {
					const state = this.state;
					return state?.phase === 'play' && this.mySeat?.part === 'vocals' ? state.startAt : null;
				},
				(startAt) => this.singerMic.update(startAt),
				{fireImmediately: true},
			),
			// Every client knows the seats, so each one stops levelling the singer for the song.
			reaction(
				() => {
					const state = this.state;
					if (state?.phase !== 'play') return [];
					return state.seats.filter((seat) => seat.part === 'vocals').map((seat) => seat.userId);
				},
				(userIds) => this.voicePort.setUnlevelledVoices(userIds),
				{fireImmediately: true, equals: compareStructural},
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

// The room for this session, created on first use. The real call session ends when the store lets go of it, and my
// room ends when I leave the activity (joining again starts a fresh one); a session that never goes through the store
// (the local harness) lives until another session takes its place.
export function getBandRoom(session: ActivitySession): BandRoom {
	if (current?.session === session) return current;
	current?.dispose();
	disposeLiveWatch?.();
	const room = new BandRoom(session);
	current = room;
	const wasLive = VoiceActivities.live === session;
	disposeLiveWatch = reaction(
		() => (wasLive ? VoiceActivities.live === session && session.joined : true),
		(stillMine) => {
			if (stillMine) return;
			room.dispose();
			disposeLiveWatch?.();
			disposeLiveWatch = null;
			if (current === room) current = null;
		},
	);
	return room;
}

// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandIntent, BandSongSummary, BandState} from '@app/features/activities/band/BandProtocol';
import {
	performanceToContextTime,
	scheduleSongStart,
	songTimeMs,
} from '@app/features/activities/band/engine/SessionClock';
import type {SongPackage} from '@app/features/activities/band/engine/SongPackage';
import {BandAudio, GUIDE_VOCAL_GAIN} from '@app/features/activities/band/game/BandAudio';
import {inputSongTimeMs, type LaneInput, type WhammyKeyInput} from '@app/features/activities/band/game/BandInput';
import type {DuckDepth} from '@app/features/activities/band/game/BandSettings';
import {FreestyleAudio} from '@app/features/activities/band/game/FreestyleAudio';
import {MissSound} from '@app/features/activities/band/game/MissSound';
import {PlayController} from '@app/features/activities/band/game/PlayController';
import {isWhammyPart} from '@app/features/activities/band/game/Whammy';
import {isJamMessage} from '@app/features/activities/band/jam/JamMessages';
import type {ActivityMessage, ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';
import {Logger} from '@app/features/platform/utils/AppLogger';

const logger = new Logger('BandPlayRuntime');

export type BandPlayState = Extract<BandState, {phase: 'play'}>;

// The song keeps running this long past its last note before results go out.
const SONG_TAIL_MS = 1_500;

export class BandAudioUnavailableError extends Error {
	constructor() {
		super('No AudioContext for band playback');
		this.name = 'BandAudioUnavailableError';
	}
}

export interface PlayRuntimeOptions {
	readonly session: ActivitySession;
	readonly state: BandPlayState;
	readonly entry: BandSongSummary;
	readonly songPackage: SongPackage;
	readonly inputLatencyMs: () => number;
	readonly missSound: () => boolean;
	readonly duckDepth: () => DuckDepth;
	readonly submitIntent: (intent: BandIntent) => void;
}

// Everything one song needs outside React: decoded audio started on the shared clock, the controller, freestyle
// solos and whammy on that audio, the conversions from the audio clock to song time, and routing my keys.
export class PlayRuntime {
	private readonly unsubscribe: () => void;
	// Loads after the song has started (the samples are only needed once a solo comes), and stays null if they fail:
	// the solo then scores without sound.
	private freestyle: FreestyleAudio | null = null;
	// The whammy key went down inside my solo, so its release ends a bend, wherever the song is by then.
	private bending = false;
	private disposed = false;

	private constructor(
		readonly controller: PlayController,
		readonly audio: BandAudio,
		private readonly songZeroContextTime: number,
		private readonly options: PlayRuntimeOptions,
	) {
		this.unsubscribe = options.session.onMessage((message) => this.receive(message));
	}

	static async start(options: PlayRuntimeOptions): Promise<PlayRuntime> {
		const {session, state, entry, songPackage} = options;
		const audio = BandAudio.create();
		if (!audio) throw new BandAudioUnavailableError();
		try {
			const missSound = new MissSound(audio.context, audio.output, options.missSound);
			// Joining the call was a user gesture, but the shared context can still be suspended (autoplay policy).
			await Promise.all([
				audio.loadStems(songPackage.stems, entry.stems),
				missSound.load(),
				audio.context.resume().catch(() => {}),
			]);
			const chart = songPackage.chart();
			// A seated singer sings live in voice chat; their recorded vocals drop to a guide underneath them.
			audio.setPartLevel('vocals', state.seats.some((seat) => seat.part === 'vocals') ? GUIDE_VOCAL_GAIN : 1);

			const anchor = audio.readAnchor();
			const schedule = scheduleSongStart(
				state.startAt,
				session.clock.offsetMs,
				anchor,
				audio.minStartLeadSeconds(anchor),
			);

			let runtime: PlayRuntime | null = null;
			const chartEndMs = Math.max(chart.durationMs, chart.bigRockEnding?.endMs ?? 0);
			const controller = new PlayController({
				chart,
				seats: state.seats,
				myUserId: session.me.userId,
				songEndMs: Math.max(chartEndMs + SONG_TAIL_MS, entry.lengthMs),
				joinedAtMs: schedule.offsetSeconds * 1000,
				bigRockEnding: state.bigRockEnding !== false,
				send: (payload, sendOptions) => void session.send(payload, sendOptions),
				submitIntent: options.submitIntent,
				duck: (part) => audio.duck(part, options.duckDepth()),
				restore: (part) => audio.restore(part),
				playMissSound: (part) => missSound.play(part),
				whammy: (part, modulation) => audio.setWhammy(part, modulation),
				freestyleEnded: () => runtime?.freestyle?.releaseAll(performance.now()),
			});
			// Both change how stems are routed, so they go in before the first sample plays.
			for (const track of controller.tracks) {
				if (isWhammyPart(track.part)) audio.enableWhammy(track.part);
				const songZero = schedule.songZeroContextTime;
				audio.scheduleFreestyleSolos(
					track.part,
					track.freestyle.map((section) => ({
						startTime: songZero + section.startMs / 1000,
						endTime: songZero + section.endMs / 1000,
					})),
				);
			}
			audio.start(schedule);
			runtime = new PlayRuntime(controller, audio, schedule.songZeroContextTime, options);
			runtime.loadFreestyle();
			return runtime;
		} catch (error) {
			audio.dispose();
			throw error;
		}
	}

	// Song position of the audio coming out of the speakers right now.
	heardMs(): number {
		return this.heardMsAt(performance.now());
	}

	// Song position coming out of the speakers at a performance.now() time; for a frame, the time it reaches the
	// screen, so the highway shows what is heard while it is on screen.
	heardMsAt(performanceTime: number): number {
		const anchor = this.audio.readAnchor();
		return songTimeMs(performanceToContextTime(performanceTime, anchor), this.songZeroContextTime, 0);
	}

	// The judge's clock: what was heard, shifted by this device's input latency.
	judgeMs(): number {
		return this.heardMs() - this.options.inputLatencyMs();
	}

	inputMs(eventTimeStamp: number): number {
		return inputSongTimeMs(
			eventTimeStamp,
			this.audio.readAnchor(),
			this.songZeroContextTime,
			this.options.inputLatencyMs(),
		);
	}

	// A key of my highway: in my freestyle solo it plays the solo voice too; the controller scores either way.
	lane({kind, lane, timeStamp}: LaneInput): void {
		const songMs = this.inputMs(timeStamp);
		if (kind === 'press') {
			if (this.controller.mySoloSectionAt(songMs)) this.freestyle?.press(lane, songMs, timeStamp);
			this.controller.press(lane, songMs);
			return;
		}
		this.freestyle?.release(lane, timeStamp);
		this.controller.release(lane, songMs);
	}

	// The whammy key bends in my freestyle solo (Shift: a step and a half) and is the whammy everywhere else.
	whammyKey({kind, timeStamp, shift}: WhammyKeyInput): void {
		const songMs = this.inputMs(timeStamp);
		if (kind === 'press' && this.controller.mySoloSectionAt(songMs)) {
			this.bending = true;
			this.freestyle?.bend(true, shift ? 3 : 2, timeStamp);
			return;
		}
		if (kind === 'release' && this.bending) {
			this.bending = false;
			this.freestyle?.bend(false, 2, timeStamp);
			return;
		}
		this.controller.whammy(kind === 'press', songMs);
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribe();
		this.freestyle?.dispose();
		this.freestyle = null;
		this.audio.dispose();
	}

	private loadFreestyle(): void {
		const seats = this.controller.tracks
			.filter((track) => track.freestyle.length > 0)
			.map((track) => ({userId: track.seat.userId, part: track.part, sections: track.freestyle}));
		if (seats.length === 0) return;
		const {session, entry} = this.options;
		FreestyleAudio.load(this.audio, session.clock, (message) => void session.send(message), {
			songKey: entry.key,
			seats,
			myUserId: session.me.userId,
		}).then(
			(freestyle) => {
				if (this.disposed) freestyle.dispose();
				else this.freestyle = freestyle;
			},
			(error: unknown) => logger.warn('Freestyle solos play without sound', {error}),
		);
	}

	private receive(message: ActivityMessage): void {
		this.controller.receive(message);
		const {freestyle} = this;
		if (!freestyle || !isJamMessage(message.payload)) return;
		const {userId} = message.from;
		const lanes = freestyle.receive(userId, message.payload, this.heardMs(), this.options.session.clock.now());
		this.controller.flashRemoteLanes(userId, lanes);
	}
}

// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandIntent, BandSongSummary, BandState} from '@app/features/activities/band/BandProtocol';
import {
	performanceToContextTime,
	scheduleSongStart,
	songTimeMs,
} from '@app/features/activities/band/engine/SessionClock';
import type {SongPackage} from '@app/features/activities/band/engine/SongPackage';
import {BandAudio} from '@app/features/activities/band/game/BandAudio';
import {inputSongTimeMs} from '@app/features/activities/band/game/BandInput';
import type {DuckDepth} from '@app/features/activities/band/game/BandSettings';
import {FinaleSynth} from '@app/features/activities/band/game/FinaleSynth';
import {MissSound} from '@app/features/activities/band/game/MissSound';
import {PlayController} from '@app/features/activities/band/game/PlayController';
import type {ActivitySession} from '@app/features/activities/session/ActivitySessionTypes';

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

// Everything one song needs outside React: decoded audio started on the shared clock, the controller, and the
// conversions from the audio clock to song time.
export class PlayRuntime {
	private readonly unsubscribe: () => void;

	private constructor(
		readonly controller: PlayController,
		readonly audio: BandAudio,
		private readonly songZeroContextTime: number,
		private readonly options: PlayRuntimeOptions,
	) {
		this.unsubscribe = options.session.onMessage(controller.receive);
	}

	static async start(options: PlayRuntimeOptions): Promise<PlayRuntime> {
		const {session, state, entry, songPackage} = options;
		const audio = BandAudio.create();
		if (!audio) throw new BandAudioUnavailableError();
		try {
			// Joining the call was a user gesture, but the shared context can still be suspended (autoplay policy).
			await Promise.all([audio.loadStems(songPackage.stems, entry.stems), audio.context.resume().catch(() => {})]);
			const chart = songPackage.chart();
			// A seated singer sings live in voice chat; their recorded vocals would double them.
			audio.setPartMuted(
				'vocals',
				state.seats.some((seat) => seat.part === 'vocals'),
			);

			const anchor = audio.readAnchor();
			const schedule = scheduleSongStart(
				state.startAt,
				session.clock.offsetMs,
				anchor,
				audio.minStartLeadSeconds(anchor),
			);
			audio.start(schedule);

			const synth = new FinaleSynth(audio.context, audio.output);
			const missSound = new MissSound(audio.context, audio.output);
			const chartEndMs = Math.max(chart.durationMs, chart.bigRockEnding?.endMs ?? 0);
			const controller = new PlayController({
				chart,
				seats: state.seats,
				myUserId: session.me.userId,
				songEndMs: Math.max(chartEndMs + SONG_TAIL_MS, entry.lengthMs),
				joinedAtMs: schedule.offsetSeconds * 1000,
				send: (payload, sendOptions) => void session.send(payload, sendOptions),
				submitIntent: options.submitIntent,
				duck: (part) => audio.duck(part, options.duckDepth()),
				playMissSound: (part) => {
					if (options.missSound()) missSound.play(part);
				},
				playFinaleNote: (part, lane, mine) => synth.play(part, lane, mine),
			});
			return new PlayRuntime(controller, audio, schedule.songZeroContextTime, options);
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

	dispose(): void {
		this.unsubscribe();
		this.audio.dispose();
	}
}

// SPDX-License-Identifier: AGPL-3.0-or-later

// Owns one harness run: the fake session, its bots and the log the control panel shows. Restart throws the session
// away (the View remounts on the new session id) and brings the same bots back.

import {BAND_ACTIVITY} from '@app/features/activities/band/BandActivity';
import {type BandBotSettings, BandBots} from '@app/features/activities/band/dev/BandBots';
import {BandDevSongs} from '@app/features/activities/band/dev/BandDevSongs';
import {FakeActivitySession} from '@app/features/activities/band/dev/FakeActivitySession';
import {getBandRoom} from '@app/features/activities/band/flow/BandRoom';
import type {ActivityMessage} from '@app/features/activities/session/ActivitySessionTypes';
import Users from '@app/features/user/state/Users';
import {action, makeObservable, observableRef, reaction} from 'mobx';

export const MY_USER_ID = '900000000000000001';
const MY_NAME = 'Sen';
export const MAX_BOTS = 3;
const LOG_LIMIT = 40;

export interface BandDevLogEntry {
	readonly key: string;
	readonly at: number;
	readonly from: string;
	readonly text: string;
}

function describePayload(payload: unknown): {readonly kind: string; readonly text: string} {
	if (typeof payload !== 'object' || payload === null) return {kind: 'unknown', text: JSON.stringify(payload)};
	const {t, ...rest} = payload as {t?: unknown};
	return {kind: typeof t === 'string' ? t : 'unknown', text: `${String(t)} ${JSON.stringify(rest)}`};
}

function cacheUser(id: string, name: string): void {
	Users.cacheUsers([
		{id, username: name, discriminator: '0000', global_name: name, avatar: null, avatar_color: null, flags: 0},
	]);
}

export class BandDevHarness {
	session: FakeActivitySession;
	bots: BandBots;
	log: ReadonlyArray<BandDevLogEntry> = [];
	hitCounts: Readonly<Record<string, number>> = {};
	readonly songs: BandDevSongs;
	private detach: () => void = () => {};
	private logSeq = 0;

	constructor(songServerUrl: string) {
		this.songs = new BandDevSongs(songServerUrl);
		cacheUser(MY_USER_ID, MY_NAME);
		this.session = this.createSession();
		this.bots = this.createBots(this.session);
		makeObservable<BandDevHarness, 'record' | 'countHit'>(this, {
			session: observableRef,
			bots: observableRef,
			log: observableRef,
			hitCounts: observableRef,
			restart: action,
			record: action,
			countHit: action,
		});
		this.attach();
		void this.songs.load();
	}

	addBot(settings: Partial<BandBotSettings>): void {
		if (this.bots.bots.length >= MAX_BOTS) return;
		this.bots.add(settings);
	}

	restart(): void {
		const kept = this.bots.bots.map((bot) => bot.settings);
		const network = {latencyMs: this.session.latencyMs, lossyDropRate: this.session.lossyDropRate};
		this.detach();
		this.bots.clear();
		this.session.dispose();
		this.session = this.createSession();
		this.session.setNetwork(network);
		this.bots = this.createBots(this.session);
		for (const settings of kept) this.bots.add(settings);
		this.log = [];
		this.hitCounts = {};
		this.attach();
	}

	nameOf(userId: string): string {
		if (userId === MY_USER_ID) return MY_NAME;
		return this.bots.nameOf(userId) ?? userId;
	}

	dispose(): void {
		this.detach();
		this.bots.clear();
		this.session.dispose();
	}

	// The room (leader controller, library, crowd) starts here rather than on the View's first render, so its first
	// state broadcast does not land in the middle of a React render.
	private createSession(): FakeActivitySession {
		const session = new FakeActivitySession({activityId: BAND_ACTIVITY.id, myUserId: MY_USER_ID});
		getBandRoom(session);
		return session;
	}

	private createBots(session: FakeActivitySession): BandBots {
		return new BandBots({session, songs: () => this.songs.songs, chart: this.songs.chart});
	}

	private attach(): void {
		const session = this.session;
		const stopMessages = session.onMessage((message) => this.takeMessage(message));
		const stopState = session.onStateChanged((state) => {
			const phase = typeof state === 'object' && state !== null ? (state as {phase?: unknown}).phase : null;
			this.record('leader', `state v${session.stateVersion} ${String(phase)}`);
		});
		// Bot names reach the game through the user store, like real members' names do.
		const stopNames = reaction(
			() => this.bots.bots.map((bot) => [bot.userId, bot.settings.name] as const),
			(entries) => {
				for (const [id, name] of entries) cacheUser(id, name);
			},
			{fireImmediately: true},
		);
		this.detach = () => {
			stopMessages();
			stopState();
			stopNames();
		};
	}

	private takeMessage(message: ActivityMessage): void {
		const {kind, text} = describePayload(message.payload);
		if (kind === 'band.hit') {
			this.countHit(message.from.userId);
			return;
		}
		this.record(this.nameOf(message.from.userId), text);
	}

	private countHit(userId: string): void {
		this.hitCounts = {...this.hitCounts, [userId]: (this.hitCounts[userId] ?? 0) + 1};
	}

	private record(from: string, text: string): void {
		const entry = {key: String(++this.logSeq), at: this.session.clock.now(), from, text};
		this.log = [entry, ...this.log].slice(0, LOG_LIMIT);
	}
}

// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomBytes} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {
	type GameActivity,
	type GameActivityAddRuleResult,
	type GameActivityCandidatesResult,
	type GameActivityConfigureRequest,
	type GameActivityConfigureResult,
	type GameActivityIdentity,
	type GameActivityLocalRule,
	type GameActivityRulesResult,
	type GameActivityState,
	isGameActivityIdentity,
	isGameActivityLocalRule,
	isGameActivityPlatformSupported,
} from '@electron/common/GameActivityTypes';
import {
	formatListeningName,
	listDarwinProcesses,
	listLinuxProcesses,
	type NowPlaying,
	readSpotifyNowPlaying,
	spotifyProcessName,
} from '@electron/main/GameActivityProbes';
import {loadWinShell} from '@electron/main/WinShell';
import {getGameById, matchGameByExe, matchGameByProcess} from '@fluxer/game_catalog/src/GameCatalog';

const MAX_PROCESSES = 20_000;
const POLL_INTERVAL_MS = 15_000;
const FRESHNESS_MS = 60_000;
const TOKEN_LIFETIME_MS = 30_000;
const PAGE_SIZE = 100;
const MAX_RULES = 50;
// After missing playerctl or a denied macOS Automation prompt, Spotify is asked again only this rarely.
const SPOTIFY_RETRY_MS = 10 * 60_000;
const UNSUITABLE_EXE =
	/^(?:javaw?|python(?:w|\d+)?|node|electron|launcher|patcher|updater|easyanticheat(?:_eos)?|beservice)\.exe$|(?:launcher|patcher|anticheat)\.exe$/i;

interface ProcessEntry {
	exe: string;
	pid: number;
}

interface CatalogMatch {
	id: string;
	name: string;
}

export interface GameActivityDetectionDependencies {
	platform: NodeJS.Platform;
	onState: (state: GameActivityState) => void;
	listProcesses: () => Promise<Array<ProcessEntry>>;
	now: () => number;
	monotonicNow: () => number;
	setInterval: (callback: () => void, delay: number) => ReturnType<typeof setInterval>;
	clearInterval: (timer: ReturnType<typeof setInterval>) => void;
	getRules: (accountId: string) => Array<GameActivityLocalRule>;
	setRules: (accountId: string, rules: Array<GameActivityLocalRule>) => void;
	matchGameByExe: (exe: string) => CatalogMatch | undefined;
	getGameById: (id: string) => CatalogMatch | undefined;
	createToken: () => string;
	// Asked at most once per poll, only while a Spotify process runs and no game is detected.
	readNowPlaying: () => Promise<NowPlaying | null>;
}

function validateSnapshot(value: unknown): Array<ProcessEntry> {
	if (!Array.isArray(value) || value.length > MAX_PROCESSES) throw new Error('Process limit');
	return value.map((entry) => {
		if (
			!entry ||
			typeof entry.exe !== 'string' ||
			entry.exe.length === 0 ||
			entry.exe.length > 260 ||
			/[\\/\p{Cc}\p{Cf}]/u.test(entry.exe) ||
			!Number.isSafeInteger(entry.pid) ||
			entry.pid < 0
		) {
			throw new Error('Invalid process entry');
		}
		return {exe: entry.exe.toLowerCase(), pid: entry.pid};
	});
}

function identityKey(identity: GameActivityIdentity): string {
	return 'game_id' in identity ? `game:${identity.game_id}` : `manual:${identity.manual_name}`;
}

function publicRule(rule: GameActivityLocalRule): GameActivityIdentity & {rule_id: string} {
	return 'game_id' in rule
		? {rule_id: rule.rule_id, game_id: rule.game_id}
		: {rule_id: rule.rule_id, manual_name: rule.manual_name};
}

export class GameActivityDetection {
	private readonly dependencies: GameActivityDetectionDependencies;
	private accountId: string | null = null;
	private generation = 0;
	private epoch = 0;
	private enabled = false;
	private spotify = false;
	private spotifyRetryAt: number | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private inFlight: {epoch: number; promise: Promise<void>} | null = null;
	private snapshot: Array<ProcessEntry> | null = null;
	private lastSuccess: number | null = null;
	private previousActivity: GameActivity | null = null;
	private rules: Array<GameActivityLocalRule> = [];
	private tokens = new Map<string, {process: ProcessEntry; expires: number; epoch: number}>();
	private cursors = new Map<string, {offset: number; expires: number; epoch: number}>();
	private state: GameActivityState;

	public constructor(dependencies: Partial<GameActivityDetectionDependencies> = {}) {
		const platform = dependencies.platform ?? process.platform;
		this.dependencies = {
			platform,
			onState: () => {},
			listProcesses: async () => {
				const epoch = this.epoch;
				if (platform === 'darwin' || platform === 'linux') {
					if (!this.enabled || epoch !== this.epoch) throw new Error('Process query cancelled');
					return platform === 'darwin' ? listDarwinProcesses() : listLinuxProcesses();
				}
				const binding = await Promise.resolve(loadWinShell());
				if (!this.enabled || epoch !== this.epoch) throw new Error('Process query cancelled');
				if (!binding?.listProcesses) throw new Error('Windows process query unavailable');
				return binding.listProcesses();
			},
			now: Date.now,
			monotonicNow: () => performance.now(),
			setInterval,
			clearInterval,
			getRules: () => [],
			setRules: () => {},
			matchGameByExe: platform === 'win32' ? matchGameByExe : (exe) => matchGameByProcess(exe, platform),
			getGameById,
			createToken: () => randomBytes(24).toString('hex'),
			readNowPlaying: () => readSpotifyNowPlaying(platform),
			...dependencies,
		};
		this.state = {generation: 0, state: this.supported ? 'disabled' : 'unsupported', activity: null, fresh: false};
	}

	private get supported(): boolean {
		return isGameActivityPlatformSupported(this.dependencies.platform);
	}

	public configure(request: GameActivityConfigureRequest): GameActivityConfigureResult {
		void this.stop();
		this.generation = request.generation;
		this.accountId = request.account_id;
		this.enabled = this.supported && request.enabled && request.account_id !== null;
		this.spotify = this.enabled && request.spotify === true;
		this.rules = this.accountId
			? this.dependencies.getRules(this.accountId).filter(isGameActivityLocalRule).slice(0, MAX_RULES)
			: [];
		this.publish(this.supported ? (this.enabled ? 'unavailable' : 'disabled') : 'unsupported', null, false);
		if (this.enabled) {
			this.timer = this.dependencies.setInterval(() => {
				void this.poll();
			}, POLL_INTERVAL_MS);
			this.timer.unref?.();
			void this.poll();
		}
		return {state: this.supported ? 'ok' : 'unsupported'};
	}

	public getState(): GameActivityState {
		this.expireActivity();
		return {...this.state, activity: this.state.activity ? {...this.state.activity} : null};
	}

	public stop(): Promise<void> {
		const completion = this.inFlight?.promise ?? Promise.resolve();
		this.epoch++;
		this.enabled = false;
		this.spotify = false;
		if (this.timer !== null) this.dependencies.clearInterval(this.timer);
		this.timer = null;
		this.accountId = null;
		this.snapshot = null;
		this.lastSuccess = null;
		this.previousActivity = null;
		this.rules = [];
		this.tokens.clear();
		this.cursors.clear();
		this.publish(this.supported ? 'disabled' : 'unsupported', null, false);
		return completion;
	}

	public poll(): Promise<void> {
		if (!this.enabled) return Promise.resolve();
		this.expireActivity();
		if (this.inFlight) return this.inFlight.promise;
		const epoch = this.epoch;
		let complete: () => void = () => {};
		const job = {
			epoch,
			promise: new Promise<void>((resolve) => {
				complete = resolve;
			}),
		};
		this.inFlight = job;
		const receive = (error: unknown, processes: unknown, listening: GameActivityIdentity | null): void => {
			try {
				if (epoch !== this.epoch || !this.enabled) return;
				this.expireActivity();
				this.tokens.clear();
				this.cursors.clear();
				if (error) throw error;
				const snapshot = validateSnapshot(processes);
				this.snapshot = snapshot;
				this.lastSuccess = this.dependencies.monotonicNow();
				const selected = this.select(snapshot) ?? (this.spotify ? listening : null);
				if (!selected) this.previousActivity = null;
				else if (!this.previousActivity || identityKey(selected) !== identityKey(this.previousActivity)) {
					const startedAt = this.dependencies.now();
					if (!Number.isSafeInteger(startedAt)) throw new Error('Clock unavailable');
					this.previousActivity = {...selected, started_at: startedAt};
				}
				this.publish(selected ? 'playing' : 'idle', this.previousActivity, true);
			} catch {
				this.snapshot = null;
				this.publish('unavailable', null, false);
			} finally {
				if (this.inFlight === job) this.inFlight = null;
				complete();
				if (this.enabled && epoch !== this.epoch) void this.poll();
			}
		};
		try {
			void this.dependencies.listProcesses().then(
				(processes) => this.listening(processes, epoch).then((listening) => receive(null, processes, listening)),
				(error) => receive(error, null, null),
			);
		} catch {
			receive(new Error('Process query unavailable'), null, null);
		}
		return job.promise;
	}

	public listCandidates(cursor?: string): GameActivityCandidatesResult {
		if (!this.supported) return {state: 'unsupported'};
		this.expireActivity();
		if (!this.enabled || !this.snapshot || !this.state.fresh) return {state: 'unavailable'};
		const now = this.dependencies.monotonicNow();
		this.pruneTokens(now);
		if (!cursor) {
			this.tokens.clear();
			this.cursors.clear();
		}
		const page = cursor ? this.cursors.get(cursor) : {offset: 0, expires: now + TOKEN_LIFETIME_MS, epoch: this.epoch};
		if (!page || page.epoch !== this.epoch || page.expires <= now) return {state: 'unavailable'};
		if (cursor) this.cursors.delete(cursor);
		const candidates = this.snapshot.slice(page.offset, page.offset + PAGE_SIZE).map((entry, index) => {
			if (this.tokens.size >= MAX_PROCESSES) this.tokens.delete(this.tokens.keys().next().value!);
			const token = this.dependencies.createToken();
			this.tokens.set(token, {process: entry, epoch: this.epoch, expires: now + TOKEN_LIFETIME_MS});
			const name = this.dependencies.matchGameByExe(entry.exe)?.name;
			return {
				token,
				label: name && isGameActivityIdentity({manual_name: name}) ? name : `Application ${page.offset + index + 1}`,
			};
		});
		if (page.offset + PAGE_SIZE >= this.snapshot.length) return {state: 'ok', candidates};
		const nextCursor = this.dependencies.createToken();
		this.cursors.set(nextCursor, {...page, offset: page.offset + PAGE_SIZE});
		return {state: 'ok', candidates, next_cursor: nextCursor};
	}

	public async addRule(token: string, selection: GameActivityIdentity): Promise<GameActivityAddRuleResult> {
		if (!this.supported) return {state: 'unsupported'};
		this.pruneTokens(this.dependencies.monotonicNow());
		const candidate = this.tokens.get(token);
		this.tokens.delete(token);
		if (
			!this.enabled ||
			!candidate ||
			candidate.epoch !== this.epoch ||
			!isGameActivityIdentity(selection) ||
			this.rules.length >= MAX_RULES
		) {
			return {state: 'unavailable'};
		}
		// A process name and PID have no birth identity to safely confirm this selection.
		return {state: 'unavailable'};
	}

	public listRules(): GameActivityRulesResult {
		return this.supported ? {state: 'ok', rules: this.rules.map(publicRule)} : {state: 'unsupported'};
	}

	public removeRule(ruleId: string): GameActivityConfigureResult {
		if (!this.supported) return {state: 'unsupported'};
		if (this.accountId) {
			this.rules = this.rules.filter((rule) => rule.rule_id !== ruleId);
			this.dependencies.setRules(this.accountId, this.rules);
			this.tokens.clear();
			this.cursors.clear();
			if (this.enabled) void this.poll();
		}
		return {state: 'ok'};
	}

	// Spotify now playing as a manual_name, only when no game or local rule matches this snapshot.
	private async listening(processes: unknown, epoch: number): Promise<GameActivityIdentity | null> {
		const spotifyProcess = spotifyProcessName(this.dependencies.platform);
		if (!this.spotify || !spotifyProcess || epoch !== this.epoch) return null;
		if (this.spotifyRetryAt !== null && this.dependencies.monotonicNow() < this.spotifyRetryAt) return null;
		try {
			const snapshot = validateSnapshot(processes);
			if (!snapshot.some((entry) => entry.exe === spotifyProcess) || this.select(snapshot)) return null;
			const playing = await this.dependencies.readNowPlaying();
			if (!playing || epoch !== this.epoch || !this.spotify) return null;
			this.spotifyRetryAt = null;
			const identity = {manual_name: formatListeningName(playing)};
			return identity.manual_name && isGameActivityIdentity(identity) ? {manual_name: identity.manual_name} : null;
		} catch (error) {
			if ((error as Error | null)?.name === 'SpotifyProbeUnavailable')
				this.spotifyRetryAt = this.dependencies.monotonicNow() + SPOTIFY_RETRY_MS;
			return null;
		}
	}

	private select(snapshot: Array<ProcessEntry>): GameActivityIdentity | null {
		const running = new Map<string, number>();
		for (const entry of snapshot) running.set(entry.exe, (running.get(entry.exe) ?? 0) + 1);
		for (const rule of this.rules) {
			if (running.get(rule.exe) !== 1 || ('game_id' in rule && !this.dependencies.getGameById(rule.game_id))) continue;
			return 'game_id' in rule ? {game_id: rule.game_id} : {manual_name: rule.manual_name};
		}
		const games = new Set<string>();
		for (const exe of running.keys()) {
			if (UNSUITABLE_EXE.test(exe)) continue;
			const game = this.dependencies.matchGameByExe(exe);
			if (game && isGameActivityIdentity({game_id: game.id})) games.add(game.id);
		}
		if (this.previousActivity && 'game_id' in this.previousActivity && games.has(this.previousActivity.game_id)) {
			return {game_id: this.previousActivity.game_id};
		}
		const first = [...games].sort()[0];
		return first ? {game_id: first} : null;
	}

	private expireActivity(): void {
		if (this.lastSuccess === null || this.dependencies.monotonicNow() - this.lastSuccess < FRESHNESS_MS) return;
		this.snapshot = null;
		this.previousActivity = null;
		this.lastSuccess = null;
		this.tokens.clear();
		this.cursors.clear();
		this.publish('unavailable', null, false);
	}

	private pruneTokens(now: number): void {
		for (const [token, candidate] of this.tokens) if (candidate.expires <= now) this.tokens.delete(token);
		for (const [cursor, page] of this.cursors) if (page.expires <= now) this.cursors.delete(cursor);
	}

	private publish(state: GameActivityState['state'], activity: GameActivity | null, fresh: boolean): void {
		this.state = {generation: this.generation, state, activity: activity ? {...activity} : null, fresh};
		this.dependencies.onState(this.getStateWithoutExpiry());
	}

	private getStateWithoutExpiry(): GameActivityState {
		return {...this.state, activity: this.state.activity ? {...this.state.activity} : null};
	}
}

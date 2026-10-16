// SPDX-License-Identifier: AGPL-3.0-or-later

import GameActivityStore from '@app/features/game_activity/state/GameActivityStore';
import type {GameActivity} from '@app/features/gateway/types/GatewayPresenceTypes';
import type {GatewayCustomStatusPayload} from '@app/features/user/state/CustomStatus';
import type {
	DesktopGameActivityCandidates,
	DesktopGameActivityRuleInput,
	DesktopGameActivityRules,
	DesktopGameActivityState,
	ElectronAPI,
} from '@app/types/electron.d';
import {makeObservable, observable, observableRef, runInAction} from 'mobx';

export interface GameActivityPresence {
	status: string;
	afk?: boolean;
	mobile?: boolean;
	custom_status?: GatewayCustomStatusPayload | null;
}

interface ProducerOptions {
	getPresence: () => GameActivityPresence | null;
	send: (presence: GameActivityPresence & {game_activity: GameActivity | null}) => boolean;
	onClear?: () => void;
}

export class GameActivityProducer {
	private enabled = false;
	private current: GameActivity | null = null;
	private sent: GameActivity | null = null;
	private pendingSince: number | null = null;
	private lastSentAt = 0;
	private successfulScans = 0;
	private sentScan = 0;
	private fresh = false;
	private changeTimer: ReturnType<typeof setTimeout> | null = null;
	private expiryTimer: ReturnType<typeof setTimeout> | null = null;
	private renewalTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly options: ProducerOptions) {}

	setEnabled(enabled: boolean): void {
		if (!enabled) this.stop();
		this.enabled = enabled;
	}

	handleState(state: DesktopGameActivityState): void {
		if (!this.enabled) return;
		if (state.state === 'unavailable' || (state.state === 'playing' && !state.fresh)) {
			this.fresh = false;
			this.cancelChange();
			this.cancelRenewal();
			return;
		}
		if (state.state !== 'playing') {
			this.clear();
			return;
		}
		const activity = sanitizeActivity(state.activity);
		if (!activity) {
			this.clear();
			return;
		}
		const presence = this.options.getPresence();
		if (presence && !isVisible(presence)) {
			this.clear();
			return;
		}
		this.fresh = true;
		this.successfulScans += 1;
		if (this.expiryTimer) clearTimeout(this.expiryTimer);
		this.expiryTimer = setTimeout(() => this.clear(), 60000);
		const changed = !sameActivity(activity, this.current);
		this.current = activity;
		if (sameActivity(activity, this.sent)) {
			this.cancelChange();
			this.scheduleRenewal();
			return;
		}
		if (!changed && this.changeTimer) return;
		this.cancelRenewal();
		if (this.pendingSince === null) this.pendingSince = performance.now();
		if (this.changeTimer) clearTimeout(this.changeTimer);
		const delay = Math.min(3000, Math.max(0, this.pendingSince + 15000 - performance.now()));
		this.changeTimer = setTimeout(() => {
			this.changeTimer = null;
			this.pendingSince = null;
			this.publish();
		}, delay);
	}

	stop(): void {
		this.clear();
		this.enabled = false;
	}

	disconnected(): void {
		this.reset();
		this.enabled = false;
	}

	presenceChanged(): void {
		const presence = this.options.getPresence();
		if (!presence || !isVisible(presence)) this.clear();
	}

	private publish(): void {
		if (!this.enabled || !this.fresh || !this.current) return;
		const presence = this.options.getPresence();
		if (!presence) return;
		if (!isVisible(presence)) {
			this.clear();
			return;
		}
		if (!this.options.send({...presence, game_activity: this.current})) return;
		this.sent = this.current;
		this.sentScan = this.successfulScans;
		this.lastSentAt = performance.now();
		this.scheduleRenewal();
	}

	private scheduleRenewal(): void {
		this.cancelRenewal();
		if (!this.sent || !this.fresh) return;
		this.renewalTimer = setTimeout(
			() => {
				this.renewalTimer = null;
				if (this.successfulScans > this.sentScan) this.publish();
			},
			Math.max(0, this.lastSentAt + 60000 - performance.now()),
		);
	}

	private clear(): void {
		const hadActivity = this.current !== null || this.sent !== null;
		this.reset();
		const presence = this.options.getPresence();
		if (hadActivity && presence) this.options.send({...presence, game_activity: null});
	}

	private reset(): void {
		this.cancelChange();
		this.cancelRenewal();
		if (this.expiryTimer) clearTimeout(this.expiryTimer);
		this.expiryTimer = null;
		this.current = null;
		this.sent = null;
		this.fresh = false;
		this.successfulScans = 0;
		this.sentScan = 0;
		this.options.onClear?.();
	}

	private cancelChange(): void {
		if (this.changeTimer) clearTimeout(this.changeTimer);
		this.changeTimer = null;
		this.pendingSince = null;
	}

	private cancelRenewal(): void {
		if (this.renewalTimer) clearTimeout(this.renewalTimer);
		this.renewalTimer = null;
	}
}

type GameActivityApi = Pick<
	ElectronAPI,
	| 'gameActivityGetCapabilities'
	| 'gameActivityConfigure'
	| 'gameActivityGetState'
	| 'gameActivityListCandidates'
	| 'gameActivityAddRule'
	| 'gameActivityListRules'
	| 'gameActivityRemoveRule'
	| 'onGameActivityState'
>;

interface BridgeOptions {
	getApi?: () => unknown;
	getPresence?: ProducerOptions['getPresence'];
	send?: ProducerOptions['send'];
	getEnabled?: () => boolean;
	// Local "show Spotify" choice; it only applies while game activity itself is enabled.
	getSpotifyEnabled?: () => boolean;
	clearReceived?: () => void;
}

interface GameActivityConfiguration {
	api: GameActivityApi;
	generation: number;
	enabled: boolean;
	spotify: boolean;
}

export class DesktopGameActivityBridge {
	supported = false;
	// The desktop shell can read Spotify now playing (older shells reject the configure flag).
	spotifySupported = false;
	activity: GameActivity | null = null;
	private options: BridgeOptions;
	private producer: GameActivityProducer;
	private api: GameActivityApi | null = null;
	private configuration: GameActivityConfiguration | null = null;
	private accountId: string | null = null;
	private generation = 0;
	private enabled = false;
	private spotify = false;
	private stopped = false;
	private unsubscribe: (() => void) | null = null;
	private transition: Promise<void> = Promise.resolve();

	constructor(options: BridgeOptions = {}) {
		this.options = options;
		this.producer = this.createProducer();
		makeObservable(this, {supported: observable, spotifySupported: observable, activity: observableRef});
	}

	initialize(options: BridgeOptions): void {
		this.producer.stop();
		this.options = options;
		this.producer = this.createProducer();
	}

	setAccount(accountId: string | null): Promise<void> {
		if (this.accountId === accountId && this.supported) return this.syncPolicy();
		this.stopped = false;
		this.accountId = accountId;
		return this.restart(true);
	}

	refreshPolicy(): Promise<void> {
		this.stopped = false;
		return this.restart(false);
	}

	syncPolicy(): Promise<void> {
		const enabled = this.shouldEnable();
		const spotify = this.shouldShareSpotify(enabled);
		if (
			this.enabled === enabled &&
			this.spotify === spotify &&
			(!this.configuration || (this.configuration.enabled === enabled && this.configuration.spotify === spotify))
		)
			return this.transition;
		return this.restart(false);
	}

	stopSharing(): Promise<void> {
		this.stopped = true;
		return this.restart(false);
	}

	disconnected(): Promise<void> {
		this.producer.disconnected();
		return this.restart(false, true);
	}

	presenceChanged(): void {
		this.producer.presenceChanged();
		void this.syncPolicy();
	}

	async listCandidates(cursor?: string): Promise<DesktopGameActivityCandidates> {
		if (!GameActivityStore.enabled) return {state: 'unsupported'};
		const generation = this.generation;
		const result = await this.api?.gameActivityListCandidates?.({generation, ...(cursor && {cursor})});
		return generation === this.generation && result ? result : {state: 'unsupported'};
	}

	async listRules(): Promise<DesktopGameActivityRules> {
		if (!GameActivityStore.enabled) return {state: 'unsupported'};
		const generation = this.generation;
		const result = await this.api?.gameActivityListRules?.({generation});
		return generation === this.generation && result ? result : {state: 'unsupported'};
	}

	async addRule(
		rule: DesktopGameActivityRuleInput,
	): Promise<{state: 'ok'; rule_id: string} | {state: 'unsupported' | 'unavailable'}> {
		if (!GameActivityStore.enabled) return {state: 'unsupported'};
		const generation = this.generation;
		const identity = 'game_id' in rule ? {game_id: rule.game_id} : {manual_name: rule.manual_name};
		const result = await this.api?.gameActivityAddRule?.({...identity, token: rule.token, generation});
		return generation === this.generation && result ? result : {state: 'unsupported'};
	}

	async removeRule(rule_id: string): Promise<{state: 'ok' | 'unsupported'}> {
		if (!GameActivityStore.enabled) return {state: 'unsupported'};
		const generation = this.generation;
		const result = await this.api?.gameActivityRemoveRule?.({generation, rule_id});
		return generation === this.generation && result ? result : {state: 'unsupported'};
	}

	private createProducer(): GameActivityProducer {
		return new GameActivityProducer({
			getPresence: () => this.options.getPresence?.() ?? null,
			send: (value) => (GameActivityStore.enabled ? (this.options.send?.(value) ?? false) : false),
			onClear: () =>
				runInAction(() => {
					this.activity = null;
				}),
		});
	}

	private shouldEnable(): boolean {
		const presence = this.options.getPresence?.();
		return (
			GameActivityStore.enabled &&
			!!this.accountId &&
			!this.stopped &&
			!!this.options.send &&
			this.options.getEnabled?.() === true &&
			!!presence &&
			isVisible(presence)
		);
	}

	private shouldShareSpotify(enabled: boolean): boolean {
		return enabled && this.spotifySupported && this.options.getSpotifyEnabled?.() === true;
	}

	private restart(probe: boolean, paused = false): Promise<void> {
		this.producer.stop();
		this.enabled = false;
		this.spotify = false;
		const oldApi = this.configuration?.api ?? this.api;
		const oldGeneration = this.configuration?.generation ?? this.generation;
		const generation = ++this.generation;
		const accountId = this.accountId;
		const stop = this.disable(oldApi, oldGeneration);
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (probe) this.options.clearReceived?.();
		this.api = null;
		runInAction(() => {
			this.activity = null;
			if (probe) {
				this.supported = false;
				this.spotifySupported = false;
			}
		});
		this.transition = this.transition.then(async () => {
			let configuration: GameActivityConfiguration | null = null;
			try {
				if (!(await stop) || (this.configuration && !(await this.releaseConfiguration(this.configuration)))) {
					if (generation === this.generation)
						runInAction(() => {
							this.supported = false;
						});
					return;
				}
				if (generation !== this.generation || !accountId || paused || !this.options.send) return;
				const api = getGameActivityApi(this.options.getApi?.());
				if (!api?.gameActivityGetCapabilities || !api.gameActivityConfigure || !api.onGameActivityState) return;
				const capability = await api.gameActivityGetCapabilities();
				if (generation !== this.generation || capability.version !== 1 || !capability.supported) return;
				const spotifySupported = capability.spotify === true;
				runInAction(() => {
					this.spotifySupported = spotifySupported;
				});
				const enabled = this.shouldEnable();
				const spotify = this.shouldShareSpotify(enabled);
				configuration = {api, generation, enabled, spotify};
				this.configuration = configuration;
				const result = await api.gameActivityConfigure({
					account_id: accountId,
					generation,
					enabled,
					...(spotifySupported ? {spotify} : {}),
				});
				if (generation !== this.generation || result.state !== 'ok') {
					await this.releaseConfiguration(configuration);
					return;
				}
				this.api = api;
				this.enabled = enabled;
				this.spotify = spotify;
				runInAction(() => {
					this.supported = true;
				});
				this.producer.setEnabled(enabled);
				if (!enabled) return;
				let events = 0;
				const handleState = (state: DesktopGameActivityState): void => {
					if (
						!GameActivityStore.enabled ||
						generation !== this.generation ||
						accountId !== this.accountId ||
						state.generation !== generation ||
						!this.enabled
					)
						return;
					this.producer.handleState(state);
					runInAction(() => {
						this.activity = state.state === 'playing' && state.fresh === true ? sanitizeActivity(state.activity) : null;
					});
				};
				this.unsubscribe = api.onGameActivityState((state) => {
					events += 1;
					handleState(state);
				});
				if (enabled && api.gameActivityGetState) {
					const before = events;
					const state = await api.gameActivityGetState({generation});
					if (events === before) handleState(state);
				}
			} catch {
				if (configuration) await this.releaseConfiguration(configuration);
				if (generation === this.generation) {
					this.producer.stop();
					this.enabled = false;
					this.unsubscribe?.();
					this.unsubscribe = null;
					runInAction(() => {
						this.supported = false;
						this.activity = null;
					});
				}
			}
		});
		return this.transition;
	}

	private async releaseConfiguration(configuration: GameActivityConfiguration): Promise<boolean> {
		const stopped = await this.disable(configuration.api, configuration.generation);
		if (stopped && this.configuration === configuration) this.configuration = null;
		return stopped;
	}

	private async disable(api: GameActivityApi | null, generation: number): Promise<boolean> {
		try {
			const result = await api?.gameActivityConfigure?.({account_id: null, generation, enabled: false});
			return !api || result?.state === 'ok';
		} catch {
			return false;
		}
	}
}

function getGameActivityApi(value: unknown): GameActivityApi | null {
	if (!value || typeof value !== 'object') return null;
	const api = value as GameActivityApi;
	return typeof api.gameActivityGetCapabilities === 'function' &&
		typeof api.gameActivityConfigure === 'function' &&
		typeof api.onGameActivityState === 'function'
		? api
		: null;
}

function isVisible(presence: GameActivityPresence): boolean {
	return ['online', 'idle', 'dnd'].includes(presence.status);
}

function sameActivity(left: GameActivity | null, right: GameActivity | null): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function sanitizeActivity(activity: GameActivity | null): GameActivity | null {
	if (!activity || typeof activity !== 'object' || !Number.isSafeInteger(activity.started_at)) return null;
	if (
		'game_id' in activity &&
		!('manual_name' in activity) &&
		typeof activity.game_id === 'string' &&
		/^[a-z0-9][a-z0-9-]{0,47}$/.test(activity.game_id)
	)
		return {game_id: activity.game_id, started_at: activity.started_at};
	if (
		'manual_name' in activity &&
		!('game_id' in activity) &&
		typeof activity.manual_name === 'string' &&
		Array.from(activity.manual_name).length >= 1 &&
		Array.from(activity.manual_name).length <= 64 &&
		new TextEncoder().encode(activity.manual_name).length <= 256 &&
		!/[\p{Cc}\p{Cf}]/u.test(activity.manual_name)
	)
		return {manual_name: activity.manual_name, started_at: activity.started_at};
	return null;
}

export default new DesktopGameActivityBridge();

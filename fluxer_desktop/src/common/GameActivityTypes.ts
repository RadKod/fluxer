// SPDX-License-Identifier: AGPL-3.0-or-later

export type GameActivityIdentity = {game_id: string} | {manual_name: string};
export type GameActivity = GameActivityIdentity & {started_at: number};
export interface GameActivityState {
	generation: number;
	state: 'unsupported' | 'disabled' | 'unavailable' | 'idle' | 'playing';
	activity: GameActivity | null;
	fresh: boolean;
}
export interface GameActivityConfigureRequest {
	account_id: string | null;
	generation: number;
	enabled: boolean;
	// Spotify now playing; sent only when capabilities report `spotify: true`, absent means off.
	spotify?: boolean;
}
export interface GameActivityGenerationRequest {
	generation: number;
}
export interface GameActivityCandidatesRequest extends GameActivityGenerationRequest {
	cursor?: string;
}
export type GameActivityAddRuleRequest = GameActivityGenerationRequest & GameActivityIdentity & {token: string};
export interface GameActivityRemoveRuleRequest extends GameActivityGenerationRequest {
	rule_id: string;
}
export type GameActivityRule = GameActivityIdentity & {rule_id: string};
export type GameActivityLocalRule = GameActivityRule & {exe: string};
export type GameActivityConfigureResult = {state: 'ok' | 'unsupported'};
export type GameActivityCandidatesResult =
	| {state: 'ok'; candidates: Array<{token: string; label: string}>; next_cursor?: string}
	| {state: 'unsupported' | 'unavailable'};
export type GameActivityAddRuleResult = {state: 'ok'; rule_id: string} | {state: 'unsupported' | 'unavailable'};
export type GameActivityRulesResult = {state: 'ok'; rules: Array<GameActivityRule>} | {state: 'unsupported'};
export interface GameActivityCapabilities {
	version: 1;
	supported: boolean;
	spotify?: boolean;
}
export interface GameActivityAPI {
	gameActivityGetCapabilities: () => Promise<GameActivityCapabilities>;
	gameActivityConfigure: (request: GameActivityConfigureRequest) => Promise<GameActivityConfigureResult>;
	gameActivityGetState: (request: GameActivityGenerationRequest) => Promise<GameActivityState>;
	gameActivityListCandidates: (request: GameActivityCandidatesRequest) => Promise<GameActivityCandidatesResult>;
	gameActivityAddRule: (request: GameActivityAddRuleRequest) => Promise<GameActivityAddRuleResult>;
	gameActivityListRules: (request: GameActivityGenerationRequest) => Promise<GameActivityRulesResult>;
	gameActivityRemoveRule: (request: GameActivityRemoveRuleRequest) => Promise<GameActivityConfigureResult>;
	onGameActivityState: (callback: (state: GameActivityState) => void) => () => void;
}

// Platforms where the desktop shell can enumerate processes for game activity.
export function isGameActivityPlatformSupported(platform: string): boolean {
	return platform === 'win32' || platform === 'darwin' || platform === 'linux';
}

// Spotify now playing travels as a manual_name with this prefix; the app shows it as "Listening to Spotify".
export const LISTENING_ACTIVITY_PREFIX = '\u266B ';

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isGameActivityIdentity(value: unknown): value is GameActivityIdentity {
	if (!isRecord(value) || Object.keys(value).length !== 1) return false;
	if ('game_id' in value) {
		return typeof value.game_id === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(value.game_id);
	}
	return (
		typeof value.manual_name === 'string' &&
		value.manual_name.trim().length > 0 &&
		Array.from(value.manual_name).length <= 64 &&
		new TextEncoder().encode(value.manual_name).length <= 256 &&
		!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value.manual_name)
	);
}

export function isGameActivityLocalRule(value: unknown): value is GameActivityLocalRule {
	if (!isRecord(value) || Object.keys(value).length !== 3) return false;
	const {rule_id, exe, ...identity} = value;
	return (
		typeof rule_id === 'string' &&
		/^[a-zA-Z0-9_-]{1,128}$/.test(rule_id) &&
		typeof exe === 'string' &&
		exe === exe.toLowerCase() &&
		exe.length <= 260 &&
		/^[^\\/:*?"<>|\p{Cc}\p{Cf}\p{Cs}]+\.exe$/u.test(exe) &&
		!/(?:^javaw?\.exe$|launcher|patcher|anti.?cheat|^steam\.exe$|^riotclientservices\.exe$)/i.test(exe) &&
		isGameActivityIdentity(identity)
	);
}

export function isGameActivityState(value: unknown): value is GameActivityState {
	if (!isRecord(value) || Object.keys(value).length !== 4) return false;
	if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0) return false;
	if (typeof value.fresh !== 'boolean') return false;
	if (value.state === 'playing') {
		if (!value.fresh || !isRecord(value.activity) || Object.keys(value.activity).length !== 2) return false;
		const {started_at, ...identity} = value.activity;
		return Number.isSafeInteger(started_at) && isGameActivityIdentity(identity);
	}
	if (!['unsupported', 'disabled', 'unavailable', 'idle'].includes(value.state as string)) return false;
	return value.activity === null && (value.state === 'idle' ? value.fresh : !value.fresh);
}

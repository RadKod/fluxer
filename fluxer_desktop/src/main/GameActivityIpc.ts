// SPDX-License-Identifier: AGPL-3.0-or-later

import {getGameActivityRules, setGameActivityRules} from '@electron/common/DesktopConfig';
import {
	type GameActivity,
	type GameActivityCandidatesResult,
	type GameActivityConfigureRequest,
	type GameActivityIdentity,
	type GameActivityRulesResult,
	type GameActivityState,
	isGameActivityIdentity,
	isGameActivityPlatformSupported,
	isGameActivityState,
} from '@electron/common/GameActivityTypes';
import {GameActivityDetection} from '@electron/main/GameActivityDetection';
import {requirePrivilegedRendererDocumentSender} from '@electron/main/PrivilegedRendererDocuments';
import {type BrowserWindow, type IpcMainInvokeEvent, ipcMain, type WebContents, type WebFrameMain} from 'electron';

const CHANNELS = [
	'get-capabilities',
	'configure',
	'get-state',
	'list-candidates',
	'add-rule',
	'list-rules',
	'remove-rule',
] as const;

interface DocumentContext {
	sender: WebContents;
	frame: WebFrameMain;
	processId: number;
	routingId: number;
	generation: number;
	accountId: string | null;
	configurationRevision: number;
	enabled: boolean;
	detector: GameActivityDetection;
	detach: () => void;
}

let context: DocumentContext | null = null;
let getMainWindow: (() => BrowserWindow | null) | null = null;
let teardown: Promise<void> = Promise.resolve();
let registrationRevision = 0;

function stopContext(): void {
	const previous = context;
	context = null;
	previous?.detach();
	if (previous) teardown = Promise.all([teardown, previous.detector.stop()]).then(() => {});
}

function requireMainDocument(event: IpcMainInvokeEvent, channel: string): void {
	requirePrivilegedRendererDocumentSender(event, channel);
	const window = getMainWindow?.();
	if (
		!window ||
		window.isDestroyed() ||
		window.webContents.isDestroyed() ||
		event.sender !== window.webContents ||
		event.senderFrame !== window.webContents.mainFrame
	) {
		throw new Error('Game activity requires the main renderer document');
	}
}

function isCurrentDocument(current: DocumentContext): boolean {
	try {
		requireMainDocument(
			{sender: current.sender, senderFrame: current.frame} as IpcMainInvokeEvent,
			'game-activity:state',
		);
		return current.frame.processId === current.processId && current.frame.routingId === current.routingId;
	} catch {
		return false;
	}
}

function payload(
	value: unknown,
	required: ReadonlyArray<string>,
	optional: ReadonlyArray<string> = [],
): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid game activity payload');
	const record = value as Record<string, unknown>;
	if (
		required.some((key) => !Object.hasOwn(record, key)) ||
		Object.keys(record).some((key) => !required.includes(key) && !optional.includes(key))
	)
		throw new Error('Invalid game activity payload');
	try {
		if (Buffer.byteLength(JSON.stringify(record), 'utf8') > 1024) throw new Error('Payload too large');
	} catch {
		throw new Error('Invalid game activity payload');
	}
	if (!Number.isSafeInteger(record.generation) || (record.generation as number) < 0)
		throw new Error('Invalid game activity payload');
	return record;
}

function isOpaque(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function identity(value: GameActivityIdentity): GameActivityIdentity {
	const result = 'game_id' in value ? {game_id: value.game_id} : {manual_name: value.manual_name};
	if (!isGameActivityIdentity(result)) throw new Error('Invalid game activity identity');
	return result;
}

function publicState(value: GameActivityState): GameActivityState {
	const activity: GameActivity | null =
		value.activity === null ? null : {...identity(value.activity), started_at: value.activity.started_at};
	const result = {generation: value.generation, state: value.state, activity, fresh: value.fresh};
	if (!isGameActivityState(result)) throw new Error('Invalid game activity state');
	return result;
}

function publicCandidates(value: GameActivityCandidatesResult): GameActivityCandidatesResult {
	if (value.state !== 'ok') return {state: value.state};
	return {
		state: 'ok',
		candidates: value.candidates.slice(0, 100).map(({token, label}) => ({token, label})),
		...(value.next_cursor === undefined ? {} : {next_cursor: value.next_cursor}),
	};
}

function publicRules(value: GameActivityRulesResult): GameActivityRulesResult {
	if (value.state !== 'ok') return {state: value.state};
	return {state: 'ok', rules: value.rules.slice(0, 50).map((rule) => ({rule_id: rule.rule_id, ...identity(rule)}))};
}

function requireContext(generation: unknown): DocumentContext {
	if (context && !isCurrentDocument(context)) stopContext();
	if (!context) throw new Error('Game activity is not configured');
	if (generation !== context.generation) throw new Error('Stale game activity generation');
	return context;
}

function createContext(event: IpcMainInvokeEvent): DocumentContext {
	const frame = event.senderFrame!;
	const current: DocumentContext = {
		sender: event.sender,
		frame,
		processId: frame.processId,
		routingId: frame.routingId,
		generation: -1,
		accountId: null,
		configurationRevision: 0,
		enabled: false,
		detector: new GameActivityDetection({
			getRules: getGameActivityRules,
			setRules: setGameActivityRules,
			onState: (state) => {
				if (context !== current) return;
				if (!isCurrentDocument(current)) {
					stopContext();
					return;
				}
				if (state.generation !== current.generation) return;
				current.frame.send('game-activity:state', publicState(state));
			},
		}),
		detach: () => {
			event.sender.removeListener('did-start-navigation', onNavigation);
			event.sender.removeListener('render-process-gone', onStop);
			event.sender.removeListener('destroyed', onStop);
		},
	};
	const onStop = (): void => {
		if (context === current) stopContext();
	};
	const onNavigation = (_event: Electron.Event, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
		if (isMainFrame && !isInPlace) onStop();
	};
	event.sender.on('did-start-navigation', onNavigation);
	event.sender.on('render-process-gone', onStop);
	event.sender.on('destroyed', onStop);
	return current;
}

async function createContextAfterTeardown(event: IpcMainInvokeEvent, channel: string): Promise<DocumentContext> {
	const frame = event.senderFrame!;
	const processId = frame.processId;
	const routingId = frame.routingId;
	const revision = registrationRevision;
	let valid = true;
	const invalidate = (): void => {
		valid = false;
	};
	const onNavigation = (_event: Electron.Event, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
		if (isMainFrame && !isInPlace) invalidate();
	};
	event.sender.on('did-start-navigation', onNavigation);
	event.sender.on('render-process-gone', invalidate);
	event.sender.on('destroyed', invalidate);
	try {
		while (true) {
			const pending = teardown;
			await pending;
			if (!valid || revision !== registrationRevision)
				throw new Error('Game activity document or registration expired');
			requireMainDocument(event, channel);
			if (frame.processId !== processId || frame.routingId !== routingId)
				throw new Error('Game activity document expired');
			if (pending !== teardown) continue;
			if (context && !isCurrentDocument(context)) {
				stopContext();
				continue;
			}
			return (context ??= createContext(event));
		}
	} finally {
		event.sender.removeListener('did-start-navigation', onNavigation);
		event.sender.removeListener('render-process-gone', invalidate);
		event.sender.removeListener('destroyed', invalidate);
	}
}

export function registerGameActivityIpcHandlers(mainWindowGetter: () => BrowserWindow | null): void {
	cleanupGameActivityIpc();
	getMainWindow = mainWindowGetter;
	for (const name of CHANNELS) {
		const channel = `game-activity:${name}`;
		ipcMain.handle(channel, async (event, request: unknown) => {
			requireMainDocument(event, channel);
			if (name === 'get-capabilities') {
				if (request !== undefined) throw new Error('Invalid game activity payload');
				const supported = isGameActivityPlatformSupported(process.platform);
				// `spotify` tells the app this shell accepts the optional `spotify` flag on configure.
				return {version: 1, supported, spotify: supported};
			}
			if (name === 'configure') {
				const value = payload(request, ['account_id', 'generation', 'enabled'], ['spotify']);
				if (
					(value.account_id !== null &&
						(typeof value.account_id !== 'string' || !/^\d{1,32}$/.test(value.account_id))) ||
					typeof value.enabled !== 'boolean' ||
					(value.spotify !== undefined && typeof value.spotify !== 'boolean')
				)
					throw new Error('Invalid game activity payload');
				if (context && !isCurrentDocument(context)) stopContext();
				const current = context ?? (await createContextAfterTeardown(event, channel));
				requireMainDocument(event, channel);
				if (context !== current || !isCurrentDocument(current)) throw new Error('Game activity document expired');
				if (
					(value.generation as number) < current.generation ||
					(value.generation === current.generation &&
						value.account_id !== null &&
						value.account_id !== current.accountId)
				)
					throw new Error('Stale game activity generation');
				if ((value.generation as number) > current.generation) current.accountId = value.account_id as string | null;
				current.generation = value.generation as number;
				current.configurationRevision++;
				current.enabled = value.enabled && value.account_id !== null;
				return current.detector.configure(value as unknown as GameActivityConfigureRequest);
			}
			const required =
				name === 'add-rule'
					? ['generation', 'token']
					: name === 'remove-rule'
						? ['generation', 'rule_id']
						: ['generation'];
			const optional = name === 'list-candidates' ? ['cursor'] : name === 'add-rule' ? ['game_id', 'manual_name'] : [];
			const value = payload(request, required, optional);
			if (name === 'list-candidates' && value.cursor !== undefined && !isOpaque(value.cursor))
				throw new Error('Invalid game activity payload');
			let selection: GameActivityIdentity | null = null;
			if (name === 'add-rule') {
				const candidate =
					Object.hasOwn(value, 'game_id') && Object.hasOwn(value, 'manual_name')
						? null
						: Object.hasOwn(value, 'game_id')
							? {game_id: value.game_id}
							: {manual_name: value.manual_name};
				if (!isOpaque(value.token) || !isGameActivityIdentity(candidate))
					throw new Error('Invalid game activity payload');
				selection = candidate;
			}
			if (name === 'remove-rule' && !isOpaque(value.rule_id)) throw new Error('Invalid game activity payload');
			const current = requireContext(value.generation);
			switch (name) {
				case 'get-state':
					return publicState(current.detector.getState());
				case 'list-candidates':
					if (!current.enabled) throw new Error('Game activity detection is disabled');
					return publicCandidates(current.detector.listCandidates(value.cursor as string | undefined));
				case 'add-rule': {
					if (!current.enabled) throw new Error('Game activity detection is disabled');
					const revision = current.configurationRevision;
					const result = await current.detector.addRule(value.token as string, selection!);
					if (
						context !== current ||
						!isCurrentDocument(current) ||
						value.generation !== current.generation ||
						revision !== current.configurationRevision
					)
						throw new Error('Stale game activity generation');
					return result.state === 'ok' ? {state: 'ok', rule_id: result.rule_id} : {state: result.state};
				}
				case 'list-rules':
					return publicRules(current.detector.listRules());
				case 'remove-rule':
					return current.detector.removeRule(value.rule_id as string);
			}
		});
	}
}

export function cleanupGameActivityIpc(): void {
	registrationRevision++;
	stopContext();
	getMainWindow = null;
	for (const name of CHANNELS) ipcMain.removeHandler(`game-activity:${name}`);
}

// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {URL} from 'node:url';
import type {VoiceState} from '@app/features/gateway/types/GatewayVoiceTypes';
import {Store, type StoreLike, useStoreVersion} from '@app/features/voice/engine/Store';
import {VoiceEngineV2AppStatsHostAdapter} from '@app/features/voice/engine/v2/VoiceEngineV2AppStatsHostAdapter';
import voiceStateAdapter from '@app/features/voice/engine/v2/VoiceEngineV2AppVoiceStateAdapter';
import {parse} from '@babel/parser';
import {transformSync} from 'esbuild';
import type {Room} from 'livekit-client';
import {observer} from 'mobx-react-lite';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';

vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug() {}
		warn() {}
	},
}));
vi.mock('@app/features/voice/engine/VoiceMediaGraphStore', () => ({
	voiceMediaGraphStore: {transition: vi.fn(), nowMs: () => 0},
}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {}}));
vi.mock('@app/features/app/components/dialogs/ConfirmModal', () => ({ConfirmModal: () => null}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({modal: vi.fn(), push: vi.fn()}));
vi.mock('@lingui/core/macro', () => ({msg: (value: unknown) => value}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: () => ''}})}));
const groupedParticipant = vi.hoisted(() => vi.fn((_props: {anySpeaking: boolean}) => null));
vi.mock('@app/features/app/components/layout/GroupedVoiceParticipant', () => ({
	GroupedVoiceParticipant: groupedParticipant,
}));
vi.mock('@app/features/app/components/layout/VoiceParticipantItem', () => ({VoiceParticipantItem: () => null}));
vi.mock('@app/features/app/components/layout/dnd/VoiceParticipantDrop', () => ({
	moveVoiceParticipantToChannel: vi.fn(),
}));
vi.mock('react-dnd', () => ({useDrop: () => [{isOver: false, canDrop: false}, () => {}]}));
vi.mock('@app/features/user/state/Users', async () => {
	const {makeAutoObservable} = await import('mobx');
	// Same observable shape and getUser read as the real store, so missing-key reads are tracked the same way.
	class TestUsers {
		users: Record<string, {id: string}> = {user: {id: 'user'}};
		userCount = 1;
		currentUser = null;
		constructor() {
			makeAutoObservable(this);
		}
		getUser(userId: string) {
			return this.users[userId];
		}
		cacheUser(userId: string) {
			this.users[userId] = {id: userId};
			this.userCount += 1;
		}
		evictUser(userId: string) {
			delete this.users[userId];
			this.userCount -= 1;
		}
	}
	return {default: new TestUsers()};
});
vi.mock('@app/features/voice/state/LocalVoiceState', () => ({
	default: {getSelfMute: () => false, getSelfStream: () => false},
}));
vi.mock('@app/features/voice/utils/VoicePermissionUtils', () => ({isParticipantVoicePermissionMuted: () => false}));
const sort = vi.hoisted(() => vi.fn((entries: Array<unknown>) => entries));
vi.mock('@app/features/voice/components/VoiceParticipantSortUtils', () => ({
	createVoiceParticipantSortSnapshot: () => ({}),
	sortVoiceParticipantItemsWithSnapshot: sort,
}));

class ChangingStore extends Store {
	change(): void {
		this.emitChange();
	}
}

const connection = Object.assign(new ChangingStore(), {
	channelId: null as string | null,
	guildId: null as string | null,
	connected: false,
	connecting: false,
	connectFailed: false,
});
const projection = new ChangingStore();
const otherStateStores = Array.from({length: 6}, () => new ChangingStore());
const voiceStates = {
	first: {user_id: 'user', connection_id: 'first'},
	second: {user_id: 'user', connection_id: 'second'},
};
let speaking = false;
const gatewayVoiceState: VoiceState = {
	guild_id: 'guild',
	channel_id: 'channel',
	user_id: 'user',
	connection_id: 'first',
	mute: false,
	deaf: false,
	self_mute: false,
	self_deaf: false,
	self_video: false,
	self_stream: false,
};
const intervals: Array<() => void> = [];
const stats = new VoiceEngineV2AppStatsHostAdapter({
	now: () => 2000,
	scheduler: {
		setInterval: (callback) => {
			intervals.push(callback);
			return intervals.length;
		},
		clearInterval: vi.fn(),
	},
});
const facadeSource = readFileSync(new URL(/* @vite-ignore */ './MediaEngineFacade.ts', import.meta.url), 'utf8');
const ast = parse(facadeSource, {sourceType: 'module', plugins: ['typescript']});
const declaration = ast.program.body.find(
	(node) => node.type === 'ClassDeclaration' && node.id?.name === 'MediaEngineFacade',
);
if (declaration?.type !== 'ClassDeclaration') throw new Error('MediaEngineFacade class not found');
const methods = declaration.body.body
	.filter(
		(node) =>
			node.type === 'ClassMethod' &&
			node.key.type === 'Identifier' &&
			[
				'initializeEngineStoreSync',
				'statsStore',
				'channelId',
				'guildId',
				'connected',
				'connecting',
				'connectFailed',
			].includes(node.key.name),
	)
	.map((node) => facadeSource.slice(node.start!, node.end!));
const hooks = ast.program.body
	.filter(
		(node) =>
			node.type === 'ExportNamedDeclaration' &&
			node.declaration?.type === 'FunctionDeclaration' &&
			['useMediaEngineVersion', 'useMediaEngineStatsVersion', 'useMediaEngineConnectionVersion'].includes(
				node.declaration.id?.name ?? '',
			),
	)
	.map((node) => facadeSource.slice(node.start!, node.end!).replace(/^export /, ''));

// Execute the production subscription/hook bodies without starting the facade's device and gateway lifecycles.
const isolatedSource = `
class Facade extends Store {
	statsHostAdapter = stats;
	voiceEngineV2ProjectionStore = projection;
	connectionId = null;
	constructor() { super(); this.initializeEngineStoreSync(); }
	getAllVoiceStatesInChannel() { return voiceStates; }
	getParticipantByUserIdAndConnectionId() { return getParticipant(); }
	${methods.join('\n')}
}
const instance = new Facade();
const inactiveConnectionStore = new Store();
${hooks.join('\n')}
return {instance, useMediaEngineVersion, useMediaEngineStatsVersion: typeof useMediaEngineStatsVersion === 'function' ? useMediaEngineStatsVersion : undefined, useMediaEngineConnectionVersion: typeof useMediaEngineConnectionVersion === 'function' ? useMediaEngineConnectionVersion : undefined};`;
const module = new Function(
	'Store',
	'useStoreVersion',
	'stats',
	'connection',
	'projection',
	'voiceStates',
	'voiceEngineV2AppConnectionHostAdapter',
	'voiceEngineV2AppVoiceStateAdapter',
	'voiceEngineV2AppMediaExecutionAdapter',
	'voiceEngineV2AppScreenShareExecutionAdapter',
	'VoiceEngineV2AppSubscriptionAdapter',
	'VoiceEngineV2AppPermissionAdapter',
	'ScreenSharePublicationMigration',
	'getParticipant',
	transformSync(isolatedSource, {loader: 'ts'}).code,
)(Store, useStoreVersion, stats, connection, projection, voiceStates, connection, ...otherStateStores, () => ({
	isSpeaking: speaking,
})) as {
	instance: Store & {statsStore: StoreLike};
	useMediaEngineVersion: () => number;
	useMediaEngineStatsVersion?: () => number;
};
vi.doMock('@app/features/voice/engine/MediaEngineFacade', () => ({default: module.instance, ...module}));
const {usePendingVoiceConnection} = await import('@app/features/voice/hooks/usePendingVoiceConnection');
const {VoiceParticipantsList} = await import('@app/features/app/components/layout/VoiceParticipantsList');
const Users = (await import('@app/features/user/state/Users')).default as unknown as {
	cacheUser(userId: string): void;
	evictUser(userId: string): void;
	getUser(userId: string): unknown;
};

// Mount the production row's voice reads and pending hook without its DnD, menus, and navigation.
const rowSource = readFileSync(
	new URL(/* @vite-ignore */ '../../app/components/layout/ChannelItem.tsx', import.meta.url),
	'utf8',
);
const rowAst = parse(rowSource, {sourceType: 'module', plugins: ['typescript', 'jsx']});
const rowDeclarations: Array<string> = [];
function collectVoiceReads(node: unknown): void {
	if (!node || typeof node !== 'object') return;
	const value = node as {
		type?: string;
		start?: number;
		end?: number;
		declarations?: Array<{id: {name?: string}; init?: {type?: string; callee?: {name?: string}}}>;
	};
	if (
		value.type === 'VariableDeclaration' &&
		value.declarations?.some(
			({id, init}) =>
				[
					'connectedVoiceGuildId',
					'connectedVoiceChannelId',
					'currentUserCount',
					'isVoiceSelected',
					'channelIsE2EEEncrypted',
				].includes(id.name ?? '') || init?.callee?.name === 'usePendingVoiceConnection',
		)
	) {
		rowDeclarations.push(rowSource.slice(value.start, value.end));
		return;
	}
	for (const child of Object.values(node)) {
		if (Array.isArray(child)) child.forEach(collectVoiceReads);
		else collectVoiceReads(child);
	}
}
collectVoiceReads(rowAst.program);
const VoiceRow = new Function(
	'MediaEngine',
	'usePendingVoiceConnection',
	'computeChannelE2EEStatus',
	transformSync(
		`
return function Row({channelIsVoice, report}) {
	const guild = {id: 'guild'}; const channel = {id: 'channel', userLimit: 5};
	${rowDeclarations.join('\n')}
	report(currentUserCount); return null;
};`,
		{loader: 'ts'},
	).code,
)(
	{
		get guildId() {
			return connection.guildId;
		},
		get channelId() {
			return connection.channelId;
		},
		getAllVoiceStatesInChannel: voiceStateAdapter.getAllVoiceStatesInChannel.bind(voiceStateAdapter),
	},
	usePendingVoiceConnection,
	() => 'none',
);

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement('div');
	root = createRoot(container);
	sort.mockClear();
	groupedParticipant.mockClear();
	speaking = false;
	Object.assign(connection, {
		channelId: null,
		guildId: null,
		connected: false,
		connecting: false,
		connectFailed: false,
	});
	voiceStateAdapter.clearAllVoiceStates();
	if (!Users.getUser('user')) Users.cacheUser('user');
	if (Users.getUser('unrelated')) Users.evictUser('unrelated');
});
afterEach(() => {
	act(() => root.unmount());
});

test('statistics changes leave the facade snapshot and listeners unchanged', () => {
	const listener = vi.fn();
	const unsubscribe = module.instance.subscribe(listener);
	const before = module.instance.getSnapshot();
	const statsBefore = stats.getSnapshot();
	stats.incrementReconnectionCount();
	expect(stats.getSnapshot()).toBeGreaterThan(statsBefore);
	expect(module.instance.getSnapshot()).toBe(before);
	expect(listener).not.toHaveBeenCalled();
	unsubscribe();
});

test('connection changes still advance the facade snapshot and notify listeners', () => {
	const listener = vi.fn();
	const unsubscribe = module.instance.subscribe(listener);
	const before = module.instance.getSnapshot();
	connection.change();
	expect(module.instance.getSnapshot()).toBe(before + 1);
	expect(listener).toHaveBeenCalledTimes(1);
	unsubscribe();
});

test('pending connection consumers do not render for stats, but do for connection changes', () => {
	let renders = 0;
	const Pending = observer(() => {
		usePendingVoiceConnection({guildId: 'guild', channelId: 'channel'});
		renders += 1;
		return null;
	});
	act(() => root.render(createElement(Pending)));
	const before = renders;
	act(() => stats.incrementReconnectionCount());
	expect(renders).toBe(before);
	act(() => connection.change());
	expect(renders).toBeGreaterThan(before);
});

test('participant grouping and sorting do not run for statistics ticks', () => {
	act(() =>
		root.render(
			createElement(VoiceParticipantsList, {guild: {id: 'guild'} as never, channel: {id: 'channel'} as never}),
		),
	);
	const before = sort.mock.calls.length;
	expect(sort.mock.calls[0][0]).toHaveLength(1);
	expect(sort.mock.calls[0][0][0]).toMatchObject({userId: 'user', states: Object.values(voiceStates)});
	act(() => stats.incrementReconnectionCount());
	expect(sort).toHaveBeenCalledTimes(before);
	act(() => connection.change());
	expect(sort).toHaveBeenCalledTimes(before);
});

test('participant grouping and sorting rerun when a participant enters the user cache', () => {
	act(() => Users.evictUser('user'));
	act(() =>
		root.render(
			createElement(VoiceParticipantsList, {guild: {id: 'guild'} as never, channel: {id: 'channel'} as never}),
		),
	);
	const before = sort.mock.calls.length;
	act(() => Users.cacheUser('user'));
	expect(sort).toHaveBeenCalledTimes(before + 1);
});

test('an unrelated user entering the user cache neither sorts nor renders the participant list', () => {
	act(() =>
		root.render(
			createElement(VoiceParticipantsList, {guild: {id: 'guild'} as never, channel: {id: 'channel'} as never}),
		),
	);
	const sorts = sort.mock.calls.length;
	const renders = groupedParticipant.mock.calls.length;
	act(() => Users.cacheUser('unrelated'));
	expect(sort).toHaveBeenCalledTimes(sorts);
	expect(groupedParticipant).toHaveBeenCalledTimes(renders);
});

test('participant speaking upserts do not render pending consumers', () => {
	let renders = 0;
	const Pending = observer(() => {
		usePendingVoiceConnection({guildId: 'guild', channelId: 'channel'});
		renders += 1;
		return null;
	});
	act(() => root.render(createElement(Pending)));
	const before = renders;
	act(() => {
		speaking = true;
		projection.change();
	});
	expect(renders).toBe(before);
});

test('ChannelItem text rows do not render for participant, voice state, or connection changes', () => {
	const report = vi.fn();
	act(() => root.render(createElement(observer(VoiceRow), {channelIsVoice: false, report})));
	const before = report.mock.calls.length;
	act(() => projection.change());
	expect(report).toHaveBeenCalledTimes(before);
	act(() => connection.change());
	expect(report).toHaveBeenCalledTimes(before);
	act(() => voiceStateAdapter.handleGatewayVoiceStateUpdate('guild', gatewayVoiceState));
	expect(report).toHaveBeenCalledTimes(before);
});

test('ChannelItem voice user limit count observes gateway voice state changes', () => {
	const report = vi.fn();
	act(() => root.render(createElement(observer(VoiceRow), {channelIsVoice: true, report})));
	expect(report).toHaveBeenLastCalledWith(0);
	act(() => voiceStateAdapter.handleGatewayVoiceStateUpdate('guild', gatewayVoiceState));
	expect(report).toHaveBeenLastCalledWith(1);
	act(() => voiceStateAdapter.removeVoiceStateConnection('first'));
	expect(report).toHaveBeenLastCalledWith(0);
});

test.each(['connected', 'failed', 'channel changed'] as const)('pending connection resolves when %s', (outcome) => {
	Object.assign(connection, {guildId: 'guild', channelId: 'channel', connecting: true});
	const onConnected = vi.fn();
	let pending: ReturnType<typeof usePendingVoiceConnection>;
	let renders = 0;
	const Pending = observer(() => {
		pending = usePendingVoiceConnection({guildId: 'guild', channelId: 'channel', onConnected});
		renders += 1;
		return null;
	});
	act(() => root.render(createElement(Pending)));
	act(() => pending.markPending());
	expect(pending!.isPending).toBe(true);
	const before = renders;
	act(() => {
		connection.connecting = false;
		connection.connected = outcome === 'connected';
		connection.connectFailed = outcome === 'failed';
		if (outcome === 'channel changed') connection.channelId = 'other';
		connection.change();
	});
	expect(renders).toBeGreaterThan(before);
	expect(pending!.isPending).toBe(false);
	expect(onConnected).toHaveBeenCalledTimes(outcome === 'connected' ? 1 : 0);
});

test('speaking updates the grouped indicator without repeating grouping or sorting', () => {
	act(() =>
		root.render(
			createElement(VoiceParticipantsList, {guild: {id: 'guild'} as never, channel: {id: 'channel'} as never}),
		),
	);
	const before = sort.mock.calls.length;
	act(() => {
		speaking = true;
		projection.change();
	});
	expect(sort).toHaveBeenCalledTimes(before);
	expect(groupedParticipant.mock.calls.at(-1)?.[0]).toMatchObject({anySpeaking: true});
});

test('the statistics hook renders for clock, latency, collection, and reconnection changes', async () => {
	expect(module.useMediaEngineStatsVersion).toBeTypeOf('function');
	let version = -1;
	let renders = 0;
	const Stats = observer(() => {
		version = module.useMediaEngineStatsVersion!();
		renders += 1;
		return null;
	});
	const facadeBefore = module.instance.getSnapshot();
	const listener = vi.fn();
	const unsubscribe = module.instance.subscribe(listener);
	const statsListener = vi.fn();
	const unsubscribeStats = module.instance.statsStore.subscribe(statsListener);
	act(() => root.render(createElement(Stats)));
	const room = {
		engine: {
			client: {rtt: 37},
			pcManager: {
				publisher: {getStats: async () => new Map()},
				subscriber: {getStats: async () => new Map()},
			},
		},
		numParticipants: 1,
	} as unknown as Room;
	act(() => {
		stats.setRoom(room);
		stats.startLatencyTracking();
		stats.startStatsTracking();
	});
	for (const [index, tick] of intervals.entries()) {
		const before = renders;
		const notificationsBefore = statsListener.mock.calls.length;
		await act(async () => {
			tick();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(renders).toBeGreaterThan(before);
		expect(version).toBe(stats.getSnapshot());
		expect(module.instance.getSnapshot()).toBe(facadeBefore);
		expect(statsListener.mock.calls.length).toBeGreaterThan(notificationsBefore);
		if (index === 2) expect(statsListener.mock.calls.length).toBe(notificationsBefore + 3);
	}
	const before = renders;
	act(() => stats.incrementReconnectionCount());
	expect(renders).toBeGreaterThan(before);
	expect(version).toBe(stats.getSnapshot());
	act(() => {
		stats.stopStatsTracking();
		stats.stopLatencyTracking();
		stats.setRoom(null);
	});
	expect(module.instance.getSnapshot()).toBe(facadeBefore);
	expect(listener).not.toHaveBeenCalled();
	unsubscribe();
	unsubscribeStats();
});

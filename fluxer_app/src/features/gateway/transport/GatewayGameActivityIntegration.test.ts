// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import GameActivityStore from '@app/features/game_activity/state/GameActivityStore';
import {GatewayConnectionRole} from '@app/features/gateway/transport/GatewayConnectionRole';
import GatewaySessions from '@app/features/gateway/transport/GatewaySessionPool';
import {GatewaySocket, GatewayState} from '@app/features/gateway/transport/GatewaySocket';
import LocalPresence from '@app/features/presence/state/LocalPresence';
import {runInAction} from 'mobx';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const fixture = vi.hoisted(() => ({
	bridge: {
		initialize: vi.fn(),
		setAccount: vi.fn(async () => undefined),
		syncPolicy: vi.fn(async () => undefined),
		stopSharing: vi.fn(async () => undefined),
		disconnected: vi.fn(async () => undefined),
		presenceChanged: vi.fn(),
	},
	presence: {status: 'online', afk: false, mobile: false, custom_status: null},
}));

vi.mock('@app/features/game_activity/utils/DesktopGameActivityBridge', () => ({default: fixture.bridge}));
vi.mock('@app/features/game_activity/state/GameActivitySettings', () => ({
	default: {getEffectiveSharing: () => true, getDetectionEnabled: () => true},
}));
vi.mock('@app/features/ui/utils/NativeUtils', () => ({getElectronAPI: () => undefined}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@app/features/channel/state/ChannelFrecency', () => ({default: {handleLogout: vi.fn()}}));
vi.mock('@app/features/forum/state/ForumPosts', () => ({default: {reset: vi.fn(), handleGatewayReady: vi.fn()}}));
vi.mock('@app/features/forum/state/ForumReadState', () => ({default: {handleGatewayReady: vi.fn()}}));
vi.mock('@app/features/navigation/state/NavigationSideEffects', () => ({default: {handleGatewayReady: vi.fn()}}));
vi.mock('@app/features/threads/state/ChannelThreads', () => ({default: {handleGatewayReady: vi.fn()}}));
vi.mock('@app/features/threads/state/ThreadGuilds', () => ({
	default: {reset: vi.fn(), handleGatewayReady: vi.fn(), isPurgedEvent: () => false},
}));
vi.mock('@app/features/threads/state/ThreadPanel', () => ({default: {closeCreate: vi.fn()}}));
vi.mock('@app/features/threads/state/ThreadRoster', () => ({default: {reset: vi.fn()}}));
vi.mock('@app/features/threads/state/ThreadSubscriptions', () => ({default: {handleConnectionReady: vi.fn()}}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {getChannel: () => undefined}}));
vi.mock('@app/features/navigation/state/Navigation', () => ({default: {channelId: null}}));
vi.mock('@app/features/messaging/state/AttachmentUrlRefresher', () => ({default: {reset: vi.fn()}}));
vi.mock('@app/features/app/state/GeoIP', () => ({
	default: {latitude: null, longitude: null, applyConnectionFallbackGeo: vi.fn()},
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {gatewayEndpoint: 'wss://gateway.primary.test', getSnapshotOrNull: () => null},
}));
vi.mock('@app/features/gateway/transport/ForegroundGatewayHandoff', () => ({
	ForegroundGatewayHandoff: class ForegroundGatewayHandoff {},
}));
vi.mock('@app/features/gateway/events/EventRouter', () => ({createHandlerRegistry: () => new Map()}));
vi.mock('@app/features/gateway/transport/GatewayCompression', () => ({
	isCompressionSupported: () => true,
	isGatewayCompressionError: () => false,
	GatewayCompressionError: class GatewayCompressionError extends Error {},
	GatewayCompression: class GatewayCompression {
		warmup(): Promise<void> {
			return Promise.resolve();
		}
		destroy(): void {}
	},
}));
vi.mock('@app/features/platform/utils/ClientInfo', () => ({
	getGatewayClientProperties: () => Promise.resolve({os: 'windows', browser: 'sanalyer', device: 'desktop'}),
}));
vi.mock('@app/features/platform/state/AuthSession', () => ({
	default: {
		currentAccountKey: 'primary.test::100',
		userId: '100',
		token: 'token-primary',
		handleConnectionStarted: vi.fn(),
		handleConnectionFailed: vi.fn(),
		handleConnectionReady: vi.fn(),
		handleConnectionClosed: vi.fn(async () => undefined),
	},
}));
vi.mock('@app/features/auth/state/AccountAccess', () => ({
	default: {markGatewayReady: vi.fn(), markGatewayUnavailable: vi.fn()},
}));
vi.mock('@app/features/platform/state/ResetClientState', () => ({
	ResetClientStateReason: {GATEWAY_AUTH_FAILURE: 'gateway-auth-failure'},
	resetClientState: vi.fn(() => Promise.resolve()),
}));
vi.mock('@app/features/ui/state/LayerManager', () => ({default: {closeAll: vi.fn()}}));
vi.mock('@app/features/app/state/Initialization', () => ({
	default: {setConnecting: vi.fn(), setReady: vi.fn(), reset: vi.fn(), setError: vi.fn(), setLoading: vi.fn()},
}));
vi.mock('@app/features/app/state/RuntimeCrash', () => ({default: {triggerFatalCrash: vi.fn()}}));
vi.mock('@app/features/auth/state/Authentication', () => ({
	default: {handleConnectionClosed: vi.fn(async () => undefined)},
}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {getSettingsEpoch: () => 0}}));

vi.mock('@app/features/expressions/state/FavoriteMemes', () => ({default: {reset: vi.fn()}}));
vi.mock('@app/features/guild/state/GuildMatureContentAgree', () => ({default: {reset: vi.fn()}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {handleConnectionResumed: vi.fn()}}));
vi.mock('@app/features/member/state/MemberSearch', () => ({default: {handleLogout: vi.fn()}}));
vi.mock('@app/features/messaging/state/MessagingMessages', () => ({
	default: {handleSessionInvalidated: vi.fn(), handleConnectionClosed: vi.fn()},
}));
vi.mock('@app/features/navigation/state/SelectedGuild', async () => {
	const {observable} = await import('mobx');
	return {default: observable({selectedGuildId: null as string | null, selectionNonce: 0})};
});
vi.mock('@app/features/presence/state/LocalPresence', async () => {
	const {observable} = await import('mobx');
	return {
		default: observable(
			{
				presenceKey: 'online',
				mobile: false,
				updatePresence: () => undefined,
				getGatewayPresence: () => fixture.presence,
				handleSessionChanging: () => undefined,
			},
			{},
			{deep: false},
		),
	};
});
vi.mock('@app/features/presence/state/Presence', () => ({default: {handleSessionInvalidated: vi.fn()}}));
vi.mock('@app/features/search/state/QuickSwitcher', () => ({default: {recomputeIfOpen: vi.fn()}}));
vi.mock('@app/features/typing/state/TypingIndicator', () => ({default: {reset: vi.fn()}}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {isMobileLayout: () => false}}));
vi.mock('@app/features/voice/VoiceGatewayLifecycle', () => ({
	reportGatewayErrorToVoice: vi.fn(),
	teardownVoiceForFatalGatewayCrash: vi.fn(),
}));

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	readyState: number = FakeWebSocket.CONNECTING;
	binaryType = 'blob';
	addEventListener(): void {}
	removeEventListener(): void {}
	send(): void {}
	close(): void {
		this.readyState = FakeWebSocket.CLOSED;
	}
}

type BridgeOptions = {
	getPresence: () => unknown;
	getEnabled: () => boolean;
	send: (presence: typeof fixture.presence & {game_activity: unknown}) => boolean;
	clearReceived: () => void;
};

async function startBridge(): Promise<BridgeOptions> {
	GatewaySessions.start();
	await vi.waitFor(() => expect(fixture.bridge.initialize).toHaveBeenCalledOnce());
	return fixture.bridge.initialize.mock.calls[0][0] as BridgeOptions;
}

async function startForegroundSocket() {
	const connection = GatewaySessions.foregroundConnection;
	await connection.startSession('primary.test::100');
	const socket = connection.socket;
	if (socket === null) throw new Error('Foreground socket did not start');
	return {connection, socket};
}

beforeEach(() => {
	vi.stubGlobal('WebSocket', FakeWebSocket);
	GameActivityStore.resetRollout();
});

afterEach(() => {
	GatewaySessions.foregroundConnection.logout();
	GatewaySessions.dispose();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

describe('gateway session pool desktop game activity wiring', () => {
	it('keeps scanning and game sends closed while the rollout is off', async () => {
		const options = await startBridge();
		const {socket} = await startForegroundSocket();
		const updatePresence = vi.spyOn(socket, 'updatePresence').mockReturnValue(true);
		expect(options.getEnabled()).toBe(false);
		expect(options.send({...fixture.presence, game_activity: {game_id: 'valorant', started_at: 1000}})).toBe(false);
		expect(updatePresence).not.toHaveBeenCalled();
	});

	it('binds the producer to the foreground socket and propagates send success', async () => {
		GameActivityStore.handleRollout({game_activity_enabled: true, game_activity_epoch: 1});
		const options = await startBridge();
		expect(options.getPresence()).toEqual(fixture.presence);
		expect(options.getEnabled()).toBe(true);
		expect(options.send({...fixture.presence, game_activity: null})).toBe(false);
		const {socket} = await startForegroundSocket();
		GameActivityStore.handleRollout({game_activity_enabled: true, game_activity_epoch: 1});
		const updatePresence = vi.spyOn(socket, 'updatePresence').mockReturnValue(true);
		const activity = {game_id: 'valorant', started_at: 1000};
		expect(options.send({...fixture.presence, game_activity: activity})).toBe(true);
		expect(updatePresence).toHaveBeenCalledWith('online', false, false, null, activity);
		updatePresence.mockReturnValue(false);
		expect(options.send({...fixture.presence, game_activity: null})).toBe(false);
		expect(updatePresence).toHaveBeenLastCalledWith('online', false, false, null, null);
	});

	it('resyncs the producer policy when sharing becomes possible', async () => {
		await startBridge();
		expect(fixture.bridge.syncPolicy).not.toHaveBeenCalled();
		GameActivityStore.handleRollout({game_activity_enabled: true, game_activity_epoch: 1});
		expect(fixture.bridge.syncPolicy).toHaveBeenCalledOnce();
	});

	it('tells the producer about local presence changes', async () => {
		await startBridge();
		runInAction(() => {
			(LocalPresence as {presenceKey: string}).presenceKey = 'idle';
		});
		expect(fixture.bridge.presenceChanged).toHaveBeenCalledOnce();
	});

	it('follows the foreground session lifecycle', async () => {
		await startBridge();
		const {connection, socket} = await startForegroundSocket();
		expect(fixture.bridge.setAccount).toHaveBeenLastCalledWith('100');

		socket.emit('stateChange', GatewayState.Reconnecting, GatewayState.Connected);
		expect(fixture.bridge.disconnected).toHaveBeenCalledOnce();

		connection.handleConnectionResumed();
		expect(fixture.bridge.syncPolicy).toHaveBeenCalled();

		connection.sendInvisiblePresenceForCurrentSession('logout');
		expect(fixture.bridge.stopSharing).toHaveBeenCalledOnce();

		GameActivityStore.handleRollout({game_activity_enabled: true, game_activity_epoch: 2});
		connection.logout();
		expect(fixture.bridge.setAccount).toHaveBeenLastCalledWith(null);
		expect(fixture.bridge.disconnected).toHaveBeenCalledTimes(2);
		expect(GameActivityStore.enabled).toBe(false);
	});

	it('binds the producer to the account of an adopted foreground socket', async () => {
		await startBridge();
		const socket = new GatewaySocket('wss://gateway.primary.test', {
			token: 'token-primary',
			apiVersion: 1,
			properties: {} as never,
			isMobileLayout: () => false,
			geo: () => ({latitude: null, longitude: null}),
			role: GatewayConnectionRole.BACKGROUND,
		});
		Object.assign(socket, {
			socket: {readyState: FakeWebSocket.OPEN, close: () => undefined, dispose: () => undefined},
			connectionState: GatewayState.Connected,
			activeSessionId: 'session-100',
		});
		GatewaySessions.foregroundConnection.adoptForegroundSocket(socket, {
			accountKey: 'primary.test::100',
			sessionId: 'session-100',
		});
		expect(fixture.bridge.setAccount).toHaveBeenLastCalledWith('100');
	});
});

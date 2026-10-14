// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
	CommittedRuntimeConfig,
	PreparedRuntimeConfig,
	RuntimeConfigSnapshot,
} from '@app/features/app/state/RuntimeConfig';
import type {StoredAccount} from '@app/features/auth/state/AccountStorageContract';
import type {ReadyPayload} from '@app/features/gateway/events/GatewayReady';
import type {GatewayDispatchDelivery} from '@app/features/gateway/transport/GatewaySocket';
import type {AuthSessionDependencies} from '@app/features/platform/state/auth_session/AuthSessionDependencies';
import type {UserSettingsAccountTransitionCheckpoint} from '@app/features/user/state/UserSettings';
import {runInAction} from 'mobx';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const scope = vi.hoisted(() => ({value: 'https://one.test/api::1'}));
const readHttp = vi.hoisted(() => ({post: vi.fn()}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http: readHttp}));
vi.mock('@app/features/feed/commands/FeedCommands', () => ({outcomeOf: vi.fn()}));
vi.mock('@app/features/feed/state/FeedTimeline', () => ({default: {}}));

const feedEvents = vi.hoisted(() => ({ack: (_data: unknown) => {}, create: (_data: unknown) => {}}));
vi.mock('@app/features/gateway/events/EventRouter', () => ({
	createHandlerRegistry: () =>
		new Map([
			['FEED_NOTIFICATION_ACK', (data: unknown) => feedEvents.ack(data)],
			['FEED_NOTIFICATION_CREATE', (data: unknown) => feedEvents.create(data)],
		]),
}));

const stored = vi.hoisted(() => new Map<string, string>());
const settingsEpoch = vi.hoisted(() => ({value: 0}));
const stub = vi.hoisted(() => ({
	isPurgedEvent: () => false,
	getSettingsEpoch: () => settingsEpoch.value,
	hydrateFromSnapshot: vi.fn(),
	handleGatewayReady: vi.fn(),
	loadNotes: vi.fn(),
	setPinnedDMs: vi.fn(),
	loadFavoriteMemes: vi.fn(),
	setRegions: vi.fn(),
	setCredentials: vi.fn(),
	setConnections: vi.fn(),
}));
vi.mock('@app/features/platform/state/PersistentStorage', () => ({
	RAW_MIRROR_SCOPE_PREFIX: 'raw::',
	UNAUTHENTICATED_APP_STORAGE_SCOPE: 'unauthenticated',
	GLOBAL_APP_STORAGE_SCOPE: 'global',
	getAppStorageScope: () => scope.value,
	onBeforeAppStorageScopeChange: () => () => {},
	subscribeAppStorageScope: () => () => {},
	default: {
		getItem: (key: string) => stored.get(`${scope.value}:${key}`) ?? null,
		setItem: (key: string, value: string) => stored.set(`${scope.value}:${key}`, value),
		removeItem: (key: string) => stored.delete(`${scope.value}:${key}`),
	},
}));
vi.mock('@app/features/user/models/User', () => ({User: class {}}));
vi.mock('@app/features/gateway/transport/GatewayWireTransport', () => ({
	isDesktopNativeGatewayTransportAvailable: () => true,
}));
vi.mock('@app/features/voice/VoiceGatewayLifecycle', () => ({seedVoiceStatesFromReady: vi.fn()}));
vi.mock('@app/features/auth/state/AccountAccess', () => ({default: stub}));
vi.mock('@app/features/auth/state/AuthSession', () => ({default: stub}));
vi.mock('@app/features/channel/state/Channels', () => ({default: stub}));
vi.mock('@app/features/connection/state/UserConnection', () => ({default: stub}));
vi.mock('@app/features/emoji/state/Emoji', () => ({default: stub}));
vi.mock('@app/features/emoji/state/EmojiSticker', () => ({default: stub}));
vi.mock('@app/features/expressions/state/FavoriteMemes', () => ({default: stub}));
vi.mock('@app/features/guild/state/GuildAvailability', () => ({default: stub}));
vi.mock('@app/features/guild/state/GuildCount', () => ({default: stub}));
vi.mock('@app/features/guild/state/GuildList', () => ({default: stub}));
vi.mock('@app/features/guild/state/GuildReadState', () => ({default: stub}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: stub}));
vi.mock('@app/features/guild/state/GuildVerification', () => ({default: stub}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: stub}));
vi.mock('@app/features/member/state/MemberSearch', () => ({default: stub}));
vi.mock('@app/features/permissions/state/Permission', () => ({default: stub}));
vi.mock('@app/features/platform/state/AuthSession', () => ({default: stub}));
vi.mock('@app/features/presence/state/Presence', () => ({default: stub}));
vi.mock('@app/features/read_state/state/ReadStates', () => ({default: stub}));
vi.mock('@app/features/relationship/state/Relationships', () => ({default: stub}));
vi.mock('@app/features/threads/state/ChannelThreads', () => ({default: stub}));
vi.mock('@app/features/threads/state/ThreadGuilds', () => ({default: stub}));
vi.mock('@app/features/user/state/UserGuildSettings', () => ({default: stub}));
vi.mock('@app/features/user/state/UserNote', () => ({default: stub}));
vi.mock('@app/features/user/state/UserPinnedDM', () => ({default: stub}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: stub}));
vi.mock('@app/features/user/state/Users', () => ({default: stub}));
vi.mock('@app/features/user/state/WebAuthnCredentials', () => ({default: stub}));
vi.mock('@app/features/voice/state/RtcRegions', () => ({default: stub}));

const {AuthSessionLifecycle} = await import('@app/features/platform/state/auth_session/AuthSessionLifecycle');
const {AuthSessionAccountCatalog} = await import('@app/features/platform/state/auth_session/AuthSessionAccountCatalog');
const {AuthSessionAccountPersistence} = await import(
	'@app/features/platform/state/auth_session/AuthSessionAccountPersistence'
);
const {AuthSessionCheckpointManager} = await import('@app/features/platform/state/auth_session/AuthSessionCheckpoint');
const {AuthSessionCleanup} = await import('@app/features/platform/state/auth_session/AuthSessionCleanup');
const {AuthSessionRuntimeCommitter} = await import(
	'@app/features/platform/state/auth_session/AuthSessionRuntimeCommitter'
);
const {AuthSessionTransitionGate} = await import('@app/features/platform/state/auth_session/AuthSessionTransitionGate');
const {
	createAuthSessionSnapshot,
	transitionAuthSessionSnapshot,
	selectAuthSessionAccounts,
	selectAuthSessionAccountKey,
	selectAuthSessionCanSwitch,
} = await import('@app/features/platform/state/auth_session/AuthSessionStateMachine');
const {parseSnapshotSingleton} = await import('@app/features/gateway/snapshot/SnapshotEntities');
const {default: SnapshotSync} = await import('@app/features/gateway/snapshot/SnapshotSync');
const {runSnapshotScopeHydration, captureForegroundFeedSnapshot} = await import(
	'@app/features/gateway/snapshot/SnapshotHydration'
);
const {ForegroundPromoteCoordinator} = await import('@app/features/gateway/transport/ForegroundPromoteCoordinator');
const {sendReadCursor, markRead} = await import('@app/features/inbox/commands/FeedNotificationCommands');
const {AccountScopedWork} = await import('@app/features/platform/state/AccountScopedWork');
const {default: FeedNotifications} = await import('@app/features/inbox/state/FeedNotifications');
const {afterFeedNotificationReady} = await import('@app/features/feed/events/FeedNotificationReady');
const {ForegroundGatewayDispatchProcessor} = await import(
	'@app/features/gateway/transport/ForegroundGatewayDispatchProcessor'
);
feedEvents.ack = (data) =>
	afterFeedNotificationReady(
		() => FeedNotifications.handleAck(data as Parameters<typeof FeedNotifications.handleAck>[0]),
		A,
	);
feedEvents.create = (data) => {
	const wire = data as ReturnType<typeof notification>;
	afterFeedNotificationReady(
		() => FeedNotifications.handleNotificationCreate(wire, wire.unread_seq, wire.unread_epoch),
		A,
	);
};
const {awaitHydration, flushPendingPersistWrites, rehydrateAllPersistentStores} = await import(
	'@app/features/platform/utils/MobXPersistence'
);

const A = 'https://one.test/api::1';
const B = 'https://two.test/api::1';
function ready(count: number): ReadyPayload {
	return {
		session_id: 'session',
		user: {id: '1', username: 'self', email: 'self@example.com'},
		guilds: [],
		private_channels: [],
		relationships: [],
		read_states: [],
		user_guild_settings: [],
		user_settings: {status: 'online'},
		feed_notification_state: {unread_count: count, unread_seq: count, unread_epoch: 1, last_read_at: null},
	} as unknown as ReadyPayload;
}
const notification = (seq: number) => ({
	id: String(seq),
	type: 'post_like' as const,
	post_id: '50',
	comment_id: null,
	actors: [],
	actor_count: 1,
	updated_at: '2026-10-08T08:00:00.000Z',
	unread_seq: seq,
	unread_epoch: 1,
});
async function promote(key: string, bufferedReady?: ReadyPayload) {
	const candidate = {
		isBackgroundConnectionReady: true,
		beginBackgroundDispatchHandover: (listener: (delivery: GatewayDispatchDelivery) => void) => {
			if (bufferedReady)
				listener({type: 'READY', data: bufferedReady, retainedByteSize: 1024, receipt: {generation: 1, sequence: 1}});
		},
		endBackgroundDispatchHandover: vi.fn(),
		detachBackgroundSocket: () => ({}) as never,
		waitForBackgroundConnectionReady: async () => true,
		waitForBackgroundDispatchIdle: async () => {},
	};
	const coordinator = new ForegroundPromoteCoordinator({
		findWarmCandidate: () => candidate,
		prepareForegroundSnapshot: async () => {
			await SnapshotSync.flush(key);
			return SnapshotSync.prepareForegroundPromotion(key, SnapshotSync.captureDemotionSnapshot(key)!.entries);
		},
		hydrateForegroundSnapshot: () =>
			runSnapshotScopeHydration(
				key,
				{
					readSnapshot: (key) => SnapshotSync.readSnapshot(key),
					readCursor: (key) => SnapshotSync.readCursor(key),
					resolveSelfUserId: () => '1',
					resolveCheckedSelfUser: () => null,
					evictSnapshot: vi.fn(),
				},
				null,
			),
		commitForegroundSnapshot: (key) => SnapshotSync.commitForegroundPromotion(key),
		abortForegroundSnapshot: (key) => SnapshotSync.abortForegroundPromotion(key),
		finalizeForegroundSnapshot: (key) => SnapshotSync.finalizeForegroundPromotion(key),
		stopBackgroundConnection: vi.fn(),
		prepareForegroundReplay: vi.fn(),
		adoptForegroundSocket: vi.fn(),
		replayForegroundDispatch: (_key, delivery) => {
			if (delivery.type === 'READY')
				FeedNotifications.handleGatewayReady((delivery.data as ReadyPayload).feed_notification_state, '1');
		},
		finalizeForeground: vi.fn(),
		removeBackgroundConnection: vi.fn(),
		discardDetachedSocket: vi.fn(),
		discardForegroundConnection: vi.fn(),
	});
	await AccountScopedWork.runSuspended('account-switch', async () => {
		await coordinator.begin(key);
		flushPendingPersistWrites();
		scope.value = key;
		await rehydrateAllPersistentStores();
		expect(await coordinator.complete(key)).toEqual({mode: 'warm'});
	});
}
function lifecycleHarness() {
	const instanceA = {apiEndpoint: 'https://one.test/api'} as RuntimeConfigSnapshot;
	const instanceB = {apiEndpoint: 'https://two.test/api'} as RuntimeConfigSnapshot;
	const accounts = [instanceA, instanceB].map((instance) => ({
		storageKey: `${instance.apiEndpoint}::1`,
		userId: '1',
		token: 'token',
		lastActive: 1,
		instance,
		isValid: true,
	}));
	const records: Array<StoredAccount> = accounts.map((account) => ({
		...account,
		localStorageData: {},
		managedStorageData: {},
	}));
	let session = transitionAuthSessionSnapshot(createAuthSessionSnapshot(), {
		type: 'account.login',
		account: accounts[0]!,
	});
	session = transitionAuthSessionSnapshot(session, {type: 'accounts.loaded', accounts});
	let runtime = instanceA;
	let gatewayKey = A;
	let failPublication = false;
	const events: Array<string> = [];
	const prepareRuntime = async (snapshot: RuntimeConfigSnapshot): Promise<PreparedRuntimeConfig> => ({
		snapshot,
		transportApiEndpoint: snapshot.apiEndpoint,
		expectedGeneration: 0,
		desktopRuntime: null,
	});
	const dependencies: AuthSessionDependencies = {
		accountStorage: {
			getAllAccounts: async () => ({records, source: 'idb'}),
			getAccountInventory: vi.fn(),
			replaceInventoryEntry: vi.fn(),
			restoreAccountData: async (key) => records.find((record) => record.storageKey === key) ?? null,
			stashAccountData: async () => {},
			upsertAccount: async () => {},
			deleteAccount: async () => {},
			updateAccountValidity: async () => {},
		},
		credentialMirror: {
			read: () => ({storageKey: A, userId: '1', token: 'token'}),
			write: () => {},
			persist: async () => {},
		},
		http: {get: vi.fn()},
		getRuntimeSnapshot: () => runtime,
		resolveRuntimeEndpoint: vi.fn(),
		getStorageScope: () => scope.value,
		resolveAndPrepareRuntimeSnapshot: prepareRuntime,
		prepareRuntimeSnapshot: prepareRuntime,
		commitRuntimeSnapshot: async (prepared): Promise<CommittedRuntimeConfig> => ({
			...prepared,
			desktopRuntime: null,
			previousRuntime: {snapshot: runtime, transportApiEndpoint: runtime.apiEndpoint},
			activeRuntime: {snapshot: prepared.snapshot, transportApiEndpoint: prepared.snapshot.apiEndpoint},
			publication: {phase: 'committed'},
		}),
		publishRuntimeSnapshot: (committed) => {
			runtime = committed.snapshot;
		},
		rollbackPublishedRuntime: (committed) => {
			runtime = committed.previousRuntime!.snapshot;
		},
		finalizeRuntimeSnapshot: async () => {
			if (failPublication) {
				failPublication = false;
				throw new Error('publication failed');
			}
		},
		rollbackRuntimeSnapshot: async () => {},
		abortRuntimeSnapshot: async () => {},
		deactivateRuntime: async () => {},
		allowsCrossInstanceSwitching: () => true,
		activateStorageScope: async (key) => {
			events.push(`activate:${key}`);
			flushPendingPersistWrites();
			scope.value = key!;
			await rehydrateAllPersistentStores();
		},
		resetClientState: async () => {},
		deleteAccountStorageScope: async () => {},
		closeLayers: () => {},
		clearSudoToken: () => {},
		sendInvisiblePresence: () => {},
		captureForegroundFeedSnapshot: (key) => {
			events.push(`capture:${key}`);
			captureForegroundFeedSnapshot(key);
		},
		cleanupGatewaySession: async () => {
			events.push(`retire:${gatewayKey}`);
			SnapshotSync.demoteForeground(gatewayKey);
			gatewayKey = scope.value;
		},
		resetSyncedUserSettings: async () => {},
		captureSyncedUserSettingsCheckpoint: async () => ({}) as UserSettingsAccountTransitionCheckpoint,
		restoreSyncedUserSettingsCheckpoint: async () => {},
		accountScopedWork: {
			runSuspended: (reason, operation) =>
				AccountScopedWork.runSuspended(reason, () => operation({notifyLogout: async () => {}})),
		},
		captureLocalPresenceIntent: () => null,
		restoreLocalPresenceIntent: () => {},
		now: () => 1,
	};
	const committer = new AuthSessionRuntimeCommitter(dependencies);
	const checkpoints = new AuthSessionCheckpointManager(dependencies, committer, {
		capture: () => session,
		restore: (snapshot) => {
			session = snapshot;
		},
	});
	const lifecycle = new AuthSessionLifecycle(
		dependencies,
		{
			getState: () => session.value as 'authenticated',
			getCurrentAccountKey: () => selectAuthSessionAccountKey(session),
			getAccounts: () => selectAuthSessionAccounts(session),
			canSwitchAccount: () => selectAuthSessionCanSwitch(session),
			readCredentialMirror: dependencies.credentialMirror.read,
			dispatch: (event) => {
				session = transitionAuthSessionSnapshot(session, event);
			},
			stashCurrentAccount: async () => {},
			validateToken: async () => ({kind: 'valid'}),
			markAccountInvalid: () => {},
		},
		new AuthSessionAccountCatalog(dependencies),
		new AuthSessionAccountPersistence(dependencies),
		checkpoints,
		new AuthSessionCleanup(dependencies),
		committer,
		new AuthSessionTransitionGate(dependencies.accountScopedWork),
	);
	return {
		lifecycle,
		events,
		instanceA,
		instanceB,
		failNextPublication: () => {
			failPublication = true;
		},
	};
}

beforeEach(async () => {
	await awaitHydration('FeedNotifications');
	flushPendingPersistWrites();
	stored.clear();
	scope.value = A;
	settingsEpoch.value = 0;
	FeedNotifications.reset();
	runInAction(() => {
		FeedNotifications.lastReadAt = 0;
		FeedNotifications.lastReadUserId = null;
	});
});
afterEach(() => {
	SnapshotSync.evict(A);
	SnapshotSync.evict(B);
	FeedNotifications.reset();
});
describe('warm feed snapshot continuity', () => {
	it('hydrates user settings under the settings epoch from when hydration began', async () => {
		SnapshotSync.applyReady(
			A,
			{...ready(1), user_settings: {status: 'online'}} as unknown as ReadyPayload,
			'foreground',
		);
		stub.handleGatewayReady.mockClear();
		settingsEpoch.value = 4;
		await runSnapshotScopeHydration(
			A,
			{
				readSnapshot: (key) => {
					settingsEpoch.value = 5;
					return SnapshotSync.readSnapshot(key);
				},
				readCursor: (key) => SnapshotSync.readCursor(key),
				resolveSelfUserId: () => '1',
				resolveCheckedSelfUser: () => null,
				evictSnapshot: vi.fn(),
			},
			null,
		);
		expect(stub.handleGatewayReady).toHaveBeenCalledWith(expect.objectContaining({status: 'online'}), 4);
	});

	it('falls back to a cold READY when the snapshot holds no user settings', async () => {
		SnapshotSync.applyReady(A, {...ready(1), user_settings: null} as unknown as ReadyPayload, 'foreground');
		stub.handleGatewayReady.mockClear();
		stub.hydrateFromSnapshot.mockClear();
		await expect(
			runSnapshotScopeHydration(
				A,
				{
					readSnapshot: (key) => SnapshotSync.readSnapshot(key),
					readCursor: (key) => SnapshotSync.readCursor(key),
					resolveSelfUserId: () => '1',
					resolveCheckedSelfUser: () => null,
					evictSnapshot: vi.fn(),
				},
				null,
			),
		).rejects.toMatchObject({name: 'SnapshotHydrationUnavailableError'});
		expect(stub.handleGatewayReady).not.toHaveBeenCalled();
		expect(stub.hydrateFromSnapshot).not.toHaveBeenCalled();
	});

	it('does not treat an unloaded local inbox as an optimistic server-count reduction', async () => {
		runInAction(() => {
			FeedNotifications.lastReadAt = Date.parse('2026-10-08T07:00:00.000Z');
			FeedNotifications.lastReadUserId = '1';
		});
		flushPendingPersistWrites();
		scope.value = B;
		await rehydrateAllPersistentStores();
		expect(FeedNotifications.lastReadAt).toBe(0);
		scope.value = A;
		await rehydrateAllPersistentStores();
		expect(FeedNotifications.lastReadAt).toBe(Date.parse('2026-10-08T07:00:00.000Z'));
		SnapshotSync.applyReady(A, ready(6), 'foreground');
		FeedNotifications.handleGatewayReady(ready(6).feed_notification_state, '1');
		expect(FeedNotifications.serverUnread).toBeNull();
		expect(FeedNotifications.notifications).toHaveLength(0);
		expect(FeedNotifications.captureSnapshotState()).toMatchObject({unread_count: 0, unread_seq: 6, unread_epoch: 1});
		const socket = {
			isDispatchActive: () => true,
			completeDispatchProcessing: vi.fn(),
			failDispatchProcessing: vi.fn(),
		};
		const processor = new ForegroundGatewayDispatchProcessor({
			getSocket: () => socket as never,
			getSettingsEpoch: () => 0,
			getForegroundSocket: () => socket as never,
			getAccountUserId: () => '1',
			getPreviousSessionId: () => null,
			setPreviousSessionId: () => {},
			handleReady: () => true,
			handleGeoip: () => {},
			markGuildSynced: () => {},
		});
		await AccountScopedWork.runSuspended('account-switch', async () => {
			processor.dispatch(
				socket as never,
				{
					type: 'FEED_NOTIFICATION_CREATE',
					data: notification(7),
					receipt: {generation: 1, sequence: 1},
					retainedByteSize: 256,
				},
				A,
				() => scope.value === A,
			);
			expect(socket.failDispatchProcessing).not.toHaveBeenCalled();
			expect(FeedNotifications.notifications).toHaveLength(0);
			captureForegroundFeedSnapshot(A);
			SnapshotSync.demoteForeground(A);
			flushPendingPersistWrites();
			scope.value = B;
			await rehydrateAllPersistentStores();
		});
		await promote(A);
		expect(FeedNotifications.serverUnread).toBe(7);
		expect(FeedNotifications.unreadCount).toBe(7);
		expect(FeedNotifications.captureSnapshotAck()).toBeNull();
	});

	it.each(['same', 'new'] as const)(
		'keeps an optimistic read with a cancelled REST request when a held CREATE has a %s epoch',
		async (epoch) => {
			const harness = lifecycleHarness();
			const initial = ready(6);
			initial.feed_notification_state = {...initial.feed_notification_state!, last_read_at: '2026-10-08T07:00:00.000Z'};
			SnapshotSync.applyReady(A, initial, 'foreground');
			FeedNotifications.handleGatewayReady(initial.feed_notification_state, '1');
			FeedNotifications.handleFetchSuccess(
				FeedNotifications.handleFetchPending(),
				Array.from({length: 6}, (_, index) => notification(index + 1)),
				true,
			);
			FeedNotifications.openView();
			const request = {signal: null as AbortSignal | null, reject: (_error: unknown) => {}};
			readHttp.post.mockImplementationOnce(
				(_path: string, options: {signal: AbortSignal}) =>
					new Promise((_resolve, reject) => {
						request.signal = options.signal;
						request.reject = reject;
					}),
			);
			const pendingRead = markRead();
			expect(FeedNotifications.unreadCount).toBe(0);
			expect(FeedNotifications.captureSnapshotAck()).toBeNull();
			SnapshotSync.applyReady(B, ready(2), 'background');
			const switching = harness.lifecycle.switchAccount(B, {validatedToken: 'token'});
			await vi.waitFor(
				() => {
					expect(AccountScopedWork.isSuspended).toBe(true);
					expect(request.signal?.aborted).toBe(true);
				},
				{interval: 1, timeout: 1000},
			);
			const socket = {
				isDispatchActive: () => true,
				completeDispatchProcessing: vi.fn(),
				failDispatchProcessing: vi.fn(),
			};
			const processor = new ForegroundGatewayDispatchProcessor({
				getSocket: () => socket as never,
				getSettingsEpoch: () => 0,
				getForegroundSocket: () => socket as never,
				getAccountUserId: () => '1',
				getPreviousSessionId: () => null,
				setPreviousSessionId: () => {},
				handleReady: () => true,
				handleGeoip: () => {},
				markGuildSynced: () => {},
			});
			processor.dispatch(
				socket as never,
				{
					type: 'FEED_NOTIFICATION_CREATE',
					data: {
						...notification(epoch === 'same' ? 7 : 2),
						updated_at: '2026-10-08T10:00:00.000Z',
						unread_epoch: epoch === 'same' ? 1 : 2,
					},
					receipt: {generation: 1, sequence: 1},
					retainedByteSize: 256,
				},
				A,
				() => scope.value === A,
			);
			expect(socket.failDispatchProcessing).not.toHaveBeenCalled();
			expect(FeedNotifications.unreadCount).toBe(0);
			request.reject(new DOMException('Cancelled by account transition', 'AbortError'));
			await Promise.all([pendingRead, switching]);
			expect(FeedNotifications.captureSnapshotAck()).toBeNull();
			const metadata = parseSnapshotSingleton(SnapshotSync.captureDemotionSnapshot(A)!.entries, 'account_metadata')!;
			expect(metadata.feedNotificationAck).toBeUndefined();
			expect(metadata.feedNotifications?.last_read_at).toBe(
				epoch === 'same' ? '2026-10-08T08:00:00.000Z' : '2026-10-08T07:00:00.000Z',
			);
			await promote(B);
			expect(FeedNotifications.unreadCount).toBe(2);
			await harness.lifecycle.switchAccount(A, {validatedToken: 'token'});
			await promote(A);
			expect(FeedNotifications.unreadCount).toBe(epoch === 'same' ? 1 : 8);
			expect(FeedNotifications.captureSnapshotAck()).toBeNull();
			flushPendingPersistWrites();
			const persisted = JSON.parse(stored.get(`${A}:FeedNotifications`)!);
			expect(Object.keys(persisted).sort()).toEqual(['__mps__', 'lastReadAt', 'lastReadUserId']);
		},
	);

	it.each(['ack', 'create', 'epoch'] as const)(
		'preserves the newer reducer state when a suspended %s dispatch is held before capture',
		async (event) => {
			SnapshotSync.applyReady(A, ready(6), 'foreground');
			FeedNotifications.handleGatewayReady(ready(6).feed_notification_state, '1');
			const socket = {
				isDispatchActive: () => true,
				completeDispatchProcessing: vi.fn(),
				failDispatchProcessing: vi.fn(),
			};
			const processor = new ForegroundGatewayDispatchProcessor({
				getSocket: () => socket as never,
				getSettingsEpoch: () => 0,
				getForegroundSocket: () => socket as never,
				getAccountUserId: () => '1',
				getPreviousSessionId: () => null,
				setPreviousSessionId: () => {},
				handleReady: () => true,
				handleGeoip: () => {},
				markGuildSynced: () => {},
			});
			const ack = {last_read_at: '2026-10-08T09:00:00.000Z', unread_seq: 6, unread_epoch: 1};
			const data = event === 'ack' ? ack : event === 'create' ? notification(7) : {...notification(2), unread_epoch: 2};
			await AccountScopedWork.runSuspended('account-switch', async () => {
				processor.dispatch(
					socket as never,
					{
						type: event === 'ack' ? 'FEED_NOTIFICATION_ACK' : 'FEED_NOTIFICATION_CREATE',
						data,
						receipt: {generation: 1, sequence: 1},
						retainedByteSize: 256,
					},
					A,
					() => scope.value === A,
				);
				expect(socket.failDispatchProcessing).not.toHaveBeenCalled();
				expect(FeedNotifications.unreadCount).toBe(6);
				captureForegroundFeedSnapshot(A);
				SnapshotSync.demoteForeground(A);
				flushPendingPersistWrites();
				scope.value = B;
				await rehydrateAllPersistentStores();
			});
			const staleReady = ready(6);
			staleReady.feed_notification_state = {
				...staleReady.feed_notification_state!,
				last_read_at: '2026-10-08T07:00:00.000Z',
			};
			await promote(A, event === 'ack' ? staleReady : undefined);
			expect(FeedNotifications.unreadCount).toBe(event === 'ack' ? 0 : event === 'create' ? 7 : 8);
			if (event === 'ack') expect(FeedNotifications.lastReadAt).toBe(Date.parse(ack.last_read_at));
		},
	);
	it.each(['fetch', 'legacy create'] as const)(
		'preserves local counting through warm hydration before a later %s',
		async (event) => {
			const legacy = ready(0);
			delete legacy.feed_notification_state;
			SnapshotSync.applyReady(A, legacy, 'foreground');
			FeedNotifications.handleGatewayReady(undefined, '1');
			expect(FeedNotifications.serverUnread).toBeNull();
			captureForegroundFeedSnapshot(A);
			SnapshotSync.demoteForeground(A);
			SnapshotSync.applyReady(A, legacy, 'background');
			await promote(A);
			if (event === 'fetch')
				FeedNotifications.handleFetchSuccess(FeedNotifications.handleFetchPending(), [notification(1)], true);
			else FeedNotifications.handleNotificationCreate(notification(1));
			expect(FeedNotifications.unreadCount).toBe(1);
			expect(FeedNotifications.serverUnread).toBeNull();
		},
	);

	it('keeps local counting qualified across same-user instances', async () => {
		const legacy = ready(0);
		delete legacy.feed_notification_state;
		SnapshotSync.applyReady(A, legacy, 'foreground');
		FeedNotifications.handleGatewayReady(undefined, '1');
		captureForegroundFeedSnapshot(A);
		SnapshotSync.applyReady(B, ready(2), 'background');
		captureForegroundFeedSnapshot(B);
		SnapshotSync.demoteForeground(A);
		await promote(B);
		expect(FeedNotifications.serverUnread).toBe(2);
		captureForegroundFeedSnapshot(B);
		SnapshotSync.demoteForeground(B);
		await promote(A);
		FeedNotifications.handleNotificationCreate(notification(1));
		expect(FeedNotifications.unreadCount).toBe(1);
		expect(FeedNotifications.serverUnread).toBeNull();
	});
	it('does not replace a newer server baseline with a stale local counting mode', async () => {
		SnapshotSync.applyReady(A, ready(6), 'foreground');
		FeedNotifications.handleGatewayReady(undefined, '1');
		expect(FeedNotifications.serverUnread).toBeNull();
		captureForegroundFeedSnapshot(A);
		SnapshotSync.demoteForeground(A);
		await promote(A);
		expect(FeedNotifications.serverUnread).toBe(6);
	});
	it.each(['switch', 'login'] as const)(
		'captures the departing feed before real lifecycle %s activates and rehydrates the next scope',
		async (operation) => {
			const harness = lifecycleHarness();
			SnapshotSync.applyReady(A, ready(6), 'foreground');
			FeedNotifications.handleGatewayReady(ready(6).feed_notification_state, '1');
			const readAt = Date.parse('2026-10-08T09:00:00.000Z');
			readHttp.post.mockResolvedValueOnce({
				body: {last_read_at: new Date(readAt).toISOString(), unread_seq: 6, unread_epoch: 1},
			});
			await sendReadCursor(readAt, 6, 1);
			SnapshotSync.applyReady(B, ready(2), 'background');
			if (operation === 'switch') await harness.lifecycle.switchAccount(B, {validatedToken: 'token'});
			else await harness.lifecycle.login({userId: '1', token: 'token', runtimeSnapshot: harness.instanceB});
			expect(harness.events).toEqual([`capture:${A}`, `activate:${B}`, `retire:${A}`]);
			await promote(B);
			expect(FeedNotifications.unreadCount).toBe(2);
			await harness.lifecycle.switchAccount(A, {validatedToken: 'token'});
			const staleReady = ready(6);
			staleReady.feed_notification_state = {
				...staleReady.feed_notification_state!,
				last_read_at: '2026-10-08T07:00:00.000Z',
			};
			await promote(A, staleReady);
			expect(FeedNotifications.lastReadAt).toBe(readAt);
			expect(FeedNotifications.unreadCount).toBe(0);
		},
	);

	it('keeps a departing snapshot qualified when lifecycle publication rolls back', async () => {
		const harness = lifecycleHarness();
		SnapshotSync.applyReady(A, ready(6), 'foreground');
		FeedNotifications.handleGatewayReady(ready(6).feed_notification_state, '1');
		SnapshotSync.applyReady(B, ready(2), 'background');
		harness.failNextPublication();
		await expect(harness.lifecycle.switchAccount(B, {validatedToken: 'token'})).rejects.toThrow('publication failed');
		expect(scope.value).toBe(A);
		expect(harness.events).not.toContain(`retire:${A}`);
		SnapshotSync.demoteForeground(A);
		await promote(A);
		expect(FeedNotifications.unreadCount).toBe(6);
		await promote(B);
		expect(FeedNotifications.unreadCount).toBe(2);
	});
	it('keeps unread counts on READY-free A to B to A, including the same user on another instance', async () => {
		SnapshotSync.applyReady(A, ready(6), 'foreground');
		FeedNotifications.handleGatewayReady(ready(6).feed_notification_state, '1');
		expect(FeedNotifications.unreadCount).toBe(6);
		captureForegroundFeedSnapshot(A);
		SnapshotSync.demoteForeground(A);
		SnapshotSync.applyReady(B, ready(2), 'background');
		await promote(B);
		expect(FeedNotifications.unreadCount).toBe(2);
		captureForegroundFeedSnapshot(B);
		SnapshotSync.demoteForeground(B);
		await promote(A);
		expect(FeedNotifications.unreadCount).toBe(6);
	});
	it('reduces background pushes and acknowledgements before warm hydration without counting repeats', async () => {
		SnapshotSync.applyReady(A, ready(6), 'background');
		SnapshotSync.applyDispatch(A, {type: 'FEED_NOTIFICATION_CREATE', data: notification(7)} as never);
		SnapshotSync.applyDispatch(A, {
			type: 'FEED_NOTIFICATION_ACK',
			data: {last_read_at: '2026-10-08T07:00:00.000Z', unread_seq: 6, unread_epoch: 1},
		} as never);
		SnapshotSync.applyDispatch(A, {type: 'FEED_NOTIFICATION_CREATE', data: notification(7)} as never);
		await promote(A);
		expect(FeedNotifications.unreadCount).toBe(1);
		FeedNotifications.handleNotificationCreate(notification(7), 7, 1);
		expect(FeedNotifications.unreadCount).toBe(1);
		FeedNotifications.handleNotificationCreate(notification(8), 8, 1);
		expect(FeedNotifications.unreadCount).toBe(2);
	});
	it('retains an acknowledgement when a later READY was counted before that read', async () => {
		SnapshotSync.applyReady(A, ready(6), 'background');
		SnapshotSync.applyDispatch(A, {
			type: 'FEED_NOTIFICATION_ACK',
			data: {last_read_at: '2026-10-08T09:00:00.000Z', unread_seq: 6, unread_epoch: 1},
		} as never);
		SnapshotSync.applyReady(A, ready(6), 'background');
		await promote(A);
		expect(FeedNotifications.unreadCount).toBe(0);
	});
	it('captures the foreground optimistic read on demotion and ignores older epochs after warm hydration', async () => {
		SnapshotSync.applyReady(A, ready(6), 'foreground');
		FeedNotifications.handleGatewayReady(ready(6).feed_notification_state, '1');
		FeedNotifications.handleNotificationCreate(notification(7), 7, 1);
		FeedNotifications.openView();
		expect(FeedNotifications.closeView()).not.toBeNull();
		expect(FeedNotifications.unreadCount).toBe(0);
		captureForegroundFeedSnapshot(A);
		SnapshotSync.demoteForeground(A);
		await promote(A);
		expect(FeedNotifications.unreadCount).toBe(0);
		captureForegroundFeedSnapshot(A);
		SnapshotSync.demoteForeground(A);
		SnapshotSync.applyDispatch(A, {
			type: 'FEED_NOTIFICATION_CREATE',
			data: {...notification(2), updated_at: '2026-10-08T10:00:00.000Z', unread_epoch: 2},
		} as never);
		SnapshotSync.applyDispatch(A, {
			type: 'FEED_NOTIFICATION_ACK',
			data: {last_read_at: '2026-10-08T09:00:00.000Z', unread_seq: 20, unread_epoch: 1},
		} as never);
		await promote(A);
		expect(FeedNotifications.unreadCount).toBe(2);
	});
	it('does not capture or hydrate another instance into the active feed inbox', async () => {
		SnapshotSync.applyReady(A, ready(6), 'foreground');
		scope.value = B;
		FeedNotifications.handleGatewayReady(ready(2).feed_notification_state, '1');
		captureForegroundFeedSnapshot(A);
		SnapshotSync.demoteForeground(A);
		await runSnapshotScopeHydration(
			A,
			{
				readSnapshot: (key) => SnapshotSync.readSnapshot(key),
				readCursor: (key) => SnapshotSync.readCursor(key),
				resolveSelfUserId: () => '1',
				resolveCheckedSelfUser: () => null,
				evictSnapshot: vi.fn(),
			},
			null,
		);
		expect(FeedNotifications.unreadCount).toBe(2);
		await promote(A);
		expect(FeedNotifications.unreadCount).toBe(6);
	});

	it('keeps older snapshots without feed metadata readable without leaking the previous inbox', async () => {
		const legacy = ready(0);
		delete legacy.feed_notification_state;
		SnapshotSync.applyReady(A, legacy, 'background');
		FeedNotifications.handleGatewayReady(ready(6).feed_notification_state, 'other');
		await promote(A);
		expect(FeedNotifications.unreadCount).toBe(0);
		expect(FeedNotifications.lastReadUserId).toBe('1');
	});
	it('retains a prior server count when a later READY cannot provide feed state', async () => {
		SnapshotSync.applyReady(A, ready(6), 'background');
		const unavailable = ready(0);
		delete unavailable.feed_notification_state;
		SnapshotSync.applyReady(A, unavailable, 'background');
		await promote(A);
		expect(FeedNotifications.unreadCount).toBe(6);
	});
	it('retains the REST read acknowledgement through demotion and buffered stale READY replay', async () => {
		SnapshotSync.applyReady(A, ready(6), 'foreground');
		FeedNotifications.handleGatewayReady(ready(6).feed_notification_state, '1');
		const readAt = Date.parse('2026-10-08T09:00:00.000Z');
		readHttp.post.mockResolvedValueOnce({
			body: {last_read_at: new Date(readAt).toISOString(), unread_seq: 6, unread_epoch: 1},
		});
		await sendReadCursor(readAt, 6, 1);
		expect(FeedNotifications.unreadCount).toBe(0);
		captureForegroundFeedSnapshot(A);
		SnapshotSync.demoteForeground(A);
		const staleReady = ready(6);
		staleReady.feed_notification_state = {
			...staleReady.feed_notification_state!,
			last_read_at: '2026-10-08T07:00:00.000Z',
		};
		await promote(A, staleReady);
		expect(FeedNotifications.lastReadAt).toBe(readAt);
		expect(FeedNotifications.unreadCount).toBe(0);
	});
});

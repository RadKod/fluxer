// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, expect, it, vi} from 'vitest';

vi.mock('@app/features/ui/utils/NativeUtils', () => ({
	isNativeWindows: () => true,
	getElectronAPI: () => ({
		getTaskbarPinState: async () => ({supported: true, pinned: false, lafRequired: false}),
		requestTaskbarPin: vi.fn(async () => false),
	}),
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {getSnapshotOrNull: () => null},
	runtimeConfigSnapshotsAreSameInstance: () => true,
}));
vi.mock('@app/features/auth/state/AccountStorage', () => ({default: {}}));
vi.mock('@app/features/auth/state/AuthSudo', () => ({default: {clearToken: () => {}}}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http: {}}));
vi.mock('@app/features/presence/state/LocalPresence', () => ({default: {}}));

const ACCOUNT_SCOPE = 'https://micup.test/api::previous-account';

let stopCurrentPersistence: (() => void) | undefined;
async function loadTaskbarPin() {
	stopCurrentPersistence?.();
	vi.resetModules();
	const storage = await import('./PersistentStorage');
	await storage.initializeAppStorage({scoped: true});
	await storage.activateAppStorageScope(ACCOUNT_SCOPE);
	const store = (await import('./TaskbarPin')).default;
	const {awaitHydration, stopPersistent} = await import('@app/features/platform/utils/MobXPersistence');
	await awaitHydration('TaskbarPin');
	stopCurrentPersistence = () => stopPersistent('TaskbarPin', store);
	await store.refresh();
	return store;
}

beforeEach(async () => {
	const {resetAppStorage} = await import('./PersistentStorage');
	await resetAppStorage([]);
	window.localStorage.clear();
});
afterEach(() => {
	stopCurrentPersistence?.();
	stopCurrentPersistence = undefined;
	window.localStorage.clear();
});

it.each(['logout', 'authentication reset'] as const)(
	'keeps a dismissed device offer after %s and reload while clearing account credentials',
	async (reset) => {
		const store = await loadTaskbarPin();
		expect(store.canOffer).toBe(true);
		store.dismiss();
		window.dispatchEvent(new Event('pagehide'));
		const {default: storage, PRESERVED_RESET_STORAGE_KEYS, resetAppStorage} = await import('./PersistentStorage');
		expect(JSON.parse(storage.getItem('TaskbarPin') ?? '{}').dismissed).toBe(true);
		storage.setItem('token', 'secret');
		storage.setItem('userId', 'previous-account');
		// Written by this release: the qualified pointer keeps the previous-release credential adoption out of the boot.
		storage.setItem('fluxer:auth:active-account-key', ACCOUNT_SCOPE);
		storage.setItem('UserSettings', '{"private":"previous-account"}');
		if (reset === 'logout') {
			const {createSessionManager} = await import('./AuthSession');
			const {createDefaultAuthSessionDependencies} = await import('./auth_session/AuthSessionDependencies');
			const defaults = createDefaultAuthSessionDependencies();
			const session = createSessionManager({
				...defaults,
				accountStorage: {
					...defaults.accountStorage,
					getAllAccounts: async () => ({records: [], source: 'idb'}),
					getAccountInventory: async () => ({
						source: 'idb',
						readyEntries: [],
						runtimeRecoveryCandidates: [],
						unqualifiedRecords: [],
						unavailableRecords: [],
					}),
				},
				closeLayers: () => {},
				sendInvisiblePresence: () => {},
				cleanupGatewaySession: () => {},
				resetSyncedUserSettings: async () => {},
				accountScopedWork: {runSuspended: async (_reason, operation) => operation({notifyLogout: async () => {}})},
				captureLocalPresenceIntent: () => null,
				restoreLocalPresenceIntent: () => {},
			});
			await session.initialize();
			expect(storage.getItem('token')).toBe('secret');
			await session.logout();
		} else {
			// Shared by GatewaySocket auth failure, BootstrapErrorScreen and ErrorFallback resets.
			await resetAppStorage(PRESERVED_RESET_STORAGE_KEYS);
		}
		expect(storage.getItem('token')).toBeNull();
		expect(storage.getItem('userId')).toBeNull();
		expect(storage.getItem('UserSettings')).toBeNull();
		const reloaded = await loadTaskbarPin();
		const {default: reloadedStorage} = await import('./PersistentStorage');
		for (const key of ['token', 'userId', 'UserSettings']) expect(reloadedStorage.getItem(key), key).toBeNull();
		expect(reloaded.dismissed).toBe(true);
		expect(reloaded.canOffer).toBe(false);
		expect(reloaded.canPin).toBe(true);
	},
);

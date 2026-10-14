// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {ANALYTICS_CONSENT_STORAGE_KEY} from '@app/features/analytics/state/AnalyticsConsent';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {getSnapshotOrNull: () => null},
	runtimeConfigSnapshotsAreSameInstance: () => true,
}));
vi.mock('@app/features/auth/state/AccountStorage', () => ({default: {}}));
vi.mock('@app/features/auth/state/AuthSudo', () => ({default: {clearToken: () => {}}}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http: {}}));
vi.mock('@app/features/presence/state/LocalPresence', () => ({default: {}}));

const ACCOUNT_SCOPE = 'https://micup.test/api::previous-account';

beforeEach(() => {
	vi.resetModules();
	window.localStorage.clear();
});
afterEach(async () => {
	const {resetAppStorage} = await import('./PersistentStorage');
	await resetAppStorage([]);
	window.localStorage.clear();
});

async function logoutAndReload(values: Map<string, string>): Promise<void> {
	const storage = await import('./PersistentStorage');
	await storage.initializeAppStorage({scoped: true});
	await storage.activateAppStorageScope(ACCOUNT_SCOPE);
	for (const [key, value] of values) storage.default.setItem(key, value);
	storage.default.setItem('token', 'secret');
	storage.default.setItem('userId', 'previous-account');
	// Written by this release: the qualified pointer keeps the previous-release credential adoption out of the boot.
	storage.default.setItem('fluxer:auth:active-account-key', ACCOUNT_SCOPE);
	await storage.flushAppStorageWrites();
	const {createDefaultAuthSessionDependencies} = await import('./auth_session/AuthSessionDependencies');
	const {createSessionManager} = await import('./AuthSession');
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
	expect(defaults.credentialMirror.read()).toEqual({
		storageKey: ACCOUNT_SCOPE,
		userId: 'previous-account',
		token: 'secret',
	});
	await session.logout();
	await storage.flushAppStorageWrites();
	expect(defaults.credentialMirror.read()).toEqual({storageKey: null, userId: null, token: null});
	const {getPersistentStorageBackend} = await import('./PersistentStorageBackend');
	expect(await getPersistentStorageBackend().load(ACCOUNT_SCOPE)).toEqual(new Map());
	vi.resetModules();
	const reloaded = await import('./PersistentStorage');
	await reloaded.initializeAppStorage({scoped: true});
	await reloaded.activateAppStorageScope(ACCOUNT_SCOPE);
	for (const key of ['token', 'userId', 'UserSettings', 'Drafts'])
		expect(reloaded.default.getItem(key), key).toBeNull();
	for (const key of [...values.keys()]) {
		const value = reloaded.default.getItem(key);
		if (value === null) values.delete(key);
		else values.set(key, value);
	}
}

describe('AuthSessionManager.logout on sanalyer', () => {
	it('keeps device voice room discovery flags when logging out', async () => {
		const discovery = '{"dismissed":true,"shimmerShown":true,"__mps__":{"version":1}}';
		const values = new Map([
			['UserSettings', '{"private":"previous-account"}'],
			['VoiceRoomControlDiscovery', discovery],
		]);
		await logoutAndReload(values);
		expect(values.get('VoiceRoomControlDiscovery')).toBe(discovery);
		expect(values.has('UserSettings')).toBe(false);
	});

	it('clears account data but keeps the analytics consent choice', async () => {
		const values = new Map([
			['UserSettings', '{"private":"previous-account"}'],
			['Drafts', '{}'],
			[ANALYTICS_CONSENT_STORAGE_KEY, '{"version":1,"choice":"denied"}'],
		]);
		await logoutAndReload(values);
		expect([...values.entries()]).toEqual([[ANALYTICS_CONSENT_STORAGE_KEY, '{"version":1,"choice":"denied"}']]);
	});

	it('keeps the device flag of the one-time 16px to 15px chat text move', async () => {
		const values = new Map([
			['UserSettings', '{"private":"previous-account"}'],
			['Accessibility:fontSizeDefault15MigratedV1', 'true'],
		]);
		await logoutAndReload(values);
		expect(values.get('Accessibility:fontSizeDefault15MigratedV1')).toBe('true');
	});

	it('keeps the device motion settings and the flag of their one-time move', async () => {
		const motion = '{"syncReducedMotionWithSystem":false,"reducedMotionOverride":true}';
		const values = new Map([
			['UserSettings', '{"private":"previous-account"}'],
			['Accessibility:motion', motion],
			['Accessibility:motionSyncDefaultOffMigratedV1', 'true'],
		]);
		await logoutAndReload(values);
		expect(values.get('Accessibility:motion')).toBe(motion);
		expect(values.get('Accessibility:motionSyncDefaultOffMigratedV1')).toBe('true');
	});
});

// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	type ChannelFrecencyHistory,
	channelFrecencyHistoryFromWire,
	channelFrecencyHistoryToWire,
	computeChannelFrecency,
	mergeChannelFrecencyWireUsage,
	trackChannelUse,
} from '@app/features/channel/utils/ChannelFrecencyCalculator';
import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import type {UserSettingsPayload} from '@app/features/user/events/UserSettingsUpdate';
import type {SyncedPreferences} from '@app/features/user/state/SyncedPreferencesEngine';
import {create} from '@bufbuild/protobuf';
import {
	ChannelFrecencyStateSchema,
	GuildNsfwAgreementsSchema,
} from '@fluxer/schema/src/gen/fluxer/user/preferences/v1/preferences_pb';
import {makeAutoObservable, observable, observableShallow, runInAction} from 'mobx';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({patch: vi.fn()}));

vi.mock('@lingui/core/macro', () => ({
	msg: (descriptor: unknown) => descriptor,
	t: (descriptor: unknown) => descriptor,
}));

vi.mock('@app/features/guild/state/GuildList', () => ({default: {sortGuilds: vi.fn()}}));

vi.mock('@app/features/platform/transport/RestTransport', () => ({
	http: {get: vi.fn(), post: vi.fn(), patch: mocks.patch},
}));

const session = observable({userId: null as string | null});
const {makeSyncedField, setSyncedFieldSessionManager} = await import('@app/features/user/state/SyncedField');
setSyncedFieldSessionManager(session);
// Idle and LocalPresence import each other; loading Idle first keeps its timer from calling a half-loaded store.
await import('@app/features/ui/state/Idle');
const {default: UserSettings} = await import('@app/features/user/state/UserSettings');
const appStartCheckpoint = UserSettings.captureAccountTransitionCheckpoint();
const {handleUserSettingsUpdate} = await import('@app/features/user/events/UserSettingsUpdate');
const {default: AppStorage} = await import('@app/features/platform/state/PersistentStorage');
const {createEmptySyncedPreferences, decodeSyncedPreferencesLenient, encodeSyncedPreferences} = await import(
	'@fluxer/schema/src/domains/user/SyncedPreferencesCodec'
);

const ACCOUNT_A = '1100000000000000001';
const ACCOUNT_B = '2200000000000000002';
const A_CHANNEL_1 = '1100000000000000011';
const A_CHANNEL_2 = '1100000000000000012';
const A_CHANNEL_3 = '1100000000000000013';
const B_CHANNEL_1 = '2200000000000000021';
const B_CHANNEL_2 = '2200000000000000022';
const A_GUILD = '1100000000000000031';
const B_GUILD = '2200000000000000041';
const LOCAL_GUILD = '3300000000000000051';
const SYNC_DELAYS_MS = [1_500, 600_000];

class FrecencyStore {
	useLog: ChannelFrecencyHistory = new Map();
	live = true;

	constructor() {
		makeAutoObservable(this, {useLog: observableShallow});
	}

	use(channelId: string): void {
		trackChannelUse(this.useLog, channelId);
		computeChannelFrecency(this.useLog, Date.now());
	}
}

class AgreementStore {
	agreedChannelIds: Array<string> = [];
	agreedCategoryIds: Array<string> = [];
	agreedGuildIds: Array<string> = [];
	live = true;
	syncOn: boolean;

	constructor(syncOn: boolean) {
		this.syncOn = syncOn;
		makeAutoObservable(this);
	}

	reset(): void {
		this.agreedChannelIds = [];
		this.agreedCategoryIds = [];
		this.agreedGuildIds = [];
	}
}

const liveStores: Array<{live: boolean}> = [];

async function createFrecencyStore(debounceMs: number): Promise<FrecencyStore> {
	const store = new FrecencyStore();
	liveStores.push(store);
	await makeSyncedField(store, {
		field: 'channelFrecency',
		schema: ChannelFrecencyStateSchema,
		persist: ['useLog'],
		debounceMs,
		enabled: () => store.live,
		toMessage: (s) => ({usage: channelFrecencyHistoryToWire(s.useLog)}),
		applyMessage: (s, message) => {
			s.useLog = channelFrecencyHistoryFromWire(message.usage, Date.now());
		},
		mergeRemote: (local, incoming) => ({
			usage: mergeChannelFrecencyWireUsage(local.usage, incoming.usage, Date.now()),
		}),
	});
	return store;
}

async function createAgreementStore(syncEnabled = true): Promise<AgreementStore> {
	const store = new AgreementStore(syncEnabled);
	liveStores.push(store);
	await makeSyncedField(store, {
		field: 'guildNsfwAgreements',
		schema: GuildNsfwAgreementsSchema,
		persist: ['agreedChannelIds', 'agreedCategoryIds', 'agreedGuildIds'],
		enabled: () => store.live && store.syncOn,
		toMessage: (s) => ({
			agreedChannelIds: [...s.agreedChannelIds],
			agreedCategoryIds: [...s.agreedCategoryIds],
			agreedGuildIds: [...s.agreedGuildIds],
		}),
		applyMessage: (s, m) => {
			s.agreedChannelIds = [...m.agreedChannelIds];
			s.agreedCategoryIds = [...m.agreedCategoryIds];
			s.agreedGuildIds = [...m.agreedGuildIds];
		},
	});
	return store;
}

function serverPreferences(init: {channels?: Array<string>; agreedGuildIds?: Array<string>}): SyncedPreferences {
	const preferences = createEmptySyncedPreferences();
	if (init.channels !== undefined) {
		const history: ChannelFrecencyHistory = new Map();
		for (const channelId of init.channels) trackChannelUse(history, channelId);
		computeChannelFrecency(history, Date.now());
		preferences.channelFrecency = create(ChannelFrecencyStateSchema, {usage: channelFrecencyHistoryToWire(history)});
	}
	if (init.agreedGuildIds !== undefined) {
		preferences.guildNsfwAgreements = create(GuildNsfwAgreementsSchema, {agreedGuildIds: init.agreedGuildIds});
	}
	return preferences;
}

function settingsPayload(preferences: SyncedPreferences | null) {
	return {
		status: 'online',
		flags: 0,
		locale: 'en-US',
		developer_mode: false,
		message_display_compact: false,
		restricted_guilds: [],
		bot_restricted_guilds: [],
		guild_folders: [],
		trusted_domains: [],
		staff_dm_access_user_ids: [],
		suppress_unprivileged_self_mentions_bypass_user_ids: [],
		synced_preferences: preferences === null ? null : encodeSyncedPreferences(preferences),
	};
}

function gatewayReady(
	preferences: SyncedPreferences | null,
	settingsEpoch: number = UserSettings.getSettingsEpoch(),
): void {
	UserSettings.handleGatewayReady(settingsPayload(preferences), settingsEpoch);
}

function settingsUpdate(preferences: SyncedPreferences | null, settingsEpoch: number): void {
	handleUserSettingsUpdate(
		{...settingsPayload(preferences), time_format: 0, guild_positions: []} as unknown as UserSettingsPayload,
		{settingsEpoch, accountKey: null} as GatewayHandlerContext,
	);
}

function setUser(userId: string | null): void {
	runInAction(() => {
		session.userId = userId;
	});
}

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(0);
	}
}

function patchedPreferences(): Array<SyncedPreferences> {
	return mocks.patch.mock.calls.map(([, options]) =>
		decodeSyncedPreferencesLenient(
			(options as {body: {synced_preferences: string | null}}).body.synced_preferences ?? null,
		),
	);
}

function patchedChannelIds(): Array<string> {
	return patchedPreferences().flatMap((preferences) => Object.keys(preferences.channelFrecency?.usage ?? {}));
}

function remoteChannelIds(): Array<string> {
	return Object.keys(UserSettings.getSubPreference('channelFrecency')?.usage ?? {}).sort();
}

async function signInAsAWithSyncedUse(store: FrecencyStore, delayMs: number): Promise<void> {
	setUser(ACCOUNT_A);
	gatewayReady(null);
	await settle();
	store.use(A_CHANNEL_1);
	await vi.advanceTimersByTimeAsync(delayMs);
	await settle();
	expect(patchedChannelIds()).toContain(A_CHANNEL_1);
	mocks.patch.mockClear();
}

describe('synced fields across an account change', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mocks.patch.mockResolvedValue({ok: true, status: 200, body: {}});
	});

	afterEach(() => {
		for (const store of liveStores.splice(0)) {
			runInAction(() => {
				store.live = false;
			});
		}
		UserSettings.handleAccountTransition();
		setUser(null);
		mocks.patch.mockReset();
		vi.useRealTimers();
	});

	it.each(SYNC_DELAYS_MS)(
		'does not write the previous account usage into the next account after logout and login (delay %i ms)',
		async (delayMs) => {
			const store = await createFrecencyStore(delayMs);
			await signInAsAWithSyncedUse(store, delayMs);
			store.use(A_CHANNEL_2);

			UserSettings.handleAccountTransition();
			setUser(null);
			await vi.advanceTimersByTimeAsync(delayMs);
			await settle();

			setUser(ACCOUNT_B);
			gatewayReady(serverPreferences({channels: [B_CHANNEL_1]}));
			await settle();
			await vi.advanceTimersByTimeAsync(delayMs);
			await settle();

			expect(patchedChannelIds()).not.toContain(A_CHANNEL_1);
			expect(patchedChannelIds()).not.toContain(A_CHANNEL_2);
			expect(remoteChannelIds()).toEqual([B_CHANNEL_1]);
			expect([...store.useLog.keys()]).toEqual([B_CHANNEL_1]);
		},
	);

	it.each(SYNC_DELAYS_MS)(
		'does not write the previous account usage into the next account during an account switch (delay %i ms)',
		async (delayMs) => {
			const store = await createFrecencyStore(delayMs);
			await signInAsAWithSyncedUse(store, delayMs);
			store.use(A_CHANNEL_2);

			UserSettings.handleAccountTransition();
			await vi.advanceTimersByTimeAsync(delayMs);
			await settle();
			setUser(ACCOUNT_B);
			gatewayReady(serverPreferences({channels: [B_CHANNEL_1]}));
			await settle();
			await vi.advanceTimersByTimeAsync(delayMs);
			await settle();

			expect(patchedChannelIds()).not.toContain(A_CHANNEL_1);
			expect(patchedChannelIds()).not.toContain(A_CHANNEL_2);
			expect(remoteChannelIds()).toEqual([B_CHANNEL_1]);
			expect([...store.useLog.keys()]).toEqual([B_CHANNEL_1]);
		},
	);

	it('does not overwrite the next account with a reset made while the previous session retires', async () => {
		const store = await createAgreementStore();
		setUser(ACCOUNT_A);
		gatewayReady(serverPreferences({agreedGuildIds: [A_GUILD]}));
		await settle();
		expect(store.agreedGuildIds).toEqual([A_GUILD]);
		mocks.patch.mockClear();

		UserSettings.handleAccountTransition();
		setUser(ACCOUNT_B);
		UserSettings.markSessionChanging();
		store.reset();
		await settle();
		gatewayReady(serverPreferences({agreedGuildIds: [B_GUILD]}));
		await settle();

		expect(
			patchedPreferences().map((preferences) => preferences.guildNsfwAgreements?.agreedGuildIds),
		).not.toContainEqual([]);
		expect(UserSettings.getSubPreference('guildNsfwAgreements')?.agreedGuildIds).toEqual([B_GUILD]);
		expect(store.agreedGuildIds).toEqual([B_GUILD]);
	});

	it.each(SYNC_DELAYS_MS)('still syncs the next account own usage once it is ready (delay %i ms)', async (delayMs) => {
		const store = await createFrecencyStore(delayMs);
		await signInAsAWithSyncedUse(store, delayMs);

		UserSettings.handleAccountTransition();
		setUser(ACCOUNT_B);
		gatewayReady(serverPreferences({channels: [B_CHANNEL_1]}));
		await settle();
		mocks.patch.mockClear();
		store.use(B_CHANNEL_2);
		await vi.advanceTimersByTimeAsync(delayMs);
		await settle();

		expect(new Set(patchedChannelIds())).toEqual(new Set([B_CHANNEL_1, B_CHANNEL_2]));
		expect(remoteChannelIds()).toEqual([B_CHANNEL_1, B_CHANNEL_2]);
	});

	it.each(SYNC_DELAYS_MS)(
		'still sends a change made before the first READY of the same session (delay %i ms)',
		async (delayMs) => {
			const appStarted = UserSettings.restoreAccountTransitionCheckpoint(appStartCheckpoint);
			await settle();
			await appStarted;
			setUser(ACCOUNT_A);
			const store = await createFrecencyStore(delayMs);
			store.use(A_CHANNEL_1);
			await vi.advanceTimersByTimeAsync(delayMs);
			await settle();
			expect(mocks.patch).not.toHaveBeenCalled();

			gatewayReady(null);
			await settle();

			expect(patchedChannelIds()).toContain(A_CHANNEL_1);
			expect(remoteChannelIds()).toEqual([A_CHANNEL_1]);
		},
	);

	it('keeps the local value of a field whose sync is turned off across an account change', async () => {
		const store = await createAgreementStore(false);
		setUser(ACCOUNT_A);
		gatewayReady(serverPreferences({agreedGuildIds: [A_GUILD]}));
		await settle();
		runInAction(() => {
			store.agreedGuildIds = [LOCAL_GUILD];
		});
		await settle();

		UserSettings.handleAccountTransition();
		setUser(ACCOUNT_B);
		gatewayReady(serverPreferences({agreedGuildIds: [B_GUILD]}));
		await settle();

		expect(store.agreedGuildIds).toEqual([LOCAL_GUILD]);
		expect(mocks.patch).not.toHaveBeenCalled();
	});

	it('ignores a settings update from the outgoing session during an account switch', async () => {
		const frecency = await createFrecencyStore(1_500);
		const agreements = await createAgreementStore();
		setUser(ACCOUNT_A);
		gatewayReady(serverPreferences({channels: [A_CHANNEL_1], agreedGuildIds: [A_GUILD]}));
		await settle();
		expect(agreements.agreedGuildIds).toEqual([A_GUILD]);
		mocks.patch.mockClear();

		const outgoing = UserSettings.getSettingsEpoch();
		UserSettings.handleAccountTransition();
		settingsUpdate(serverPreferences({channels: [A_CHANNEL_1], agreedGuildIds: [A_GUILD]}), outgoing);
		await settle();
		frecency.use(A_CHANNEL_2);
		agreements.reset();
		await vi.advanceTimersByTimeAsync(1_500);
		await settle();
		setUser(ACCOUNT_B);
		gatewayReady(serverPreferences({channels: [B_CHANNEL_1], agreedGuildIds: [B_GUILD]}));
		await settle();
		await vi.advanceTimersByTimeAsync(1_500);
		await settle();

		expect(patchedChannelIds()).not.toContain(A_CHANNEL_1);
		expect(patchedChannelIds()).not.toContain(A_CHANNEL_2);
		expect(
			patchedPreferences().map((preferences) => preferences.guildNsfwAgreements?.agreedGuildIds),
		).not.toContainEqual([]);
		expect(remoteChannelIds()).toEqual([B_CHANNEL_1]);
		expect(UserSettings.getSubPreference('guildNsfwAgreements')?.agreedGuildIds).toEqual([B_GUILD]);
		expect([...frecency.useLog.keys()]).toEqual([B_CHANNEL_1]);
		expect(agreements.agreedGuildIds).toEqual([B_GUILD]);
	});

	it.each(SYNC_DELAYS_MS)(
		'keeps the pending usage of the same account across logout and login again (delay %i ms)',
		async (delayMs) => {
			const store = await createFrecencyStore(delayMs);
			await signInAsAWithSyncedUse(store, delayMs);
			store.use(A_CHANNEL_2);

			UserSettings.handleAccountTransition();
			setUser(null);
			await vi.advanceTimersByTimeAsync(delayMs);
			await settle();
			setUser(ACCOUNT_A);
			gatewayReady(serverPreferences({channels: [A_CHANNEL_1]}));
			await settle();
			await vi.advanceTimersByTimeAsync(delayMs);
			await settle();

			expect(patchedChannelIds()).toContain(A_CHANNEL_2);
			expect(remoteChannelIds()).toEqual([A_CHANNEL_1, A_CHANNEL_2]);
		},
	);

	it.each(SYNC_DELAYS_MS)(
		'keeps syncing the same account after a failed switch is rolled back (delay %i ms)',
		async (delayMs) => {
			const store = await createFrecencyStore(delayMs);
			await signInAsAWithSyncedUse(store, delayMs);
			store.use(A_CHANNEL_2);

			const checkpoint = UserSettings.captureAccountTransitionCheckpoint();
			UserSettings.handleAccountTransition();
			await vi.advanceTimersByTimeAsync(delayMs);
			await settle();
			const restored = UserSettings.restoreAccountTransitionCheckpoint(checkpoint);
			await settle();
			await restored;
			await vi.advanceTimersByTimeAsync(delayMs);
			await settle();

			expect(patchedChannelIds()).toContain(A_CHANNEL_2);
			mocks.patch.mockClear();
			store.use(A_CHANNEL_3);
			await vi.advanceTimersByTimeAsync(delayMs);
			await settle();
			expect(patchedChannelIds()).toContain(A_CHANNEL_3);
		},
	);

	it('does not carry preferences another tab stored for the previous account into the next account', async () => {
		const store = await createFrecencyStore(1_500);
		await signInAsAWithSyncedUse(store, 1_500);

		UserSettings.handleAccountTransition();
		AppStorage.setItem(
			'UserSettings:syncedPreferencesLocal',
			encodeSyncedPreferences(serverPreferences({channels: [A_CHANNEL_1, A_CHANNEL_2]})),
		);
		window.dispatchEvent(new StorageEvent('storage', {key: null, storageArea: window.localStorage}));
		await settle();
		expect(remoteChannelIds()).toEqual([A_CHANNEL_1, A_CHANNEL_2]);
		await vi.advanceTimersByTimeAsync(1_500);
		await settle();
		setUser(ACCOUNT_B);
		gatewayReady(serverPreferences({channels: [B_CHANNEL_1]}));
		await settle();
		await vi.advanceTimersByTimeAsync(1_500);
		await settle();

		expect(patchedChannelIds()).not.toContain(A_CHANNEL_1);
		expect(patchedChannelIds()).not.toContain(A_CHANNEL_2);
		expect(remoteChannelIds()).toEqual([B_CHANNEL_1]);
		expect([...store.useLog.keys()]).toEqual([B_CHANNEL_1]);
	});

	it('ignores a READY from the outgoing session during an account switch', async () => {
		const frecency = await createFrecencyStore(1_500);
		const agreements = await createAgreementStore();
		setUser(ACCOUNT_A);
		gatewayReady(serverPreferences({channels: [A_CHANNEL_1], agreedGuildIds: [A_GUILD]}));
		await settle();
		mocks.patch.mockClear();

		const outgoing = UserSettings.getSettingsEpoch();
		UserSettings.handleAccountTransition();
		gatewayReady(serverPreferences({channels: [A_CHANNEL_1], agreedGuildIds: [A_GUILD]}), outgoing);
		await settle();
		expect(UserSettings.isHydrated()).toBe(false);
		frecency.use(A_CHANNEL_2);
		agreements.reset();
		await vi.advanceTimersByTimeAsync(1_500);
		await settle();
		setUser(ACCOUNT_B);
		gatewayReady(serverPreferences({channels: [B_CHANNEL_1], agreedGuildIds: [B_GUILD]}));
		await settle();
		await vi.advanceTimersByTimeAsync(1_500);
		await settle();

		expect(patchedChannelIds()).not.toContain(A_CHANNEL_1);
		expect(patchedChannelIds()).not.toContain(A_CHANNEL_2);
		expect(
			patchedPreferences().map((preferences) => preferences.guildNsfwAgreements?.agreedGuildIds),
		).not.toContainEqual([]);
		expect(remoteChannelIds()).toEqual([B_CHANNEL_1]);
		expect(agreements.agreedGuildIds).toEqual([B_GUILD]);
	});

	it('applies settings updates after a READY that carried no settings', async () => {
		setUser(ACCOUNT_A);
		UserSettings.handleGatewayReady(null, UserSettings.getSettingsEpoch());
		await settle();

		settingsUpdate(serverPreferences({channels: [A_CHANNEL_1]}), UserSettings.getSettingsEpoch());
		await settle();

		expect(UserSettings.isHydrated()).toBe(true);
		expect(remoteChannelIds()).toEqual([A_CHANNEL_1]);
	});

	it('drops an unsent edit when a 4004 ends the session, even for the same account', async () => {
		setUser(ACCOUNT_A);
		gatewayReady(null);
		await settle();
		mocks.patch.mockRejectedValueOnce({status: 429});
		void UserSettings.setSanitizeUrls(!UserSettings.getSanitizeUrls()).catch(() => undefined);
		await settle();
		expect(mocks.patch).toHaveBeenCalledTimes(1);
		expect(UserSettings.getSanitizeUrls()).toBe(true);
		mocks.patch.mockClear();

		UserSettings.markSessionChanging();
		UserSettings.handleAccountTransition();
		setUser(null);
		await vi.advanceTimersByTimeAsync(60_000);
		await settle();
		expect(mocks.patch).not.toHaveBeenCalled();
		setUser(ACCOUNT_A);
		gatewayReady(null);
		await settle();

		expect(mocks.patch).not.toHaveBeenCalled();
		expect(UserSettings.getSanitizeUrls()).toBe(false);
	});

	it('does not hand the previous account settings to another account after a 4004', async () => {
		const store = await createFrecencyStore(1_500);
		await signInAsAWithSyncedUse(store, 1_500);
		store.use(A_CHANNEL_2);
		mocks.patch.mockRejectedValueOnce({status: 429});
		void UserSettings.setSanitizeUrls(true).catch(() => undefined);
		await settle();
		mocks.patch.mockClear();

		UserSettings.markSessionChanging();
		UserSettings.handleAccountTransition();
		setUser(null);
		await vi.advanceTimersByTimeAsync(60_000);
		await settle();
		setUser(ACCOUNT_B);
		gatewayReady(serverPreferences({channels: [B_CHANNEL_1]}));
		await settle();
		await vi.advanceTimersByTimeAsync(1_500);
		await settle();

		expect(patchedChannelIds()).not.toContain(A_CHANNEL_1);
		expect(patchedChannelIds()).not.toContain(A_CHANNEL_2);
		expect(patchedPreferences().map((preferences) => preferences.sanitizeUrls)).not.toContain(true);
		expect(UserSettings.getSanitizeUrls()).toBe(false);
		expect(remoteChannelIds()).toEqual([B_CHANNEL_1]);
		expect([...store.useLog.keys()]).toEqual([B_CHANNEL_1]);
	});

	it('keeps a store created between accounts from overwriting the next account', async () => {
		setUser(ACCOUNT_A);
		gatewayReady(null);
		await settle();
		UserSettings.handleAccountTransition();
		setUser(ACCOUNT_B);

		const store = await createFrecencyStore(1_500);
		store.use(B_CHANNEL_2);
		await vi.advanceTimersByTimeAsync(1_500);
		await settle();
		gatewayReady(serverPreferences({channels: [B_CHANNEL_1]}));
		await settle();
		await vi.advanceTimersByTimeAsync(1_500);
		await settle();

		expect(remoteChannelIds()).toContain(B_CHANNEL_1);
		for (const preferences of patchedPreferences()) {
			expect(Object.keys(preferences.channelFrecency?.usage ?? {})).toContain(B_CHANNEL_1);
		}
	});

	it('drops data of unknown ownership when only the account epoch changes', async () => {
		const appStarted = UserSettings.restoreAccountTransitionCheckpoint(appStartCheckpoint);
		await settle();
		await appStarted;
		const store = await createFrecencyStore(1_500);
		setUser(ACCOUNT_A);
		gatewayReady(null);
		await settle();
		store.use(A_CHANNEL_1);

		runInAction(() => {
			UserSettings.handleAccountTransition();
			gatewayReady(null);
		});
		await settle();
		await vi.advanceTimersByTimeAsync(1_500);
		await settle();

		expect(patchedChannelIds()).not.toContain(A_CHANNEL_1);
		expect([...store.useLog.keys()]).toEqual([]);
	});

	it('leaves a field whose sync was turned off untouched across an account change', async () => {
		const store = await createAgreementStore();
		setUser(ACCOUNT_A);
		gatewayReady(serverPreferences({agreedGuildIds: [A_GUILD]}));
		await settle();
		expect(store.agreedGuildIds).toEqual([A_GUILD]);
		runInAction(() => {
			store.syncOn = false;
			store.agreedGuildIds = [LOCAL_GUILD];
		});
		await settle();

		UserSettings.handleAccountTransition();
		setUser(ACCOUNT_B);
		gatewayReady(serverPreferences({agreedGuildIds: [B_GUILD]}));
		await settle();

		expect(store.agreedGuildIds).toEqual([LOCAL_GUILD]);
	});

	it('does not PATCH an empty value when the next account has none', async () => {
		const store = await createFrecencyStore(1_500);
		await signInAsAWithSyncedUse(store, 1_500);

		UserSettings.handleAccountTransition();
		setUser(ACCOUNT_B);
		gatewayReady(null);
		await settle();
		await vi.advanceTimersByTimeAsync(1_500);
		await settle();

		expect([...store.useLog.keys()]).toEqual([]);
		expect(mocks.patch).not.toHaveBeenCalled();
	});

	it('empties a store with unknown ownership when the next account has no value', async () => {
		const store = await createFrecencyStore(1_500);
		setUser(ACCOUNT_A);
		gatewayReady(null);
		await settle();
		store.use(A_CHANNEL_1);

		UserSettings.handleAccountTransition();
		setUser(null);
		await vi.advanceTimersByTimeAsync(1_500);
		await settle();
		setUser(ACCOUNT_B);
		gatewayReady(null);
		await settle();
		await vi.advanceTimersByTimeAsync(1_500);
		await settle();

		expect([...store.useLog.keys()]).toEqual([]);
		expect(patchedChannelIds()).not.toContain(A_CHANNEL_1);
	});

	it('drops a synced edit made while no account is signed in', async () => {
		const store = await createAgreementStore();
		setUser(ACCOUNT_A);
		gatewayReady(serverPreferences({agreedGuildIds: [A_GUILD]}));
		await settle();
		mocks.patch.mockClear();

		UserSettings.handleAccountTransition();
		setUser(null);
		runInAction(() => {
			store.agreedGuildIds = [A_GUILD, LOCAL_GUILD];
		});
		await settle();
		setUser(ACCOUNT_A);
		gatewayReady(serverPreferences({agreedGuildIds: [A_GUILD]}));
		await settle();

		expect(store.agreedGuildIds).toEqual([A_GUILD]);
		expect(mocks.patch).not.toHaveBeenCalled();
	});

	it('does not merge usage recorded by a store created between accounts', async () => {
		setUser(ACCOUNT_A);
		gatewayReady(null);
		await settle();
		UserSettings.handleAccountTransition();

		const store = await createFrecencyStore(1_500);
		store.use(A_CHANNEL_2);
		setUser(ACCOUNT_B);
		gatewayReady(serverPreferences({channels: [B_CHANNEL_1]}));
		await settle();
		await vi.advanceTimersByTimeAsync(1_500);
		await settle();

		expect(patchedChannelIds()).not.toContain(A_CHANNEL_2);
		expect([...store.useLog.keys()]).toEqual([B_CHANNEL_1]);
	});

	it('keeps the previous account out of the next account when its READY carries no settings', async () => {
		const store = await createFrecencyStore(1_500);
		await signInAsAWithSyncedUse(store, 1_500);

		UserSettings.markSessionChanging();
		UserSettings.handleAccountTransition();
		setUser(ACCOUNT_B);
		UserSettings.handleGatewayReady(null, UserSettings.getSettingsEpoch());
		await settle();
		expect([...store.useLog.keys()]).toEqual([]);
		store.use(B_CHANNEL_2);
		await vi.advanceTimersByTimeAsync(1_500);
		await settle();

		expect(mocks.patch).not.toHaveBeenCalled();
		expect(remoteChannelIds()).toEqual([B_CHANNEL_2]);
		const stored = decodeSyncedPreferencesLenient(AppStorage.getItem('UserSettings:syncedPreferencesLocal'));
		expect(Object.keys(stored.channelFrecency?.usage ?? {})).not.toContain(A_CHANNEL_1);
	});

	it('does not carry the previous account into preferences another tab stored for the next account', async () => {
		const store = await createFrecencyStore(1_500);
		await signInAsAWithSyncedUse(store, 1_500);

		UserSettings.markSessionChanging();
		UserSettings.handleAccountTransition();
		setUser(ACCOUNT_B);
		AppStorage.setItem(
			'UserSettings:syncedPreferencesLocal',
			encodeSyncedPreferences(serverPreferences({channels: [B_CHANNEL_2]})),
		);
		window.dispatchEvent(new StorageEvent('storage', {key: null, storageArea: window.localStorage}));
		await settle();
		gatewayReady(serverPreferences({channels: [B_CHANNEL_1]}));
		await settle();
		await vi.advanceTimersByTimeAsync(1_500);
		await settle();

		expect(patchedChannelIds()).not.toContain(A_CHANNEL_1);
		expect(remoteChannelIds()).not.toContain(A_CHANNEL_1);
		const stored = decodeSyncedPreferencesLenient(AppStorage.getItem('UserSettings:syncedPreferencesLocal'));
		expect(Object.keys(stored.channelFrecency?.usage ?? {})).not.toContain(A_CHANNEL_1);
	});

	it('leaves stored synced state of the next account in place when it hydrates', async () => {
		setUser(ACCOUNT_A);
		gatewayReady(serverPreferences({channels: [A_CHANNEL_1]}));
		await settle();
		UserSettings.markSessionChanging();
		UserSettings.handleAccountTransition();
		setUser(ACCOUNT_B);
		AppStorage.setJSON('UserSettings:syncedPreferencesDirtyFields', ['sanitizeUrls']);

		gatewayReady(serverPreferences({channels: [B_CHANNEL_1]}));
		await settle();

		expect(AppStorage.getJSON('UserSettings:syncedPreferencesDirtyFields', [])).toEqual(['sanitizeUrls']);
	});
});

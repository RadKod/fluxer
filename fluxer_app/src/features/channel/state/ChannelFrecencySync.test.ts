// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {create} from '@bufbuild/protobuf';
import {ChannelFrecencyStateSchema} from '@fluxer/schema/src/gen/fluxer/user/preferences/v1/preferences_pb';
import {observable, runInAction} from 'mobx';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({patch: vi.fn()}));
const navigation = observable({guildId: null as string | null, channelId: null as string | null});
const mediaEngine = observable({guildId: null as string | null, channelId: null as string | null});

vi.mock('@lingui/core/macro', () => ({
	msg: (descriptor: unknown) => descriptor,
	t: (descriptor: unknown) => descriptor,
}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({
	http: {get: vi.fn(), post: vi.fn(), patch: mocks.patch},
}));
vi.mock('@app/features/channel/state/Channels', () => ({
	default: {getChannel: () => undefined, getPrivateChannels: () => []},
}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {getGuild: () => undefined}}));
vi.mock('@app/features/threads/state/ThreadGuilds', () => ({default: {isActive: () => false, guildIds: []}}));
vi.mock('@app/features/app/state/Initialization', () => ({default: {hasCompletedInitialLoad: true}}));
vi.mock('@app/features/navigation/state/Navigation', () => ({default: navigation}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({default: mediaEngine}));

const SYNC_INTERVAL_MS = 10 * 60_000;
const USER = '1400000000000000000';
const GUILD = '1500000000000000000';

vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']});

// Idle and LocalPresence import each other; loading Idle first keeps its timer from calling a half-loaded store.
await import('@app/features/ui/state/Idle');
const {default: UserSettings} = await import('@app/features/user/state/UserSettings');
const {setSyncedFieldSessionManager} = await import('@app/features/user/state/SyncedField');
const {decodeSyncedPreferencesLenient, encodeSyncedPreferences} = await import(
	'@app/features/user/state/SyncedPreferencesEngine'
);

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await Promise.resolve();
	}
	await vi.advanceTimersByTimeAsync(0);
}

const SETTINGS = {
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
};

mocks.patch.mockResolvedValue({ok: true, status: 200, body: {}});
UserSettings.updateUserSettings(SETTINGS, {settingsEpoch: UserSettings.getSettingsEpoch()});
setSyncedFieldSessionManager({userId: USER});
const {default: ChannelFrecency} = await import('@app/features/channel/state/ChannelFrecency');

function channelId(n: number): string {
	return (1_500_000_000_000_000_100n + BigInt(n)).toString();
}

function select(id: string | null, guildId: string | null = GUILD): void {
	runInAction(() => {
		navigation.guildId = guildId;
		navigation.channelId = id;
	});
}

async function drainPendingSync(): Promise<void> {
	await settle();
	await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
	await settle();
}

function patchedFrecencyIds(callIndex: number): Array<string> {
	const body = mocks.patch.mock.calls[callIndex]?.[1]?.body as {synced_preferences: string | null};
	return Object.keys(decodeSyncedPreferencesLenient(body.synced_preferences).channelFrecency?.usage ?? {});
}

describe('channel frecency server sync', () => {
	beforeEach(async () => {
		await drainPendingSync();
		select(null, null);
		runInAction(() => {
			ChannelFrecency.useLog = new Map();
		});
		await drainPendingSync();
		await vi.advanceTimersByTimeAsync(61_000);
		mocks.patch.mockReset();
		mocks.patch.mockResolvedValue({ok: true, status: 200, body: {}});
	});

	it('updates local ranking on selection without waiting for the server write', () => {
		const channel = channelId(1);
		select(channel);
		expect(ChannelFrecency.useLog.has(channel)).toBe(true);
		expect(ChannelFrecency.scoreFor(channel)).toBeGreaterThan(0);
		expect(mocks.patch).not.toHaveBeenCalled();
	});

	it('sends many channel selections as a single settings write per sync interval', async () => {
		const channels = Array.from({length: 20}, (_, i) => channelId(i));
		for (const channel of channels) {
			select(channel);
			await vi.advanceTimersByTimeAsync(20_000);
		}
		await settle();
		expect(mocks.patch).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
		await settle();
		expect(mocks.patch).toHaveBeenCalledTimes(1);
		expect(patchedFrecencyIds(0)).toEqual(expect.arrayContaining(channels));
	});

	it('writes on schedule while selections never pause', async () => {
		const channels = Array.from({length: 36}, (_, i) => channelId(i));
		for (const [index, channel] of channels.entries()) {
			select(channel);
			await vi.advanceTimersByTimeAsync(20_000);
			if (index === 29) {
				await settle();
				expect(mocks.patch).toHaveBeenCalledTimes(1);
				expect(patchedFrecencyIds(0)).toEqual(expect.arrayContaining(channels.slice(0, 30)));
			}
		}
		await settle();
		expect(mocks.patch).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
		await settle();
		expect(mocks.patch).toHaveBeenCalledTimes(2);
		expect(patchedFrecencyIds(1)).toEqual(expect.arrayContaining(channels));
	});

	it('writes another synced preference immediately while frecency waits', async () => {
		const channel = channelId(1);
		select(channel);
		const saved = UserSettings.setSanitizeUrls(!UserSettings.getSanitizeUrls());
		await settle();
		await expect(saved).resolves.toBeUndefined();
		expect(mocks.patch).toHaveBeenCalledTimes(1);
		expect(patchedFrecencyIds(0)).not.toContain(channel);
		await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
		await settle();
		expect(mocks.patch).toHaveBeenCalledTimes(2);
		expect(patchedFrecencyIds(1)).toContain(channel);
	});

	it('keeps pending selections when another device updates frecency', async () => {
		const local = channelId(1);
		const remote = channelId(2);
		select(local);
		const incoming = decodeSyncedPreferencesLenient(encodeSyncedPreferences(UserSettings.syncedPreferences));
		incoming.channelFrecency = create(ChannelFrecencyStateSchema, {
			usage: {
				...incoming.channelFrecency?.usage,
				[remote]: {totalUses: 1, recentUsesMs: [BigInt(Date.now())]},
			},
		});
		UserSettings.updateUserSettings(
			{...SETTINGS, synced_preferences: encodeSyncedPreferences(incoming)},
			{settingsEpoch: UserSettings.getSettingsEpoch()},
		);
		await settle();
		expect(ChannelFrecency.useLog.has(local)).toBe(true);
		expect(ChannelFrecency.useLog.has(remote)).toBe(true);
		await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
		await settle();
		expect(mocks.patch).toHaveBeenCalledTimes(1);
		expect(patchedFrecencyIds(0)).toEqual(expect.arrayContaining([local, remote]));
	});
});

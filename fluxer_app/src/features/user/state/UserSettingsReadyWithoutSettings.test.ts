// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {create} from '@bufbuild/protobuf';
import {
	FriendSourceFlags,
	GroupDmAddPermissionFlags,
	IncomingCallFlags,
	ProfilePrivacyLevels,
	SensitiveMediaFilterLevel,
	ThemeTypes,
	TimeFormatTypes,
} from '@fluxer/constants/src/UserConstants';
import {GuildNsfwAgreementsSchema} from '@fluxer/schema/src/gen/fluxer/user/preferences/v1/preferences_pb';
import {i18n} from '@lingui/core';
import {observable, runInAction} from 'mobx';
import {afterEach, beforeEach, describe, expect, expectTypeOf, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({patch: vi.fn()}));
const ACCOUNT_A = '1100000000000000001';
const ACCOUNT_B = '2200000000000000002';
const A_GUILD = '1100000000000000031';
const A_CATEGORY = '1100000000000000032';
const A_CHANNEL = '1100000000000000033';
const A_GUILD_2 = '1100000000000000034';
const B_GUILD = '2200000000000000041';
const matureGuild = vi.hoisted(() => ({nsfw: true, contentWarningLevel: 0, contentWarningText: null}));

vi.mock('@lingui/core/macro', () => ({
	msg: (descriptor: unknown) => descriptor,
	t: (descriptor: unknown) => descriptor,
}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({
	http: {get: vi.fn(), post: vi.fn(), patch: mocks.patch},
}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {getChannel: () => undefined}}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {getUser: () => undefined, cacheUsers: () => {}, getCurrentUser: () => ({matureContentAllowed: true})},
}));
vi.mock('@app/features/guild/state/Guilds', () => ({
	default: {getGuild: (id: string) => ({...matureGuild, id})},
}));
vi.mock('@app/features/app/state/GeoIP', () => ({default: {ageRestrictedGeos: []}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {mockMatureContentGateReason: 'none'}}));
vi.mock('@app/features/moderation/utils/MatureContentGeoUtils', () => ({
	getEffectiveMatureContentGeoContext: () => ({countryCode: null, regionCode: null}),
}));

const session = observable({userId: null as string | null});
const {setSyncedFieldSessionManager} = await import('@app/features/user/state/SyncedField');
setSyncedFieldSessionManager(session);
// Idle and LocalPresence import each other; loading Idle first keeps its timer from calling a half-loaded store.
await import('@app/features/ui/state/Idle');
const {default: UserSettings} = await import('@app/features/user/state/UserSettings');
const {loadLocaleCatalog} = await import('@app/app/I18n');
const {default: AppStorage} = await import('@app/features/platform/state/PersistentStorage');
const {encodeSyncedPreferences, createEmptySyncedPreferences, decodeSyncedPreferencesLenient} = await import(
	'@app/features/user/state/SyncedPreferencesEngine'
);
const {default: GuildMatureContentAgree, MatureContentGateReason} = await import(
	'@app/features/guild/state/GuildMatureContentAgree'
);

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

function accountASettings() {
	const preferences = createEmptySyncedPreferences();
	preferences.guildNsfwAgreements = create(GuildNsfwAgreementsSchema, {
		agreedChannelIds: [A_CHANNEL],
		agreedCategoryIds: [A_CATEGORY],
		agreedGuildIds: [A_GUILD],
	});
	return {
		status: 'dnd',
		flags: 0,
		theme: 'light',
		locale: 'en-US',
		developer_mode: true,
		message_display_compact: true,
		time_format: TimeFormatTypes.TWENTY_FOUR_HOUR,
		afk_timeout: 60,
		restricted_guilds: [A_GUILD],
		bot_restricted_guilds: [A_GUILD],
		default_guilds_restricted: true,
		bot_default_guilds_restricted: true,
		friend_source_flags: FriendSourceFlags.MUTUAL_FRIENDS,
		incoming_call_flags: IncomingCallFlags.NOBODY,
		group_dm_add_permission_flags: GroupDmAddPermissionFlags.NOBODY,
		profile_privacy: ProfilePrivacyLevels.FRIENDS_ONLY,
		default_share_voice_activity: false,
		default_hide_muted_channels: true,
		sensitive_content_friend_dm_filter: SensitiveMediaFilterLevel.SHOW,
		sensitive_content_non_friend_dm_filter: SensitiveMediaFilterLevel.SHOW,
		sensitive_content_guild_filter: SensitiveMediaFilterLevel.SHOW,
		suppress_unprivileged_self_mentions: true,
		guild_folders: [{id: 1, name: 'A private folder', color: 1, flags: 0, guild_ids: [A_GUILD]}],
		custom_status: {text: 'A is away'},
		trusted_domains: ['a.example'],
		staff_dm_access_user_ids: [ACCOUNT_B],
		suppress_unprivileged_self_mentions_bypass_user_ids: [],
		synced_preferences: encodeSyncedPreferences(preferences),
	};
}

function accountBSettings() {
	return {
		...accountASettings(),
		status: 'online',
		restricted_guilds: [B_GUILD],
		guild_folders: [],
		custom_status: null,
		synced_preferences: '',
	};
}

async function switchFromAToBWhoseReadyHasNoSettings(): Promise<void> {
	setUser(ACCOUNT_A);
	UserSettings.handleGatewayReady(accountASettings(), UserSettings.getSettingsEpoch());
	await settle();
	UserSettings.markSessionChanging();
	UserSettings.handleAccountTransition();
	setUser(ACCOUNT_B);
	UserSettings.handleGatewayReady(null, UserSettings.getSettingsEpoch());
	await settle();
}

describe('a READY whose user settings are null', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mocks.patch.mockResolvedValue({ok: true, status: 200, body: {}});
	});

	afterEach(() => {
		UserSettings.handleAccountTransition();
		setUser(null);
		mocks.patch.mockReset();
		vi.useRealTimers();
	});

	it('does not let the next account pass the mature content gate with the previous account consent', async () => {
		setUser(ACCOUNT_A);
		UserSettings.handleGatewayReady(accountASettings(), UserSettings.getSettingsEpoch());
		await settle();
		expect(GuildMatureContentAgree.getGateReason({guildId: A_GUILD})).toBe(MatureContentGateReason.NONE);

		UserSettings.markSessionChanging();
		UserSettings.handleAccountTransition();
		setUser(ACCOUNT_B);
		UserSettings.handleGatewayReady(null, UserSettings.getSettingsEpoch());
		await settle();

		expect(GuildMatureContentAgree.getGateReason({guildId: A_GUILD})).toBe(MatureContentGateReason.CONSENT_REQUIRED);
		expect(GuildMatureContentAgree.hasAgreedToGuild(A_GUILD)).toBe(false);
		expect(GuildMatureContentAgree.hasAgreedToCategory(A_CATEGORY)).toBe(false);
		expect(GuildMatureContentAgree.hasAgreedToChannel(A_CHANNEL)).toBe(false);
		const sentAgreements = mocks.patch.mock.calls.flatMap(([, options]) => {
			const body = (options as {body: {synced_preferences?: string | null}}).body;
			const agreements = decodeSyncedPreferencesLenient(body.synced_preferences ?? null).guildNsfwAgreements;
			return [
				...(agreements?.agreedGuildIds ?? []),
				...(agreements?.agreedCategoryIds ?? []),
				...(agreements?.agreedChannelIds ?? []),
			];
		});
		expect(sentAgreements).toEqual([]);
	});

	it('hydrates the next account with defaults instead of the previous account settings', async () => {
		await switchFromAToBWhoseReadyHasNoSettings();

		expect.soft(UserSettings.getRestrictedGuilds()).toEqual([]);
		expect.soft(UserSettings.getBotRestrictedGuilds()).toEqual([]);
		expect.soft(UserSettings.getGuildFolders().flatMap((folder) => folder.guildIds)).not.toContain(A_GUILD);
		expect.soft(UserSettings.getGuildFolders().map((folder) => folder.name)).not.toContain('A private folder');
		expect.soft(UserSettings.getCustomStatus()).toBeNull();
		expect.soft(UserSettings.getStatus()).toBe('online');
		expect.soft(UserSettings.getDeveloperMode()).toBe(false);
		expect.soft(UserSettings.getTrustedDomains()).toEqual([]);
		expect.soft(UserSettings.isHydrated()).toBe(true);
		expect.soft(UserSettings.isAccountReleased()).toBe(false);
	});

	it('shows what the server enforces for an account without a settings record', async () => {
		await switchFromAToBWhoseReadyHasNoSettings();

		expect.soft(UserSettings.getIncomingCallFlags()).toBe(IncomingCallFlags.EVERYONE);
		expect
			.soft(UserSettings.getFriendSourceFlags())
			.toBe(FriendSourceFlags.NO_RELATION | FriendSourceFlags.MUTUAL_FRIENDS | FriendSourceFlags.MUTUAL_GUILDS);
		expect.soft(UserSettings.getGroupDmAddPermissionFlags()).toBe(GroupDmAddPermissionFlags.EVERYONE);
		expect.soft(UserSettings.getDefaultGuildsRestricted()).toBe(false);
		expect.soft(UserSettings.getBotDefaultGuildsRestricted()).toBe(false);
		expect.soft(UserSettings.getProfilePrivacy()).toBe(ProfilePrivacyLevels.ALL_GUILDS);
		expect.soft(UserSettings.getGameActivityVisibility()).toBe('off');
		expect.soft(UserSettings.getDefaultShareVoiceActivity()).toBe(true);
		expect.soft(UserSettings.getSuppressUnprivilegedSelfMentions()).toBe(false);
		expect.soft(UserSettings.getStaffDmAccessUserIds()).toEqual([]);
		expect.soft(UserSettings.getDefaultHideMutedChannels()).toBe(false);
	});

	it('applies the conservative defaults to settings the client enforces itself', async () => {
		await switchFromAToBWhoseReadyHasNoSettings();

		expect.soft(UserSettings.getSensitiveContentFriendDmFilter()).toBe(SensitiveMediaFilterLevel.BLUR);
		expect.soft(UserSettings.getSensitiveContentNonFriendDmFilter()).toBe(SensitiveMediaFilterLevel.BLOCK);
		expect.soft(UserSettings.getSensitiveContentGuildFilter()).toBe(SensitiveMediaFilterLevel.BLUR);
		expect.soft(UserSettings.theme).toBe(ThemeTypes.COAL);
		expect.soft(UserSettings.getTimeFormat()).toBe(TimeFormatTypes.AUTO);
		expect.soft(UserSettings.getAfkTimeout()).toBe(600);
		expect.soft(UserSettings.messageDisplayCompact).toBe(false);
	});

	it('keeps the active interface language when the READY carries no settings', async () => {
		await loadLocaleCatalog('tr');
		AppStorage.setItem('locale', 'tr');
		setUser(ACCOUNT_B);

		UserSettings.handleGatewayReady(null, UserSettings.getSettingsEpoch());
		await settle();

		expect(UserSettings.isHydrated()).toBe(true);
		expect(UserSettings.getLocale()).toBe('tr');
		expect(i18n.locale).toBe('tr');
		expect(AppStorage.getItem('locale')).toBe('tr');
	});

	it('keeps a requested interface language whose catalog is still loading', async () => {
		await loadLocaleCatalog('tr');
		setUser(ACCOUNT_B);

		const loading = loadLocaleCatalog('de');
		UserSettings.handleGatewayReady(null, UserSettings.getSettingsEpoch());
		await loading;
		await settle();

		expect(i18n.locale).toBe('de');
		expect(UserSettings.getLocale()).toBe('de');
	});

	it('does not send synced preferences of an account without a settings record until one arrives', async () => {
		setUser(ACCOUNT_B);
		UserSettings.handleGatewayReady(null, UserSettings.getSettingsEpoch());
		await settle();
		let saved = false;
		void UserSettings.setSanitizeUrls(true).then(() => {
			saved = true;
		});
		await settle();
		expect(saved).toBe(true);
		expect(mocks.patch).not.toHaveBeenCalled();

		UserSettings.updateUserSettings(accountBSettings(), {settingsEpoch: UserSettings.getSettingsEpoch()});
		await settle();

		const sentSanitizeUrls = mocks.patch.mock.calls.map(
			([, options]) =>
				decodeSyncedPreferencesLenient(
					(options as {body: {synced_preferences?: string | null}}).body.synced_preferences ?? null,
				).sanitizeUrls,
		);
		expect(sentSanitizeUrls).toContain(true);
	});

	it('rolls a failed save back when a failed switch restored the same account', async () => {
		setUser(ACCOUNT_A);
		UserSettings.handleGatewayReady(accountASettings(), UserSettings.getSettingsEpoch());
		await settle();
		let failSave: (error: Error) => void = () => {};
		mocks.patch.mockImplementationOnce(
			() =>
				new Promise((_, reject) => {
					failSave = reject;
				}),
		);
		const save = UserSettings.saveSettings({restrictedGuilds: [A_GUILD, A_GUILD_2]});

		const checkpoint = UserSettings.captureAccountTransitionCheckpoint();
		UserSettings.handleAccountTransition();
		const restored = UserSettings.restoreAccountTransitionCheckpoint(checkpoint);
		await settle();
		await restored;
		failSave(new Error('rejected by the server'));

		await expect(save).rejects.toThrow('rejected by the server');
		expect(UserSettings.getRestrictedGuilds()).toEqual([A_GUILD]);
	});

	it('does not hydrate the next account from a null READY of the outgoing session', async () => {
		setUser(ACCOUNT_A);
		UserSettings.handleGatewayReady(accountASettings(), UserSettings.getSettingsEpoch());
		await settle();
		const outgoing = UserSettings.getSettingsEpoch();
		UserSettings.markSessionChanging();
		UserSettings.handleAccountTransition();
		setUser(ACCOUNT_B);

		UserSettings.handleGatewayReady(null, outgoing);
		await settle();

		expect(UserSettings.isHydrated()).toBe(false);
		expect(UserSettings.isAccountReleased()).toBe(true);
	});

	it('does not roll a failed save of the previous account back onto the next account', async () => {
		setUser(ACCOUNT_A);
		UserSettings.handleGatewayReady(accountASettings(), UserSettings.getSettingsEpoch());
		await settle();
		let failSave: (error: Error) => void = () => {};
		mocks.patch.mockImplementationOnce(
			() =>
				new Promise((_, reject) => {
					failSave = reject;
				}),
		);
		const save = UserSettings.saveSettings({restrictedGuilds: [A_GUILD, A_GUILD_2]});

		UserSettings.markSessionChanging();
		UserSettings.handleAccountTransition();
		setUser(ACCOUNT_B);
		UserSettings.handleGatewayReady(accountBSettings(), UserSettings.getSettingsEpoch());
		failSave(new Error('cancelled by the account switch'));

		await expect(save).rejects.toThrow('cancelled by the account switch');
		expect(UserSettings.getRestrictedGuilds()).toEqual([B_GUILD]);
	});

	it('keeps the previous account server ids out of a bulk privacy change on the next account', async () => {
		await switchFromAToBWhoseReadyHasNoSettings();
		mocks.patch.mockClear();

		// Same computation as the bulk "disallow DMs" action in BulkSettingsMenuItems, which saves through
		// UserSettingsCommands.update and from there UserSettings.saveSettings.
		const nextRestrictedGuilds = new Set(UserSettings.restrictedGuilds);
		nextRestrictedGuilds.add(B_GUILD);
		await UserSettings.saveSettings({restrictedGuilds: Array.from(nextRestrictedGuilds)});

		const restrictedGuildBodies = mocks.patch.mock.calls
			.map(([, options]) => (options as {body: {restricted_guilds?: Array<string>}}).body.restricted_guilds)
			.filter((value) => value !== undefined);
		expect(restrictedGuildBodies).toEqual([[B_GUILD]]);
	});

	it('requires the settings epoch from every hydrating settings source at compile time', () => {
		type UpdateOptions = Parameters<typeof UserSettings.updateUserSettings>[1];
		expectTypeOf(UserSettings.handleGatewayReady).parameters.toEqualTypeOf<[unknown, number | null]>();
		expectTypeOf<{fields: Array<'theme'>}>().not.toExtend<UpdateOptions>();
		expectTypeOf<{hydrate: true}>().not.toExtend<UpdateOptions>();
		expectTypeOf<{hydrate: false; settingsEpoch: number}>().not.toExtend<UpdateOptions>();
		expectTypeOf<{settingsEpoch: number | null}>().toExtend<UpdateOptions>();
		expectTypeOf<{hydrate: false; fields: Array<'theme'>}>().toExtend<UpdateOptions>();
	});
});

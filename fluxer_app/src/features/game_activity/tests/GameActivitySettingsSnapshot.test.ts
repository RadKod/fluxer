// SPDX-License-Identifier: AGPL-3.0-or-later

import {type ProfilePrivacyLevel, ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({accountId: 'account'}));
const http = vi.hoisted(() => ({patch: vi.fn(), get: vi.fn()}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {
		get currentUser() {
			return {id: state.accountId, publicProfileAllowed: true, bot: false};
		},
	},
}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http}));
vi.mock('@app/app/I18n', () => ({applyLocaleChange: (locale: string) => locale}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({
	default: {},
	setAccessibilityUserSettings: vi.fn(),
}));
vi.mock('@app/features/platform/state/PersistentStorage', () => ({
	default: {
		getItem: () => null,
		getJSON: (_: string, value: unknown) => value,
		setItem: vi.fn(),
		setJSON: vi.fn(),
		removeItem: vi.fn(),
		subscribe: vi.fn(),
	},
}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		static refreshGlobalLogLevel() {}
		debug() {}
		warn() {}
		error() {}
	},
}));
vi.mock('@app/features/theme/state/Theme', () => ({default: {updateServerTheme: vi.fn()}}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {isMobileLayout: () => false}}));
vi.mock('@app/features/ui/state/Idle', () => ({
	default: {getIdleSince: () => 0, setAfkTimeoutMs: () => {}, isAfk: () => false, isIdle: () => false},
}));
vi.mock('@app/features/platform/utils/DeferUntilModulesLoaded', () => ({deferUntilModulesLoaded: vi.fn()}));
vi.mock('@app/features/expressions/utils/UnicodeEmojis', () => ({
	default: {normalizeEmojiNameToSurrogate: (name: string) => name},
}));

const {default: UserSettings} = await import('@app/features/user/state/UserSettings');
const {default: LocalPresence} = await import('@app/features/presence/state/LocalPresence');
const {default: Sharing} = await import('@app/features/game_activity/state/GameActivitySettings');
const {default: Bridge} = await import('@app/features/game_activity/utils/DesktopGameActivityBridge');
const {default: GameActivityStore} = await import('@app/features/game_activity/state/GameActivityStore');
const Commands = await import('@app/features/user/commands/UserSettingsCommands');

const baseline = {
	flags: 0,
	status: 'online',
	status_resets_at: null,
	status_resets_to: null,
	theme: 'coal',
	time_format: 0,
	locale: 'en-US',
	restricted_guilds: [],
	bot_restricted_guilds: [],
	default_guilds_restricted: false,
	bot_default_guilds_restricted: false,
	inline_attachment_media: true,
	inline_embed_media: true,
	gif_auto_play: true,
	render_embeds: true,
	render_reactions: true,
	animate_emoji: true,
	animate_stickers: 0,
	render_spoilers: 0,
	message_display_compact: false,
	developer_mode: false,
	friend_source_flags: 0,
	incoming_call_flags: 0,
	group_dm_add_permission_flags: 0,
	profile_privacy: ProfilePrivacyLevels.FRIENDS_ONLY,
	default_share_voice_activity: true,
	game_activity_visibility: 'friends',
	guild_folders: [],
	custom_status: null,
	afk_timeout: 600,
	trusted_domains: [],
	default_hide_muted_channels: false,
	sensitive_content_friend_dm_filter: 0,
	sensitive_content_non_friend_dm_filter: 0,
	sensitive_content_guild_filter: 0,
	suppress_unprivileged_self_mentions: false,
	suppress_unprivileged_self_mentions_bypass_user_ids: [],
	staff_dm_access_user_ids: [],
	synced_preferences: '',
};

type SettingsResponse = Omit<typeof baseline, 'profile_privacy'> & {profile_privacy: ProfilePrivacyLevel};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((ok) => {
		resolve = ok;
	});
	return {promise, resolve};
}

describe('game sharing replies with the real settings store', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		GameActivityStore.handleRollout({game_activity_enabled: true, game_activity_epoch: 1});
		state.accountId = 'account';
		UserSettings.handleAccountTransition();
		UserSettings.updateUserSettings(baseline, {settingsEpoch: UserSettings.getSettingsEpoch()});
		Sharing.setSharingUnconfirmed('account', false);
		Bridge.initialize({
			getPresence: () => LocalPresence.getPresence(),
			getEnabled: () => Sharing.getEffectiveSharing(),
		});
		await Bridge.setAccount('account');
		http.patch.mockResolvedValue({body: baseline});
	});
	afterEach(async () => {
		await Bridge.setAccount(null);
	});
	const beginSave = async (path: string) => {
		const pending = deferred<{body: SettingsResponse}>();
		const requested: SettingsResponse = {...baseline, profile_privacy: ProfilePrivacyLevels.EVERYONE};
		if (path === 'fallback') {
			http.patch.mockRejectedValueOnce(new Error('Reply lost'));
			http.get.mockReturnValueOnce(pending.promise);
		} else http.patch.mockReturnValueOnce(pending.promise);
		const saving = (
			path === 'profile'
				? Commands.update({profilePrivacy: ProfilePrivacyLevels.EVERYONE})
				: Commands.updateGameActivityVisibility('friends')
		).then(
			() => 'success',
			(error: Error) => error.message,
		);
		await vi.waitFor(() => expect(path === 'fallback' ? http.get : http.patch).toHaveBeenCalled());
		return {saving, resolve: (body: SettingsResponse = requested) => pending.resolve({body})};
	};
	it.each(['profile', 'visibility', 'fallback'])(
		'%s late full response preserves newer independent settings and presence',
		async (path) => {
			const pending = await beginSave(path);
			await Commands.update({
				status: 'invisible',
				customStatus: {
					text: 'new status',
					expiresAt: null,
					emojiId: null,
					emojiName: null,
				},
				locale: 'tr',
				developerMode: true,
			});
			expect(LocalPresence.getStatus()).toBe('invisible');
			pending.resolve();
			expect(await pending.saving).toBe(path === 'fallback' ? 'Reply lost' : 'success');
			expect(UserSettings.status).toBe('invisible');
			expect(LocalPresence.getStatus()).toBe('invisible');
			expect(UserSettings.getCustomStatus()?.text).toBe('new status');
			expect(LocalPresence.getPresence().custom_status?.text).toBe('new status');
			expect(UserSettings.locale).toBe('tr');
			expect(UserSettings.developerMode).toBe(true);
		},
	);
	it.each(['profile', 'visibility', 'fallback'])(
		'%s reply from an earlier account epoch cannot apply after A → B → A',
		async (path) => {
			const pending = await beginSave(path);
			state.accountId = 'other';
			UserSettings.handleAccountTransition();
			await Bridge.setAccount('other');
			state.accountId = 'account';
			UserSettings.handleAccountTransition();
			UserSettings.updateUserSettings(
				{
					...baseline,
					game_activity_visibility: 'off',
					profile_privacy: ProfilePrivacyLevels.ONLY_ME,
				},
				{settingsEpoch: UserSettings.getSettingsEpoch()},
			);
			await Bridge.setAccount('account');
			pending.resolve();
			expect(await pending.saving).toBe(
				path === 'fallback' ? 'Reply lost' : 'Account changed while saving game sharing',
			);
			expect(UserSettings.getProfilePrivacy()).toBe(ProfilePrivacyLevels.ONLY_ME);
			expect(UserSettings.getGameActivityVisibility()).toBe('off');
			expect(Sharing.getEffectiveSharing()).toBe(false);
		},
	);
	it.each(['profile', 'visibility', 'fallback'])(
		'%s reply does not hydrate settings that have not loaded yet',
		async (path) => {
			UserSettings.handleAccountTransition();
			const pending = await beginSave(path);
			pending.resolve();
			await pending.saving;
			expect(UserSettings.isHydrated()).toBe(false);
		},
	);
	it('profile reply preserves an authoritative secondary visibility restriction', async () => {
		const pending = await beginSave('profile');
		pending.resolve({...baseline, profile_privacy: ProfilePrivacyLevels.EVERYONE, game_activity_visibility: 'off'});
		expect(await pending.saving).toBe('success');
		expect(UserSettings.getGameActivityVisibility()).toBe('off');
		expect(Sharing.getEffectiveSharing()).toBe(false);
	});
	it.each(['visibility', 'fallback'])(
		'%s reply preserves an authoritative secondary Only me restriction',
		async (path) => {
			const pending = await beginSave(path);
			pending.resolve({...baseline, profile_privacy: ProfilePrivacyLevels.ONLY_ME});
			expect(await pending.saving).toBe(path === 'fallback' ? 'Reply lost' : 'success');
			expect(UserSettings.getProfilePrivacy()).toBe(ProfilePrivacyLevels.ONLY_ME);
			expect(Sharing.getEffectiveSharing()).toBe(false);
		},
	);
});

describe('game sharing default and eligibility with the real settings store', () => {
	const eligibleEveryone = {
		...baseline,
		game_activity_visibility: 'everyone',
		game_activity_eligible: true,
		game_activity_default_pending: false,
	};
	beforeEach(() => {
		vi.clearAllMocks();
		GameActivityStore.handleRollout({game_activity_enabled: true, game_activity_epoch: 1});
		state.accountId = 'account';
		UserSettings.handleAccountTransition();
		Sharing.setSharingUnconfirmed('account', false);
	});
	const hydrate = (settings: object) =>
		UserSettings.updateUserSettings(settings, {settingsEpoch: UserSettings.getSettingsEpoch()});

	it('hydrate keeps everyone and reads eligibility and the pending default', () => {
		hydrate({...eligibleEveryone, game_activity_default_pending: true});
		expect(UserSettings.getGameActivityVisibility()).toBe('everyone');
		expect(UserSettings.getGameActivityEligible()).toBe(true);
		expect(UserSettings.getGameActivityDefaultPending()).toBe(true);
		expect(Sharing.getEffectiveSharing()).toBe(true);
	});

	it('missing eligibility from an older server fails closed', () => {
		hydrate({...baseline, game_activity_visibility: 'everyone'});
		expect(UserSettings.getGameActivityEligible()).toBe(false);
		expect(UserSettings.getGameActivityDefaultPending()).toBe(false);
		expect(Sharing.getEffectiveSharing()).toBe(false);
	});

	it('unknown visibility hydrates as off', () => {
		hydrate({...eligibleEveryone, game_activity_visibility: 'strangers'});
		expect(UserSettings.getGameActivityVisibility()).toBe('off');
	});

	it('an unrelated settings save keeps eligibility and the pending default', async () => {
		hydrate({...eligibleEveryone, game_activity_default_pending: true});
		http.patch.mockResolvedValueOnce({body: {}});
		await Commands.update({developerMode: true});
		expect(UserSettings.getGameActivityEligible()).toBe(true);
		expect(UserSettings.getGameActivityDefaultPending()).toBe(true);
		expect(UserSettings.getGameActivityVisibility()).toBe('everyone');
	});

	it('account transition clears eligibility and the pending default', () => {
		hydrate({...eligibleEveryone, game_activity_default_pending: true});
		UserSettings.handleAccountTransition();
		expect(UserSettings.getGameActivityEligible()).toBe(false);
		expect(UserSettings.getGameActivityDefaultPending()).toBe(false);
	});

	it('default acknowledgement applies the server confirmation', async () => {
		hydrate({
			...baseline,
			game_activity_visibility: 'off',
			game_activity_eligible: true,
			game_activity_default_pending: true,
		});
		http.patch.mockResolvedValueOnce({body: eligibleEveryone});
		await Commands.acknowledgeGameActivityDefault();
		expect(http.patch).toHaveBeenCalledWith(expect.anything(), {body: {game_activity_default_acknowledged: true}});
		expect(UserSettings.getGameActivityDefaultPending()).toBe(false);
		expect(UserSettings.getGameActivityVisibility()).toBe('everyone');
		expect(Sharing.getEffectiveSharing()).toBe(true);
	});

	it('failed default acknowledgement keeps the notice pending', async () => {
		hydrate({
			...baseline,
			game_activity_visibility: 'off',
			game_activity_eligible: true,
			game_activity_default_pending: true,
		});
		http.patch.mockRejectedValueOnce(new Error('503'));
		await expect(Commands.acknowledgeGameActivityDefault()).rejects.toThrow('503');
		expect(UserSettings.getGameActivityDefaultPending()).toBe(true);
		expect(UserSettings.getGameActivityVisibility()).toBe('off');
	});

	it.each(['pending', 'complete'])('late default acknowledgement preserves a %s visibility save', async (phase) => {
		hydrate({
			...baseline,
			game_activity_visibility: 'off',
			game_activity_eligible: true,
			game_activity_default_pending: true,
		});
		const acknowledgement = deferred<{body: typeof eligibleEveryone}>();
		const visibility = deferred<{body: typeof eligibleEveryone}>();
		http.patch.mockReturnValueOnce(acknowledgement.promise).mockReturnValueOnce(visibility.promise);
		const ack = Commands.acknowledgeGameActivityDefault();
		const save = Commands.updateGameActivityVisibility('off');
		await vi.waitFor(() => expect(http.patch).toHaveBeenCalledTimes(2));
		const confirmVisibility = () => visibility.resolve({body: {...eligibleEveryone, game_activity_visibility: 'off'}});
		if (phase === 'complete') {
			confirmVisibility();
			await save;
		}
		acknowledgement.resolve({body: eligibleEveryone});
		await ack;
		try {
			expect(UserSettings.getGameActivityVisibility()).toBe('off');
			expect(UserSettings.getGameActivityDefaultPending()).toBe(phase === 'pending');
			expect(Sharing.getEffectiveSharing()).toBe(false);
		} finally {
			if (phase === 'pending') {
				confirmVisibility();
				await save;
			}
		}
	});

	it('default acknowledgement reply from another account is ignored', async () => {
		hydrate({
			...baseline,
			game_activity_visibility: 'off',
			game_activity_eligible: true,
			game_activity_default_pending: true,
		});
		let resolve!: (value: unknown) => void;
		http.patch.mockReturnValueOnce(
			new Promise((ok) => {
				resolve = ok;
			}),
		);
		const ack = Commands.acknowledgeGameActivityDefault().then(
			() => 'success',
			(error: Error) => error.message,
		);
		state.accountId = 'other';
		UserSettings.handleAccountTransition();
		resolve({body: eligibleEveryone});
		expect(await ack).toContain('Account changed');
		expect(UserSettings.getGameActivityVisibility()).toBe('off');
	});
});

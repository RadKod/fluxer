// SPDX-License-Identifier: AGPL-3.0-or-later

import type {DesktopGameActivityState, ElectronAPI} from '@app/types/electron.d';
import {ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({accountId: 'account', epoch: 0, privacy: 0, visibility: 'friends'}));
const mocks = vi.hoisted(() => ({save: vi.fn(), patch: vi.fn(), apply: vi.fn()}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {
		get currentUser() {
			return {id: state.accountId, publicProfileAllowed: true, bot: false};
		},
	},
}));
vi.mock('@app/features/user/state/UserSettings', () => ({
	default: {
		getAccountEpoch: () => state.epoch,
		getProfilePrivacy: () => state.privacy,
		getGameActivityVisibility: () => state.visibility,
		getGameActivityEligible: () => true,
		isHydrated: () => true,
		saveSettings: mocks.save,
		updateUserSettings: mocks.apply,
	},
}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http: {patch: mocks.patch}}));
vi.mock('@app/features/platform/state/PersistentStorage', () => ({default: {getItem: () => null}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		warn() {}
	},
}));

const {default: Bridge} = await import('@app/features/game_activity/utils/DesktopGameActivityBridge');
const {default: Settings} = await import('@app/features/game_activity/state/GameActivitySettings');
const {default: GameActivityStore} = await import('@app/features/game_activity/state/GameActivityStore');
const Commands = await import('@app/features/user/commands/UserSettingsCommands');

describe('authoritative profile sharing transition', () => {
	let api: Partial<ElectronAPI>;
	let callback: ((value: DesktopGameActivityState) => void) | undefined;
	let sent: Array<unknown>;
	beforeEach(async () => {
		vi.useFakeTimers();
		GameActivityStore.handleRollout({game_activity_enabled: true, game_activity_epoch: 1});
		vi.clearAllMocks();
		state.accountId = 'account';
		state.epoch = 0;
		state.privacy = ProfilePrivacyLevels.FRIENDS_ONLY;
		state.visibility = 'friends';
		Settings.setSharingUnconfirmed('account', false);
		Settings.setSharingUnconfirmed('other-account', false);
		callback = undefined;
		sent = [];
		api = {
			gameActivityGetCapabilities: async () => ({version: 1, supported: true}),
			gameActivityConfigure: vi.fn(async () => ({state: 'ok' as const})),
			gameActivityGetState: async ({generation}) => ({generation, state: 'idle', activity: null, fresh: true}),
			onGameActivityState: (next) => {
				callback = next;
				return () => {
					callback = undefined;
				};
			},
		};
		Bridge.initialize({
			getApi: () => api,
			getPresence: () => ({status: 'online'}),
			getEnabled: () => Settings.getEffectiveSharing(),
			send: (value) => {
				sent.push(value);
				return true;
			},
		});
		mocks.save.mockImplementation(async ({profilePrivacy}: {profilePrivacy: number}) => {
			state.privacy = profilePrivacy;
			return {profile_privacy: profilePrivacy, game_activity_visibility: 'friends'};
		});
		mocks.apply.mockImplementation((body: {profile_privacy: number}) => {
			state.privacy = body.profile_privacy;
		});
		await Bridge.setAccount('account');
		await Bridge.refreshPolicy();
	});
	afterEach(async () => {
		await Bridge.setAccount(null);
		vi.useRealTimers();
	});
	const scan = () => {
		const generation = vi.mocked(api.gameActivityConfigure!).mock.calls.at(-1)![0].generation;
		callback?.({generation, state: 'playing', activity: {game_id: 'test-game', started_at: 1000}, fresh: true});
		vi.advanceTimersByTime(3000);
	};
	const holdSave = () => {
		let resolve!: (body: unknown) => void;
		let reject!: (error: Error) => void;
		mocks.save.mockImplementationOnce(({profilePrivacy}: {profilePrivacy: number}) => {
			state.privacy = profilePrivacy;
			return new Promise((ok, fail) => {
				resolve = ok;
				reject = fail;
			});
		});
		return {resolve: (body: unknown) => resolve(body), reject: (error: Error) => reject(error)};
	};
	const flush = async () => {
		for (let i = 0; i < 30; i++) await Promise.resolve();
	};
	it.each([ProfilePrivacyLevels.FRIENDS_ONLY, ProfilePrivacyLevels.EVERYONE])(
		'Only me → %s resumes only a fresh scan after the authoritative success',
		async (privacy) => {
			await Commands.update({profilePrivacy: ProfilePrivacyLevels.ONLY_ME});
			const pending = holdSave();
			const saving = Commands.update({profilePrivacy: privacy});
			await flush();
			await Bridge.syncPolicy();
			scan();
			expect(sent).toEqual([]);
			pending.resolve({profile_privacy: privacy, game_activity_visibility: 'friends'});
			await saving;
			expect(sent).toEqual([]);
			scan();
			expect(sent).toHaveLength(1);
		},
	);
	it('failed widening stays closed despite an optimistic open profile', async () => {
		await Commands.update({profilePrivacy: ProfilePrivacyLevels.ONLY_ME});
		const pending = holdSave();
		const saving = Commands.update({profilePrivacy: ProfilePrivacyLevels.EVERYONE});
		const result = saving.catch((error: Error) => error.message);
		await flush();
		pending.reject(new Error('Reply lost'));
		expect(await result).toBe('Reply lost');
		expect(Settings.getEffectiveSharing()).toBe(false);
		await Bridge.syncPolicy();
		scan();
		expect(sent).toEqual([]);
	});
	it('missing authoritative confirmation stays closed', async () => {
		await Commands.update({profilePrivacy: ProfilePrivacyLevels.ONLY_ME});
		mocks.save.mockResolvedValueOnce({});
		await expect(Commands.update({profilePrivacy: ProfilePrivacyLevels.EVERYONE})).rejects.toThrow('not confirmed');
		expect(Settings.getEffectiveSharing()).toBe(false);
	});
	it('old widening reply cannot unlock a newer Only me write', async () => {
		await Commands.update({profilePrivacy: ProfilePrivacyLevels.ONLY_ME});
		const pending = holdSave();
		const old = Commands.update({profilePrivacy: ProfilePrivacyLevels.EVERYONE}).then(
			() => 'success',
			(error: Error) => error.message,
		);
		await flush();
		await Commands.update({profilePrivacy: ProfilePrivacyLevels.ONLY_ME});
		pending.resolve({profile_privacy: ProfilePrivacyLevels.EVERYONE, game_activity_visibility: 'friends'});
		expect(await old).toContain('superseded');
		expect(state.privacy).toBe(ProfilePrivacyLevels.ONLY_ME);
		scan();
		expect(sent).toEqual([]);
	});
	it.each([false, true])(
		'account race cannot apply or unlock an old profile response, return=%s',
		async (returnToAccount) => {
			await Commands.update({profilePrivacy: ProfilePrivacyLevels.ONLY_ME});
			const pending = holdSave();
			const saving = Commands.update({profilePrivacy: ProfilePrivacyLevels.EVERYONE}).then(
				() => 'success',
				(error: Error) => error.message,
			);
			await flush();
			state.accountId = 'other-account';
			state.epoch++;
			await Bridge.setAccount(state.accountId);
			if (returnToAccount) {
				state.accountId = 'account';
				state.epoch++;
				await Bridge.setAccount(state.accountId);
			}
			mocks.apply.mockClear();
			pending.resolve({profile_privacy: ProfilePrivacyLevels.EVERYONE, game_activity_visibility: 'friends'});
			expect(await saving).toContain('Account changed');
			expect(mocks.apply).not.toHaveBeenCalled();
			if (returnToAccount) expect(Settings.getEffectiveSharing()).toBe(false);
		},
	);
});

// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = await vi.hoisted(async () => {
	const {observable} = await import('mobx');
	return observable({
		accountId: 'account',
		visibility: 'off',
		eligible: true as boolean | undefined,
		publicProfileAllowed: true,
		privacy: 0,
		supported: true,
		rolloutEnabled: true,
	});
});
const mocks = vi.hoisted(() => ({
	storage: new Map<string, string>(),
	update: vi.fn(),
	stop: vi.fn(),
	refresh: vi.fn(),
	sync: vi.fn(),
	listRules: vi.fn(),
	remove: vi.fn(),
	candidates: vi.fn(),
	add: vi.fn(),
	patch: vi.fn(),
	get: vi.fn(),
	apply: vi.fn(),
	persist: vi.fn(),
}));
vi.mock('@app/features/game_activity/state/GameActivityStore', () => ({
	default: {
		get enabled() {
			return state.rolloutEnabled;
		},
	},
}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/user/state/UserSettings', () => ({
	default: {
		getGameActivityVisibility: () => state.visibility,
		getGameActivityEligible: () => state.eligible === true,
		getProfilePrivacy: () => state.privacy,
		getAccountEpoch: () => 0,
		isHydrated: () => true,
		updateUserSettings: mocks.apply,
		saveSettings: mocks.persist,
	},
}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {
		get currentUser() {
			return {id: state.accountId, publicProfileAllowed: state.publicProfileAllowed, bot: false};
		},
	},
}));
vi.mock('@app/features/platform/state/PersistentStorage', () => ({
	default: {
		getItem: (key: string) => mocks.storage.get(key) ?? null,
		setItem: (key: string, value: string) => mocks.storage.set(key, value),
		removeItem: (key: string) => mocks.storage.delete(key),
	},
}));
vi.mock('@app/features/user/commands/UserSettingsCommands', () => ({updateGameActivityVisibility: mocks.update}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http: {patch: mocks.patch, get: mocks.get}}));
vi.mock('@app/features/game_activity/utils/DesktopGameActivityBridge', () => ({
	default: {
		get supported() {
			return state.supported;
		},
		stopSharing: mocks.stop,
		refreshPolicy: mocks.refresh,
		syncPolicy: mocks.sync,
		listRules: mocks.listRules,
		removeRule: mocks.remove,
		listCandidates: mocks.candidates,
		addRule: mocks.add,
	},
}));
vi.mock('@app/features/app/components/dialogs/shared/SettingsTabLayout', () => ({
	SettingsTabSection: ({title, children}: {title: ReactNode; children: ReactNode}) =>
		createElement('section', null, title, children),
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, submitting, ...props}: {children: ReactNode; submitting?: boolean}) =>
		createElement('button', {type: 'button', ...props}, children),
}));
vi.mock('@app/features/ui/radio_group/RadioGroup', () => ({
	RadioGroup: ({
		options,
		value,
		onChange,
	}: {
		options: Array<{value: string; name: string; disabled?: boolean}>;
		value: string;
		onChange: (value: string) => void;
	}) =>
		createElement(
			'div',
			null,
			options.map((option) =>
				createElement(
					'button',
					{
						type: 'button',
						key: option.value,
						role: 'radio',
						disabled: option.disabled,
						'aria-checked': value === option.value,
						onClick: () => onChange(option.value),
					},
					option.name,
				),
			),
		),
}));
vi.mock('@app/features/app/components/shared/ExternalLink', () => ({
	ExternalLink: ({children, href}: {children: ReactNode; href: string}) => createElement('a', {href}, children),
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {privacyUrl: 'https://micup.test/privacy', isSelfHosted: () => false},
}));
vi.mock('@app/app/Routes', () => ({Routes: {privacy: () => '/privacy'}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		warn() {}
	},
}));

const {default: GameActivitySettings, GameActivitySettingsState} = await import(
	'@app/features/game_activity/state/GameActivitySettings'
);
const {GameActivitySettingsTab} = await import('@app/features/game_activity/components/GameActivitySettingsTab');

describe('Game activity settings', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const button = (text: string) =>
		[...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)!;
	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		mocks.storage.clear();
		state.visibility = 'off';
		state.accountId = 'account';
		state.eligible = true;
		state.publicProfileAllowed = true;
		state.privacy = 0;
		state.supported = true;
		state.rolloutEnabled = true;
		GameActivitySettings.setSharingUnconfirmed('account', false);
		mocks.listRules.mockResolvedValue({state: 'ok', rules: [{rule_id: 'r', manual_name: 'My game'}]});
		mocks.remove.mockResolvedValue({state: 'ok'});
		mocks.refresh.mockResolvedValue(undefined);
		mocks.stop.mockResolvedValue(undefined);
		mocks.persist.mockResolvedValue(undefined);
		mocks.patch.mockResolvedValue({body: {game_activity_visibility: 'off'}});
		mocks.get.mockResolvedValue({body: {game_activity_visibility: 'friends'}});
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});
	const render = async () => act(async () => root.render(createElement(GameActivitySettingsTab)));
	it('hides every game control while rollout is disabled even with saved preferences', async () => {
		state.visibility = 'friends';
		mocks.storage.set('GameActivity:detection:account', 'true');
		state.rolloutEnabled = false;
		await render();
		expect(container.textContent).toBe('');
		expect(container.querySelector('button')).toBeNull();
		expect(mocks.listRules).not.toHaveBeenCalled();
		expect(mocks.candidates).not.toHaveBeenCalled();
	});
	it('three_options_and_no_detection_checkbox', async () => {
		state.visibility = 'everyone';
		mocks.storage.set('GameActivity:detection:account', 'false');
		await render();
		const radios = [...container.querySelectorAll('[role="radio"]')].map((item) => item.textContent);
		expect(radios).toEqual(['Off', 'Friends', 'Everyone']);
		expect(button('Everyone').getAttribute('aria-checked')).toBe('true');
		expect(container.querySelector('[role="checkbox"]')).toBeNull();
		expect(container.textContent).not.toContain('Detect games on this device');
		await act(async () => button('Friends').click());
		expect(mocks.update).toHaveBeenCalledWith('friends');
		await act(async () => button('Everyone').click());
		expect(mocks.update).toHaveBeenLastCalledWith('everyone');
		expect(mocks.storage.get('GameActivity:detection:account')).toBe('false');
	});
	it('detection preference no longer exists and old local keys are neither read nor removed', () => {
		const settings = new GameActivitySettingsState() as unknown as Record<string, unknown>;
		expect(settings.getDetectionEnabled).toBeUndefined();
		expect(settings.setDetectionEnabled).toBeUndefined();
		mocks.storage.set('GameActivity:detection:account', 'false');
		state.visibility = 'friends';
		expect(new GameActivitySettingsState().getEffectiveSharing()).toBe(true);
		expect(mocks.storage.get('GameActivity:detection:account')).toBe('false');
	});
	it('under15_unknown_cannot_enable', async () => {
		state.eligible = false;
		await render();
		expect(button('Friends').disabled).toBe(true);
		expect(button('Everyone').disabled).toBe(true);
		expect(button('Off').disabled).toBe(false);
		act(() => {
			state.eligible = undefined;
		});
		expect(button('Everyone').disabled).toBe(true);
		expect(container.textContent).toContain('Available from age 15.');
		expect(container.textContent).not.toContain('16');
	});
	it('eligibility_comes_from_game_activity_eligible_not_public_profile', async () => {
		state.publicProfileAllowed = false;
		state.visibility = 'everyone';
		await render();
		expect(button('Everyone').disabled).toBe(false);
		expect(container.textContent).not.toContain('Available from age');
		expect(new GameActivitySettingsState().getEffectiveSharing()).toBe(true);
		state.publicProfileAllowed = true;
		state.eligible = false;
		expect(new GameActivitySettingsState().getEffectiveSharing()).toBe(false);
	});
	it('effective sharing requires known age and friends or everyone', () => {
		const settings = new GameActivitySettingsState();
		expect(settings.getEffectiveSharing()).toBe(false);
		state.visibility = 'friends';
		expect(settings.getEffectiveSharing()).toBe(true);
		state.visibility = 'everyone';
		expect(settings.getEffectiveSharing()).toBe(true);
		state.visibility = 'unknown';
		expect(settings.getEffectiveSharing()).toBe(false);
		state.visibility = 'everyone';
		state.eligible = undefined;
		expect(settings.getEffectiveSharing()).toBe(false);
	});
	it('only_me_explained_and_stops_producer through effective policy', async () => {
		state.visibility = 'everyone';
		state.privacy = ProfilePrivacyLevels.ONLY_ME;
		await render();
		expect(new GameActivitySettingsState().getEffectiveSharing()).toBe(false);
		expect(container.textContent).toContain('Only me');
	});
	it('off_ack_error_not_success and retry remains available', async () => {
		state.visibility = 'friends';
		mocks.update.mockRejectedValue(new Error('ACK timeout'));
		await render();
		await act(async () => button('Off').click());
		expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not confirm');
		expect(button('Retry')).toBeDefined();
		expect(container.textContent).not.toContain('Successfully');
	});
	it('disclosure_and_existing_privacy_link_visible', async () => {
		await render();
		expect(container.textContent).toContain('game name or ID and start time');
		expect(container.textContent).toContain('process list stays on this device');
		expect(container.textContent).toContain('temporary');
		expect(container.textContent).toContain('rights');
		expect(container.querySelector('a')?.href).toBe('https://micup.test/privacy');
	});
	it('local_rules_can_be_removed only after explicit list action', async () => {
		await render();
		expect(mocks.listRules).not.toHaveBeenCalled();
		await act(async () => button('Local game rules').click());
		expect(container.textContent).toContain('My game');
		await act(async () => button('Remove').click());
		expect(mocks.remove).toHaveBeenCalledWith('r');
	});
	it('off stops before API and failed barrier rereads without reopening producer', async () => {
		const commands = await vi.importActual<typeof import('@app/features/user/commands/UserSettingsCommands')>(
			'@app/features/user/commands/UserSettingsCommands',
		);
		mocks.patch.mockRejectedValue(new Error('ACK timeout'));
		await expect(commands.updateGameActivityVisibility('off')).rejects.toThrow('ACK timeout');
		expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(mocks.patch.mock.invocationCallOrder[0]);
		expect(mocks.get).toHaveBeenCalledOnce();
		expect(mocks.refresh).not.toHaveBeenCalled();
		expect(mocks.apply).toHaveBeenCalledWith(
			{game_activity_visibility: 'friends'},
			{hydrate: false, fields: ['gameActivityVisibility', 'gameActivityEligible', 'gameActivityDefaultPending']},
		);
		state.visibility = 'friends';
		expect(GameActivitySettings.getEffectiveSharing()).toBe(false);
	});
	it('missing response confirmation never reopens producer', async () => {
		const commands = await vi.importActual<typeof import('@app/features/user/commands/UserSettingsCommands')>(
			'@app/features/user/commands/UserSettingsCommands',
		);
		mocks.patch.mockResolvedValue({body: {}});
		await expect(commands.updateGameActivityVisibility('off')).rejects.toThrow('not confirmed');
		expect(mocks.refresh).not.toHaveBeenCalled();
	});
	it('superseded friends acknowledgement cannot restart while off is pending', async () => {
		const commands = await vi.importActual<typeof import('@app/features/user/commands/UserSettingsCommands')>(
			'@app/features/user/commands/UserSettingsCommands',
		);
		let resolveFirst!: (value: unknown) => void;
		let resolveSecond!: (value: unknown) => void;
		mocks.patch.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveFirst = resolve;
				}),
		);
		mocks.patch.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveSecond = resolve;
				}),
		);
		const first = commands.updateGameActivityVisibility('friends');
		const firstOutcome = first.then(
			() => 'success',
			(error: Error) => error.message,
		);
		await Promise.resolve();
		const second = commands.updateGameActivityVisibility('off');
		await Promise.resolve();
		resolveFirst({body: {game_activity_visibility: 'friends'}});
		expect(await firstOutcome).toContain('superseded');
		expect(mocks.refresh).not.toHaveBeenCalled();
		expect(mocks.apply).not.toHaveBeenCalled();
		resolveSecond({body: {game_activity_visibility: 'off'}});
		await second;
	});
	for (const mode of ['game', 'only_me'] as const) {
		it(`${mode} pending stop cannot write using a changed account`, async () => {
			const commands = await vi.importActual<typeof import('@app/features/user/commands/UserSettingsCommands')>(
				'@app/features/user/commands/UserSettingsCommands',
			);
			let resumeStop!: () => void;
			mocks.stop.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						resumeStop = resolve;
					}),
			);
			const operation =
				mode === 'game'
					? commands.updateGameActivityVisibility('off')
					: commands.update({profilePrivacy: ProfilePrivacyLevels.ONLY_ME});
			const outcome = operation.then(
				() => 'success',
				(error: Error) => error.message,
			);
			state.accountId = 'new-account';
			resumeStop();
			await outcome;
			expect(mocks.patch).not.toHaveBeenCalled();
			expect(mocks.persist).not.toHaveBeenCalled();
			expect(mocks.get).not.toHaveBeenCalled();
			expect(await outcome).toContain('Account changed');
		});
		it(`${mode} superseded pending stop cannot write`, async () => {
			const commands = await vi.importActual<typeof import('@app/features/user/commands/UserSettingsCommands')>(
				'@app/features/user/commands/UserSettingsCommands',
			);
			let resumeStop!: () => void;
			mocks.stop.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						resumeStop = resolve;
					}),
			);
			const operation =
				mode === 'game'
					? commands.updateGameActivityVisibility('friends')
					: commands.update({profilePrivacy: ProfilePrivacyLevels.ONLY_ME});
			const outcome = operation.then(
				() => 'success',
				(error: Error) => error.message,
			);
			await commands.updateGameActivityVisibility('off');
			mocks.patch.mockClear();
			mocks.persist.mockClear();
			mocks.get.mockClear();
			resumeStop();
			await outcome;
			expect(mocks.patch).not.toHaveBeenCalled();
			expect(mocks.persist).not.toHaveBeenCalled();
			expect(mocks.get).not.toHaveBeenCalled();
			expect(await outcome).toContain('superseded');
		});
	}
	it('combined settings cannot persist remaining fields after an account switch during refresh', async () => {
		const commands = await vi.importActual<typeof import('@app/features/user/commands/UserSettingsCommands')>(
			'@app/features/user/commands/UserSettingsCommands',
		);
		let resumeRefresh!: () => void;
		mocks.refresh.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resumeRefresh = resolve;
				}),
		);
		const operation = commands.update({gameActivityVisibility: 'off', profilePrivacy: ProfilePrivacyLevels.ONLY_ME});
		const outcome = operation.then(
			() => 'success',
			(error: Error) => error.message,
		);
		await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
		state.accountId = 'new-account';
		resumeRefresh();
		await outcome;
		expect(mocks.persist).not.toHaveBeenCalled();
		expect(await outcome).toContain('Account changed');
	});
});

// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

const runtime = vi.hoisted(() => ({
	selfHosted: true,
	premiumTrialDays: 7,
	giftCodesEnabled: true,
	getSnapshotOrNull: () => null,
	isSelfHosted(): boolean {
		return this.selfHosted;
	},
}));
const modalCommands = vi.hoisted(() => ({push: vi.fn(), popAll: vi.fn(), modal: (render: () => unknown) => render}));
const routerUtils = vi.hoisted(() => ({transitionTo: vi.fn()}));
// The modal stack as Fluxer's Modal store tells it: whether the user settings are open.
const modalStack = vi.hoisted(() => ({settingsOpen: true}));
const UserSettingsModalStub = vi.hoisted(() => () => null);

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	Trans: ({children}: {children: unknown}) => children,
	useLingui: () => ({i18n: {locale: 'en-US', _: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: runtime}));
vi.mock('@app/features/ui/commands/ModalCommands', () => modalCommands);
vi.mock('@app/features/navigation/utils/RouterUtils', () => routerUtils);
vi.mock('@app/features/premium/components/modals/PremiumModal', () => ({PremiumModal: () => null}));
vi.mock('@app/features/ui/state/Modal', () => ({
	default: {hasModalOfType: (type: unknown) => type === UserSettingsModalStub && modalStack.settingsOpen},
	registerKeyboardModeStateResolver: vi.fn(),
	registerKeyboardModeRestoreCallback: vi.fn(),
}));
vi.mock('@app/features/user/components/modals/UserSettingsModal', () => ({UserSettingsModal: UserSettingsModalStub}));
vi.mock('@app/features/user/components/settings_utils/SettingsConstants', () => ({
	getSettingsTabs: () => [{type: 'my_profile'}, {type: 'profile_cosmetics'}, {type: 'appearance'}],
}));

// Idle and LocalPresence import each other; loading Idle first keeps its timer from calling a half-loaded store.
await import('@app/features/ui/state/Idle');
const {PremiumModal} = await import('@app/features/premium/components/modals/PremiumModal');
const PremiumModalCommands = await import('@app/features/premium/commands/PremiumModalCommands');
const {default: UnsavedChanges} = await import('@app/features/ui/state/UnsavedChanges');

function pushedElement(): {type: unknown; props: Record<string, unknown>} {
	expect(modalCommands.push).toHaveBeenCalledTimes(1);
	const render = modalCommands.push.mock.calls[0][0] as () => {type: unknown; props: Record<string, unknown>};
	return render();
}

describe('PremiumModalCommands.open', () => {
	beforeEach(() => {
		modalCommands.push.mockClear();
		modalCommands.popAll.mockClear();
		routerUtils.transitionTo.mockClear();
		runtime.selfHosted = true;
		runtime.premiumTrialDays = 7;
		runtime.giftCodesEnabled = true;
		modalStack.settingsOpen = true;
		UnsavedChanges.clearUnsavedChanges('my_profile');
		UnsavedChanges.clearUnsavedChanges('webhooks');
	});

	it('keeps the Stripe premium modal off self-hosted instances', () => {
		runtime.selfHosted = false;
		PremiumModalCommands.open(true);
		const element = pushedElement();
		expect(element.type).toBe(PremiumModal);
		expect(element.props.defaultGiftMode).toBe(true);
		expect(routerUtils.transitionTo).not.toHaveBeenCalled();
	});

	it('closes every open dialog and goes to the premium page on a self-hosted instance', () => {
		PremiumModalCommands.open();
		expect(modalCommands.popAll).toHaveBeenCalledTimes(1);
		expect(routerUtils.transitionTo).toHaveBeenCalledWith('/premium');
		expect(modalCommands.popAll.mock.invocationCallOrder[0]).toBeLessThan(
			routerUtils.transitionTo.mock.invocationCallOrder[0],
		);
		expect(modalCommands.push).not.toHaveBeenCalled();
	});

	// The premium buttons of My Profile sit inside the settings: closing every dialog would drop the unsaved edits, so the
	// settings' own unsaved-changes guard runs first (the banner flashes, nothing closes).
	it('keeps the settings open and flashes the unsaved-changes banner while a tab has unsaved changes', () => {
		UnsavedChanges.setUnsavedChanges('my_profile', true);
		const flashes = UnsavedChanges.getFlashTrigger('my_profile');
		PremiumModalCommands.open();
		expect(modalCommands.popAll).not.toHaveBeenCalled();
		expect(routerUtils.transitionTo).not.toHaveBeenCalled();
		expect(UnsavedChanges.getFlashTrigger('my_profile')).toBe(flashes + 1);
	});

	// useWebhookUpdates (guild and channel settings) never clears its entry: a dialog closed from outside leaves `true`
	// behind until the page reloads. Only the open settings' own tabs hold the button.
	it('goes to the premium page while the settings are closed, though a closed dialog left an unsaved entry', () => {
		modalStack.settingsOpen = false;
		UnsavedChanges.setUnsavedChanges('webhooks', true);
		UnsavedChanges.setUnsavedChanges('my_profile', true);
		const flashes = UnsavedChanges.getFlashTrigger('my_profile');
		PremiumModalCommands.open();
		expect(modalCommands.popAll).toHaveBeenCalledTimes(1);
		expect(routerUtils.transitionTo).toHaveBeenCalledWith('/premium');
		expect(UnsavedChanges.getFlashTrigger('my_profile')).toBe(flashes);
	});

	it('goes to the premium page when the unsaved entry is not a tab of the open settings', () => {
		UnsavedChanges.setUnsavedChanges('webhooks', true);
		const flashes = UnsavedChanges.getFlashTrigger('webhooks');
		PremiumModalCommands.open();
		expect(modalCommands.popAll).toHaveBeenCalledTimes(1);
		expect(routerUtils.transitionTo).toHaveBeenCalledWith('/premium');
		expect(UnsavedChanges.getFlashTrigger('webhooks')).toBe(flashes);
	});

	it('goes to the premium page when the settings tab has no unsaved changes left', () => {
		UnsavedChanges.setUnsavedChanges('my_profile', false);
		PremiumModalCommands.open();
		expect(modalCommands.popAll).toHaveBeenCalledTimes(1);
		expect(routerUtils.transitionTo).toHaveBeenCalledWith('/premium');
	});

	it('does nothing on a self-hosted instance without premium', () => {
		runtime.premiumTrialDays = 0;
		runtime.giftCodesEnabled = false;
		PremiumModalCommands.open();
		expect(modalCommands.push).not.toHaveBeenCalled();
		expect(modalCommands.popAll).not.toHaveBeenCalled();
		expect(routerUtils.transitionTo).not.toHaveBeenCalled();
	});
});

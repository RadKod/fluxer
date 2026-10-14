// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {User} from '@app/features/user/models/User';
import type React from 'react';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const harness = vi.hoisted(() => ({
	check: vi.fn(),
	tagCheck: vi.fn(),
	status: vi.fn(),
	update: vi.fn(),
	pop: vi.fn(),
	toast: vi.fn(),
}));
const runtime = vi.hoisted(() => ({usernameMigration: {state: 'selecting'}, usesUniqueUsernames: false}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: runtime}));
vi.mock('@app/features/user/state/Users', () => ({default: {handleUserUpdate: vi.fn()}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => 0}}));
vi.mock('@app/features/premium/utils/PremiumUtils', () => ({
	getPremiumProductName: () => 'Plus',
	shouldShowPremiumFeatures: () => false,
}));
vi.mock('@app/features/premium/commands/PremiumModalCommands', () => ({open: vi.fn()}));
vi.mock('@app/features/app/components/dialogs/ConfirmModal', () => ({ConfirmModal: () => null}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({
	default: ({children}: {children: React.ReactNode}) => children,
}));
vi.mock('@app/features/ui/plutonium_upsell/PlutoniumUpsell', () => ({PlutoniumUpsell: () => null}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: ({children}: {children: React.ReactNode}) => children}));
vi.mock('@app/features/ui/warning_alert/WarningAlert', () => ({WarningAlert: () => null}));
vi.mock('@app/features/user/utils/DateFormatting', () => ({getFormattedDateTime: () => ''}));
vi.mock('@app/features/app/config/I18nDisplayConstants', () => ({EXAMPLE_FLUXER_TAG: 'Alice#1234'}));
vi.mock('@app/features/user/commands/UsernameCommands', () => ({
	checkUsernameAvailability: harness.check,
	getUsernameStatus: harness.status,
}));
vi.mock('@app/features/user/commands/UserCommands', () => ({
	update: harness.update,
	checkFluxerTagAvailability: harness.tagCheck,
}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({pop: harness.pop}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({createToast: harness.toast}));
vi.mock('@lingui/core/macro', () => ({
	msg: (descriptor: unknown) => (Array.isArray(descriptor) ? {message: descriptor.join('')} : descriptor),
}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message, locale: 'en-US'}}),
	Trans: ({children}: {children: React.ReactNode}) => children,
}));
vi.mock('@app/features/ui/components/form/FormInput', () => ({
	Input: ({label, error, leftElement, ...props}: {label: string; error?: string; leftElement?: React.ReactNode}) =>
		createElement('label', {}, label, leftElement, createElement('input', props), error),
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({
		submitting: _submitting,
		small: _small,
		fitContainer: _fit,
		variant: _variant,
		...props
	}: Record<string, unknown>) => createElement('button', {type: 'button', ...props}),
}));
vi.mock('@app/features/app/components/dialogs/Modal', () => ({
	Root: ({children, onClose}: {children: React.ReactNode; onClose?: () => void}) =>
		createElement(
			'div',
			{'data-modal': true},
			children,
			createElement('button', {type: 'button', onClick: onClose, 'data-dismiss': true}),
		),
	Header: ({title, hideCloseButton}: {title: string; hideCloseButton?: boolean}) =>
		createElement('h2', {'data-hide-close': hideCloseButton}, title),
	Content: ({children}: {children: React.ReactNode}) => children,
	ContentLayout: ({children}: {children: React.ReactNode}) => children,
	Description: ({children}: {children: React.ReactNode}) => children,
	Footer: ({children}: {children: React.ReactNode}) => children,
}));
vi.mock('@app/features/ui/components/form/Form', () => ({
	Form: ({form: _form, ...props}: Record<string, unknown>) => createElement('form', props),
}));
vi.mock('@app/features/app/hooks/useFormSubmit', () => ({
	useFormSubmit: ({
		form,
		onSubmit,
	}: {
		form: {handleSubmit: (fn: unknown) => () => Promise<void>};
		onSubmit: unknown;
	}) => ({handleSubmit: form.handleSubmit(onSubmit), isSubmitting: false}),
}));

import {FluxerTagChangeModal} from './FluxerTagChangeModal';
import {UsernameSection} from './tabs/my_profile_tab/MyProfileTabUsernameSection';
import {UsernamePickerModal} from './UsernamePickerModal';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const legacyUser = {username: 'Alice', usernameState: 'legacy'} as User;
describe('username selection modal', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		runtime.usernameMigration.state = 'selecting';
		runtime.usesUniqueUsernames = false;
		harness.check.mockReset().mockResolvedValue({taken: false});
		harness.tagCheck.mockReset().mockResolvedValue(false);
		harness.status.mockReset().mockResolvedValue({state: 'legacy', freeChangeAvailable: true, changeAvailableAt: null});
		harness.update.mockReset().mockResolvedValue({username: 'alice', username_state: 'selected'});
		harness.toast.mockReset();
		harness.pop.mockReset();
		container = document.createElement('div');
		root = createRoot(container);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		vi.useRealTimers();
	});
	async function mount(props = {}) {
		await act(async () => root.render(createElement(UsernamePickerModal, {user: legacyUser, ...props})));
		await act(async () => vi.advanceTimersByTimeAsync(350));
	}
	async function edit(value: string) {
		await act(async () => {
			const input = container.querySelector('input')!;
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
			input.dispatchEvent(new Event('input', {bubbles: true}));
		});
		await act(async () => vi.advanceTimersByTimeAsync(350));
	}
	test('suggests a legacy name only after it is known to be free', async () => {
		await mount();
		expect(harness.status).toHaveBeenCalledTimes(1);
		expect((container.querySelector('input') as HTMLInputElement).value).toBe('alice');
	});
	test('does not suggest a taken old name', async () => {
		harness.check.mockResolvedValue({taken: true});
		await mount();
		expect((container.querySelector('input') as HTMLInputElement).value).toBe('');
	});
	test('blocks saving when the private status has a future cooldown', async () => {
		harness.status.mockResolvedValue({
			state: 'selected',
			freeChangeAvailable: false,
			changeAvailableAt: '2999-10-23T00:00:00Z',
		});
		await mount({user: {username: 'alice', usernameState: 'selected'} as User});
		await edit('bobbie');
		expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
		expect(container.querySelector('time')?.getAttribute('datetime')).toBe('2999-10-23T00:00:00Z');
		expect(container.textContent).not.toContain('Your first change is immediate');
	});
	test('required inline picker leaves escape actions to the parent and cannot dismiss itself', async () => {
		await mount({required: true, inline: true});
		expect(container.querySelector('[data-modal]')).toBeNull();
		expect(container.textContent).not.toContain('Cancel');
		expect(container.textContent).not.toContain('Later');
	});
	test.each([
		[legacyUser, 'Later'],
		[{...legacyUser, usernameState: 'selected'} as User, 'Cancel'],
	])('labels the voluntary secondary action according to announcement mode', async (user, label) => {
		await mount({user});
		expect(Array.from(container.querySelectorAll('button'), (button) => button.textContent)).toContain(label);
	});
	test('saves canonical username through the current account profile route', async () => {
		const selected = vi.fn();
		await mount({onSelected: selected});
		await act(async () => vi.advanceTimersByTimeAsync(350));
		await act(async () =>
			container.querySelector('form')?.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})),
		);
		expect(harness.update).toHaveBeenCalledWith({username: 'alice'});
		expect(selected).toHaveBeenCalledOnce();
	});
	test('does not promise an immediate change after the free change has been consumed', async () => {
		harness.status.mockResolvedValue({state: 'selected', freeChangeAvailable: true, changeAvailableAt: null});
		await mount({user: {...legacyUser, username: 'alice', usernameState: 'selected'} as User});
		await edit('bobbie');
		await act(async () =>
			container.querySelector('form')?.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})),
		);
		expect(harness.toast.mock.calls[0][0].children).toContain('14 days');
		expect(harness.toast.mock.calls[0][0].children).not.toContain('immediately');
	});
	test('keeps save disabled when a selected username has not changed', async () => {
		harness.status.mockResolvedValue({state: 'selected', freeChangeAvailable: true, changeAvailableAt: null});
		await mount({user: {...legacyUser, username: 'alice', usernameState: 'selected'} as User});
		expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
	});
	test('does not predict the remaining free change after a moderation reselect', async () => {
		harness.status.mockResolvedValue({state: 'reselect_required', freeChangeAvailable: true, changeAvailableAt: null});
		await mount({user: {...legacyUser, usernameState: 'reselect_required'} as User});
		await act(async () => vi.advanceTimersByTimeAsync(350));
		await act(async () =>
			container.querySelector('form')?.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})),
		);
		expect(harness.toast.mock.calls[0][0].children).toBe('Username updated');
	});
	test('routes migrating human account settings to the picker', async () => {
		await act(async () =>
			root.render(
				createElement(FluxerTagChangeModal, {
					user: {...legacyUser, discriminator: '1234', isPremium: () => false} as User,
				}),
			),
		);
		expect(container.querySelector('[data-flx="user.username-picker"]')).not.toBeNull();
	});
	test('keeps bot settings on the legacy tagged flow', async () => {
		runtime.usesUniqueUsernames = true;
		await act(async () =>
			root.render(
				createElement(FluxerTagChangeModal, {
					user: {...legacyUser, bot: true, discriminator: '1234', isPremium: () => false} as User,
				}),
			),
		);
		expect(container.querySelector('[data-flx="user.username-picker"]')).toBeNull();
		expect(container.querySelector('input[name="discriminator"]')).not.toBeNull();
	});
	test('loads the private change status when username settings open', async () => {
		harness.status.mockResolvedValue({
			state: 'selected',
			freeChangeAvailable: false,
			changeAvailableAt: '2999-10-23T00:00:00Z',
		});
		await act(async () =>
			root.render(createElement(UsernameSection, {user: legacyUser, isClaimed: true, isEmailVerified: true})),
		);
		expect(harness.status).toHaveBeenCalledOnce();
		expect(container.querySelector('time')?.getAttribute('datetime')).toBe('2999-10-23T00:00:00Z');
	});
	test.each([
		[false, false],
		[true, false],
		[false, true],
	])('legacy username settings accept @ before validation and payload construction', async (bot, unique) => {
		runtime.usernameMigration.state = 'legacy';
		runtime.usesUniqueUsernames = unique;
		await act(async () =>
			root.render(
				createElement(FluxerTagChangeModal, {
					user: {...legacyUser, bot, username: 'Previous', discriminator: '1234', isPremium: () => false} as User,
				}),
			),
		);
		await edit(' @ALICE ');
		expect(container.querySelectorAll('[data-flx="ui.form.username-validation-rules.icon-invalid"]')).toHaveLength(0);
		await act(async () =>
			container.querySelector('form')?.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})),
		);
		expect(harness.update).toHaveBeenCalledWith(
			unique && !bot ? {username: 'ALICE'} : {username: 'ALICE', discriminator: '1234'},
		);
		if (!unique || bot) expect(harness.tagCheck).toHaveBeenCalledWith({username: 'ALICE', discriminator: '1234'});
	});
});

// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

const submit = vi.hoisted(() => ({onSubmit: null as null | ((values: Record<string, string>) => Promise<unknown>)}));
const register = vi.hoisted(() => vi.fn());
const stored = vi.hoisted(() => ({code: null as string | null}));
const picker = vi.hoisted(() => vi.fn(() => null));
const formValues = vi.hoisted(() => ({username: ''}));
vi.mock('@app/features/user/components/UsernamePicker', () => ({UsernamePicker: picker}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message, locale: 'en-US'}}),
	Trans: ({children}: {children: React.ReactNode}) => children,
}));
vi.mock('framer-motion', () => ({
	AnimatePresence: ({children}: {children: React.ReactNode}) => children,
	motion: {
		span: ({
			initial: _initial,
			animate: _animate,
			exit: _exit,
			transition: _transition,
			...props
		}: Record<string, unknown>) => createElement('span', props),
	},
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {getSnapshotOrNull: () => null}}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({
	default: {},
	setAccessibilityUserSettings: vi.fn(),
}));
vi.mock('@app/features/auth/commands/AuthenticationCommands', () => ({
	register,
	isRegistrationPendingApprovalResponse: () => false,
	authResponseUserToUserData: () => null,
	completeLogin: vi.fn(),
}));
vi.mock('@app/features/user/commands/RecoveryKitCommands', () => ({
	createRecoveryKitWithPasswordAndOpen: vi.fn(),
}));
vi.mock('@app/features/auth/flow/AuthFormField', () => ({default: () => null}));
vi.mock('@app/features/auth/flow/AuthPageStyles.module.css', () => ({default: {}}));
vi.mock('@app/features/auth/flow/DateOfBirthField', () => ({DateOfBirthField: () => null}));
vi.mock('@app/features/auth/flow/RegistrationLegalConsent', () => ({
	getRegistrationLegalConsentConfig: () => ({requirement: null}),
	RegistrationLegalConsent: () => null,
}));
vi.mock('@app/features/auth/flow/SubmitTooltip', () => ({
	SubmitTooltip: ({children}: {children: React.ReactNode}) => children,
	shouldDisableSubmit: () => false,
}));
vi.mock('@app/features/auth/hooks/useAuthForm', () => ({
	useAuthForm: ({onSubmit}: {onSubmit: (values: Record<string, string>) => Promise<unknown>}) => {
		submit.onSubmit = onSubmit;
		return {
			form: {
				getValue: (field: string) => (field === 'username' ? formValues.username : ''),
				getError: () => undefined,
				setValue: vi.fn(),
				setError: vi.fn(),
				handleSubmit: vi.fn(),
				isSubmitting: false,
			},
			isLoading: false,
			fieldErrors: null,
		};
	},
}));
vi.mock('@app/features/auth/state/AuthRegisterDraftContext', () => ({
	EMPTY_AUTH_REGISTER_FORM_DRAFT: {
		formValues: {},
		selectedMonth: '',
		selectedDay: '',
		selectedYear: '',
		consent: false,
	},
	useAuthRegisterDraftContext: () => ({
		getRegisterFormDraft: () => undefined,
		setRegisterFormDraft: vi.fn(),
		clearRegisterFormDraft: vi.fn(),
	}),
}));
vi.mock('@app/features/platform/components/router/RouterReact', () => ({
	useLocation: () => ({pathname: '/register', search: ''}),
}));
vi.mock('@app/features/user/hooks/useUsernameSuggestions', () => ({useUsernameSuggestions: () => ({suggestions: []})}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({fitContainer: _fitContainer, ...props}: Record<string, unknown>) =>
		createElement('button', {type: 'button', ...props}),
}));
vi.mock('@app/features/referral/utils/ReferralCodeStorage', () => ({
	readReferralCode: () => stored.code,
	clearReferralCode: () => {
		stored.code = null;
	},
}));

const {AuthRegisterFormCore} = await import('@app/features/auth/flow/AuthRegisterFormCore');
const {runtimeSnapshotFromDiscovery} = await import('@app/features/app/state/InstanceSnapshotStore');
const {instanceDiscoveryFixture} = await import('@app/features/platform/state/__fixtures__/RuntimeBootstrapFixture');
const {parseInstanceDiscoveryDocument} = await import('@fluxer/instance_bootstrap/src/Discovery');
const discovery = instanceDiscoveryFixture('https://micup.test/api');
discovery.app_public = {
	...discovery.app_public!,
	registration: {collect_date_of_birth: false},
};
const runtimeSnapshot = runtimeSnapshotFromDiscovery(parseInstanceDiscoveryDocument(discovery));

describe.each([
	['AuthRegisterFormCore', AuthRegisterFormCore],
	[
		'AuthRegisterFormCore without a username field',
		(props: React.ComponentProps<typeof AuthRegisterFormCore>) =>
			createElement(AuthRegisterFormCore, {...props, fields: {showUsername: false}}),
	],
])('%s referral code', (_name, Form) => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(async () => {
		formValues.username = '';
		picker.mockClear();
		register.mockReset();
		register.mockResolvedValue({user_id: '1', token: 't', user: null});
		stored.code = 'abcdef2345';
		container = document.createElement('div');
		root = createRoot(container);
		await act(async () => {
			root.render(
				createElement(Form as unknown as React.ComponentType<Record<string, unknown>>, {
					submitLabel: 'Go',
					redirectPath: '/',
					runtimeSnapshot,
				}),
			);
		});
	});
	afterEach(() => act(() => root.unmount()));

	it('register body carries stored referral_code and clears it on success', async () => {
		await act(async () => {
			await submit.onSubmit?.({global_name: 'ayse', username: 'ayse'});
		});

		expect(register.mock.calls[0][0]).toMatchObject({referral_code: 'abcdef2345'});
		expect(register.mock.calls[0][1]).toEqual({
			instanceKey: 'https://micup.test/api',
			apiEndpoint: 'https://micup.test/api',
			apiVersion: 9,
		});
		expect(stored.code).toBeNull();
	});

	it('keeps the code when registration fails', async () => {
		register.mockRejectedValue(new Error('nope'));

		await act(async () => {
			await submit.onSubmit?.({global_name: 'ayse', username: 'ayse'}).catch(() => undefined);
		});

		expect(stored.code).toBe('abcdef2345');
	});

	it('sends no referral_code when none is stored', async () => {
		stored.code = null;

		await act(async () => {
			await submit.onSubmit?.({global_name: 'ayse', username: 'ayse'});
		});

		expect(register.mock.calls[0][0].referral_code).toBeNull();
	});
	it('uses the shared picker and requires an explicit name during selection', async () => {
		await act(async () =>
			root.render(
				createElement(Form as unknown as React.ComponentType<Record<string, unknown>>, {
					submitLabel: 'Go',
					redirectPath: '/',
					runtimeSnapshot: {
						...runtimeSnapshot,
						usernameMigration: {state: 'selecting', epoch: 1, started_at: null, forced_at: null},
					},
				}),
			),
		);
		expect(picker).toHaveBeenCalled();
		await act(async () => {
			await submit.onSubmit?.({global_name: 'ayse', username: ''});
		});
		expect(register).not.toHaveBeenCalled();
	});
	it('strips @ and canonicalizes the explicitly selected registration name', async () => {
		await act(async () =>
			root.render(
				createElement(Form as unknown as React.ComponentType<Record<string, unknown>>, {
					submitLabel: 'Go',
					redirectPath: '/',
					runtimeSnapshot: {
						...runtimeSnapshot,
						usernameMigration: {state: 'selecting', epoch: 1, started_at: null, forced_at: null},
					},
				}),
			),
		);
		await act(async () => {
			await submit.onSubmit?.({global_name: 'ayse', username: ' @ALICE '});
		});
		expect(register.mock.calls[0][0].username).toBe('alice');
	});
	if (_name === 'AuthRegisterFormCore') {
		it('accepts one @ prefix in a legacy registration payload without changing case', async () => {
			await act(async () => {
				await submit.onSubmit?.({global_name: 'ayse', username: ' @ALICE '});
			});
			expect(register.mock.calls[0][0].username).toBe('ALICE');
		});
		it('validates the legacy required username after removing its @ prefix', async () => {
			formValues.username = '@ALICE';
			await act(async () =>
				root.render(
					createElement(AuthRegisterFormCore, {
						fields: {requireUsername: true},
						submitLabel: 'Go',
						redirectPath: '/',
						runtimeSnapshot,
					}),
				),
			);
			expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
		});
	}
});

// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const registration = vi.hoisted(() => ({collectDateOfBirth: true}));

vi.mock('@lingui/react/macro', () => ({Trans: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {selfHostedModeOverride: false}}));
vi.mock('@app/app/Routes', () => ({Routes: {terms: () => '/terms', privacy: () => '/privacy'}}));
vi.mock('@app/features/app/components/shared/ExternalLink', () => ({
	ExternalLink: ({children}: {children: ReactNode}) => createElement('a', null, children),
}));
vi.mock('@app/features/ui/checkbox/Checkbox', () => ({
	Checkbox: ({children}: {children: ReactNode}) => createElement('label', null, children),
}));

const {RegistrationLegalConsent} = await import('@app/features/auth/flow/RegistrationLegalConsent');

const NOTE = 'If you are 16 or older, your profile starts public.';

// Micup: new accounts of 16 or older start with a public profile, and registration says so.
describe('RegistrationLegalConsent public profile note', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const render = (requirement: 'terms_and_privacy' | null) =>
		act(() =>
			root.render(
				createElement(RegistrationLegalConsent, {
					checked: false,
					onChange: () => {},
					config: {
						termsUrl: '/terms',
						privacyUrl: '/privacy',
						requirement,
						collectDateOfBirth: registration.collectDateOfBirth,
					},
				}),
			),
		);

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		registration.collectDateOfBirth = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it('says under the consent box that the profile starts public from 16 and where to change it', () => {
		render('terms_and_privacy');
		const note = container.querySelector('[data-flx="auth.flow.registration-legal-consent.public-profile-note"]');
		expect(note?.textContent).toContain(NOTE);
		expect(note?.textContent).toContain('Settings > Privacy');
		expect(container.querySelector('label')?.textContent).not.toContain(NOTE);
	});

	it('says nothing when the instance asks for no consent', () => {
		render(null);
		expect(container.textContent).toBe('');
	});

	// Without a date of birth the server starts the profile on shared communities, so the sentence would be wrong.
	it('says nothing when registration asks for no date of birth', () => {
		registration.collectDateOfBirth = false;
		render('terms_and_privacy');
		expect(container.textContent).not.toContain(NOTE);
	});
});

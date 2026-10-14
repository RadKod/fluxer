// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Observable like the stores it stands in for, so a change under the mounted tab re-renders it.
const state = await vi.hoisted(async () => {
	const {observable} = await import('mobx');
	return observable({level: 0, publicProfileAllowed: true as boolean | undefined});
});

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/app/components/dialogs/shared/SettingsTabLayout', () => ({
	SettingsTabSection: ({
		title,
		description,
		children,
	}: {
		title: ReactNode;
		description?: ReactNode;
		children: ReactNode;
	}) =>
		createElement('section', null, createElement('h4', null, title), createElement('p', null, description), children),
}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {getProfilePrivacy: () => state.level}}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {
		get currentUser() {
			return {publicProfileAllowed: state.publicProfileAllowed};
		},
	},
}));
vi.mock('@app/features/user/commands/UserSettingsCommands', () => ({update: vi.fn(async () => {})}));
vi.mock('@app/features/ui/commands/NagbarCommands', () => ({dismissNagbar: vi.fn()}));

const UserSettingsCommands = await import('@app/features/user/commands/UserSettingsCommands');
const NagbarCommands = await import('@app/features/ui/commands/NagbarCommands');
const {ProfilePrivacyTabContent} = await import(
	'@app/features/user/components/modals/tabs/privacy_safety_tab/ProfilePrivacyTab'
);

describe('ProfilePrivacyTab (Micup four options)', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const radios = () => [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
	const radio = (label: string) => radios().find((element) => element.textContent?.startsWith(label))!;
	const render = () => act(() => root.render(createElement(ProfilePrivacyTabContent)));

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		state.level = ProfilePrivacyLevels.ALL_GUILDS;
		state.publicProfileAllowed = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it('lists everyone, shared communities, friends and mutual follows, only me — in that order', () => {
		render();
		const labels = ['Everyone', 'Shared communities', 'Friends and mutual follows', 'Only me'];
		expect(radios().map((element) => labels.find((label) => element.textContent?.startsWith(label)))).toEqual(labels);
		expect(container.textContent).not.toContain('small communities');
	});

	it('shows a stored 1 as shared communities', () => {
		state.level = ProfilePrivacyLevels.SMALL_GUILDS_ONLY;
		render();
		expect(radios().filter((element) => element.getAttribute('aria-checked') === 'true')).toEqual([
			radio('Shared communities'),
		]);
	});

	// the server reads a stored 100 as shared communities until the account may have a public profile.
	it('shows a stored 100 as shared communities while public_profile_allowed is false', () => {
		state.level = ProfilePrivacyLevels.EVERYONE;
		state.publicProfileAllowed = false;
		render();
		expect(radios().filter((element) => element.getAttribute('aria-checked') === 'true')).toEqual([
			radio('Shared communities'),
		]);
	});

	it('disables everyone with the age note when public_profile_allowed is false', () => {
		state.publicProfileAllowed = false;
		render();
		expect(radio('Everyone').disabled).toBe(true);
		expect(radio('Everyone').textContent).toContain('Available from age 16.');
		expect(radio('Only me').disabled).toBe(false);
		act(() => {
			state.publicProfileAllowed = true;
		});
		expect(radio('Everyone').disabled).toBe(false);
		expect(radio('Everyone').textContent).not.toContain('Available from age 16.');
	});

	it('says what each option shows, that earlier public posts open and that only me still lists you as a follower', () => {
		render();
		expect(radio('Everyone').textContent).toContain('can appear in Discover');
		expect(radio('Only me').textContent).toContain(
			'follower lists of accounts you follow, to anyone who can see those lists',
		);
		expect(container.textContent).toContain('including earlier ones');
		expect(container.textContent).toContain('Posts not marked public never open to strangers.');
	});

	it('writes the chosen level and dismisses both privacy nagbars', async () => {
		render();
		await act(async () => radio('Only me').click());
		expect(UserSettingsCommands.update).toHaveBeenCalledWith({profilePrivacy: ProfilePrivacyLevels.ONLY_ME});
		expect(vi.mocked(NagbarCommands.dismissNagbar).mock.calls).toEqual([
			['profilePrivacyWidenedDismissed'],
			['profilePublicOfferDismissed'],
		]);
	});
});

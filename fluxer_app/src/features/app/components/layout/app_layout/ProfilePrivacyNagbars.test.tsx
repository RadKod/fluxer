// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {create, fromBinary, toBinary} from '@bufbuild/protobuf';
import {type ProfilePrivacyLevel, ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';
import {NagbarDismissalsSchema} from '@fluxer/schema/src/gen/fluxer/user/preferences/v1/preferences_pb';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	level: 0,
	synced: null as null | {
		persist: ReadonlyArray<string>;
		toMessage: (store: unknown) => object;
		applyMessage: (store: unknown, message: unknown) => void;
	},
}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/user/state/SyncedField', () => ({
	makeSyncedField: vi.fn(async (_store: unknown, config: typeof state.synced) => {
		state.synced = config;
	}),
}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {getProfilePrivacy: () => state.level}}));
vi.mock('@app/features/user/commands/UserSettingsCommands', () => ({update: vi.fn(async () => {})}));
vi.mock('@app/features/ui/commands/NagbarCommands', () => ({dismissNagbar: vi.fn()}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({push: vi.fn(), modal: (render: () => unknown) => render}));
vi.mock('@app/features/user/components/modals/UserSettingsModal', () => ({UserSettingsModal: () => null}));
vi.mock('@app/features/app/components/layout/Nagbar', () => ({
	Nagbar: ({children}: {children: ReactNode}) => createElement('div', null, children),
}));
vi.mock('@app/features/app/components/layout/NagbarContent', () => ({
	NagbarContent: ({message, actions}: {message: ReactNode; actions?: ReactNode}) =>
		createElement('div', null, createElement('p', null, message), actions),
}));
vi.mock('@app/features/app/components/layout/NagbarButton', () => ({
	NagbarButton: ({children, onClick, variant}: {children: ReactNode; onClick: () => void; variant?: string}) =>
		createElement('button', {type: 'button', onClick, 'data-variant': variant ?? 'default'}, children),
}));

const UserSettingsCommands = await import('@app/features/user/commands/UserSettingsCommands');
const NagbarCommands = await import('@app/features/ui/commands/NagbarCommands');
const ModalCommands = await import('@app/features/ui/commands/ModalCommands');
const {default: NagbarStore} = await import('@app/features/ui/state/Nagbar');
const {ProfilePrivacyChangedNagbar, canShowProfilePrivacyWidened} = await import(
	'@app/features/app/components/layout/app_layout/nagbars/ProfilePrivacyChangedNagbar'
);
const {ProfilePublicOfferNagbar, canShowProfilePublicOffer} = await import(
	'@app/features/app/components/layout/app_layout/nagbars/ProfilePublicOfferNagbar'
);

const offer = (
	profilePrivacy: number | null,
	extra: Partial<{publicProfileAllowed: boolean; dismissed: boolean; widenedShown: boolean}> = {},
) =>
	canShowProfilePublicOffer({
		profilePrivacy: profilePrivacy as ProfilePrivacyLevel | null,
		publicProfileAllowed: true,
		dismissed: false,
		widenedShown: false,
		...extra,
	});

describe('profile privacy nagbars (Epha 3 Oct: variant L, one-time public offer)', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const button = (label: string) =>
		[...container.querySelectorAll('button')].find((element) => element.textContent === label) ?? null;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		state.level = ProfilePrivacyLevels.ALL_GUILDS;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it.each([1, 2])('tells a user at level %i that the options changed', (level) => {
		expect(canShowProfilePrivacyWidened(level as never, false)).toBe(true);
		expect(canShowProfilePrivacyWidened(level as never, true)).toBe(false);
	});

	it.each([0, 100, 101])('says nothing about the change at level %i', (level) => {
		expect(canShowProfilePrivacyWidened(level as never, false)).toBe(false);
	});

	it('says nothing before the settings have loaded', () => {
		expect(canShowProfilePrivacyWidened(null, false)).toBe(false);
		expect(offer(null)).toBe(false);
	});

	it('names what changed for each old level and opens the profile privacy settings', () => {
		state.level = ProfilePrivacyLevels.SMALL_GUILDS_ONLY;
		act(() => root.render(createElement(ProfilePrivacyChangedNagbar, {isMobile: false})));
		expect(container.textContent).toContain('"Friends and small communities only" is gone');
		state.level = ProfilePrivacyLevels.FRIENDS_ONLY;
		act(() => root.render(createElement(ProfilePrivacyChangedNagbar, {isMobile: true})));
		expect(container.textContent).toContain('"Friends only" is now "Friends and mutual follows"');
		act(() => button('Open settings')!.click());
		expect(ModalCommands.push).toHaveBeenCalledTimes(1);
		expect(NagbarCommands.dismissNagbar).not.toHaveBeenCalled();
	});

	it('offers the public profile once to an allowed user below everyone, after the change notice is gone', () => {
		for (const level of [0, 1, 2]) expect(offer(level)).toBe(true);
		expect(offer(1, {widenedShown: true})).toBe(false);
		expect(offer(0, {dismissed: true})).toBe(false);
	});

	it('never offers it to a user under 16, at "only me", at everyone or after an explicit choice', () => {
		expect(offer(0, {publicProfileAllowed: false})).toBe(false);
		expect(offer(ProfilePrivacyLevels.ONLY_ME)).toBe(false);
		expect(offer(ProfilePrivacyLevels.EVERYONE)).toBe(false);
		// An explicit choice in Privacy settings dismisses the offer (ProfilePrivacyTab).
		expect(offer(ProfilePrivacyLevels.FRIENDS_ONLY, {dismissed: true})).toBe(false);
	});

	it('accepting writes 100 and dismisses; declining only dismisses — nothing is preselected', async () => {
		act(() => root.render(createElement(ProfilePublicOfferNagbar, {isMobile: false})));
		expect(container.textContent).toContain('marked public');
		expect(container.textContent).toContain('last 72 hours');
		const accept = button('Make it public')!;
		const decline = button('Not now')!;
		expect(accept.dataset.variant).toBe(decline.dataset.variant);
		await act(async () => decline.click());
		expect(UserSettingsCommands.update).not.toHaveBeenCalled();
		expect(NagbarCommands.dismissNagbar).toHaveBeenLastCalledWith('profilePublicOfferDismissed');
		vi.clearAllMocks();
		await act(async () => accept.click());
		expect(UserSettingsCommands.update).toHaveBeenCalledWith({profilePrivacy: ProfilePrivacyLevels.EVERYONE});
		expect(NagbarCommands.dismissNagbar).toHaveBeenCalledWith('profilePublicOfferDismissed');
		expect(vi.mocked(UserSettingsCommands.update).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(NagbarCommands.dismissNagbar).mock.invocationCallOrder[0]!,
		);
	});

	it('keeps the offer when writing the public profile fails', async () => {
		vi.mocked(UserSettingsCommands.update).mockRejectedValueOnce(new Error('400'));
		act(() => root.render(createElement(ProfilePublicOfferNagbar, {isMobile: false})));
		await act(async () => button('Make it public')!.click());
		expect(NagbarCommands.dismissNagbar).not.toHaveBeenCalled();
	});

	it('round-trips both dismissals through the synced preferences message (fields 1000 and 1001)', () => {
		expect(NagbarDismissalsSchema.field.micupProfilePrivacyWidened.number).toBe(1000);
		expect(NagbarDismissalsSchema.field.micupProfilePublicOffer.number).toBe(1001);
		const synced = state.synced!;
		expect(synced.persist).toEqual(
			expect.arrayContaining(['profilePrivacyWidenedDismissed', 'profilePublicOfferDismissed']),
		);
		NagbarStore.dismiss('profilePrivacyWidenedDismissed');
		NagbarStore.dismiss('profilePublicOfferDismissed');
		const bytes = toBinary(NagbarDismissalsSchema, create(NagbarDismissalsSchema, synced.toMessage(NagbarStore)));
		NagbarStore.resetAll();
		expect(NagbarStore.profilePrivacyWidenedDismissed).toBe(false);
		expect(NagbarStore.profilePublicOfferDismissed).toBe(false);
		synced.applyMessage(NagbarStore, fromBinary(NagbarDismissalsSchema, bytes));
		expect(NagbarStore.profilePrivacyWidenedDismissed).toBe(true);
		expect(NagbarStore.profilePublicOfferDismissed).toBe(true);
	});
});

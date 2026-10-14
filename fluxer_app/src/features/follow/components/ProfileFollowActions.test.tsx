// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Profile} from '@app/features/user/models/Profile';
import type {User} from '@app/features/user/models/User';
import type {I18n} from '@lingui/core';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	profile: null as Partial<Profile> | null,
	user: null as Partial<User> | null,
}));

// Fills {name} and a "{key, plural, one {…} other {…}}" message (# is the number), enough to read the text.
function format(message: string, values?: Record<string, unknown>): string {
	if (!values) return message;
	return message
		.replace(/^\{(\w+), plural, one \{(.*?)\} other \{(.*)\}\}$/, (_, key: string, one: string, other: string) =>
			(values[key] === 1 ? one : other).replace('#', String(values[key])),
		)
		.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]));
}

const i18n = {
	_: (descriptor: {message: string}, values?: Record<string, unknown>) => format(descriptor.message, values),
	number: (value: number) => String(value),
};

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n})}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({Logger: class {}}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'micup.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => 1000}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: 'me'}}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {getUser: () => state.user, currentUser: {maxFollowing: 1000}},
}));
vi.mock('@app/features/follow/utils/FollowProfileUtils', async (importOriginal) => ({
	...(await importOriginal<typeof import('@app/features/follow/utils/FollowProfileUtils')>()),
	getFollowProfile: () => state.profile,
}));
vi.mock('@app/features/follow/commands/FollowCommands', () => ({
	follow: vi.fn(async () => 'ok'),
	unfollow: vi.fn(async () => 'ok'),
}));
vi.mock('@app/features/follow/components/FollowListModal', () => ({FollowListModal: () => null}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({push: vi.fn(), modal: (render: unknown) => render}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({error: vi.fn()}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: vi.fn(({children}: {children: ReactNode}) => children)}));
// Each icon draws a marked svg, so a test can tell the follow button's icons from the friend request's user-plus.
vi.mock('@phosphor-icons/react', async (importOriginal) => {
	const icon = (name: string) => () => createElement('svg', {'data-icon': name});
	return {
		...(await importOriginal<typeof import('@phosphor-icons/react')>()),
		PlusIcon: icon('plus'),
		CheckIcon: icon('check'),
		UserPlusIcon: icon('user-plus'),
		UserCheckIcon: icon('user-check'),
		UsersIcon: icon('users'),
	};
});

const FollowCommands = await import('@app/features/follow/commands/FollowCommands');
const ToastCommands = await import('@app/features/ui/commands/ToastCommands');
const {Tooltip} = await import('@app/features/ui/tooltip/Tooltip');
const {default: buttonStyles} = await import('@app/features/ui/button/Button.module.css');
const {default: styles} = await import('@app/features/follow/components/ProfileFollowActions.module.css');
const {FOLLOWING_DESCRIPTOR, ProfileFollowActions, ProfileFollowButton, toastFollowFailure} = await import(
	'@app/features/follow/components/ProfileFollowActions'
);

const PERSON = {id: '42', bot: false, system: false};

describe('ProfileFollowButton and ProfileFollowActions', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		state.user = PERSON;
		state.profile = {isFollowing: false, followerCount: 3, followingCount: 1};
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const renderButton = () => act(() => root.render(createElement(ProfileFollowButton, {userId: '42'})));
	const icons = (element: Element) =>
		[...element.querySelectorAll('[data-icon]')].map((svg) => svg.getAttribute('data-icon'));

	it('the profile header shows Follow as a small primary text button with a plus icon, not the user-plus', async () => {
		let answer: (outcome: 'ok') => void = () => {};
		vi.mocked(FollowCommands.follow).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		renderButton();
		const button = container.querySelector('button')!;
		expect(button.textContent).toBe('Follow');
		// Its name is its visible text, like the Message button beside it.
		expect(button.hasAttribute('aria-label')).toBe(false);
		expect(button.classList).toContain(buttonStyles.small);
		expect(button.classList).toContain(buttonStyles.primary);
		expect(button.classList).not.toContain(buttonStyles.square);
		expect(icons(button)).toEqual(['plus']);
		act(() => button.click());
		expect(FollowCommands.follow).toHaveBeenCalledWith('42');
		// Submitting while the request runs: the spinner shows in place of the label.
		expect(container.querySelector(`.${buttonStyles.iconWrapper}`)!.classList).toContain(buttonStyles.hidden);
		await act(async () => answer('ok'));
		expect(container.querySelector(`.${buttonStyles.iconWrapper}`)!.classList).not.toContain(buttonStyles.hidden);
	});

	it('shows Following as a secondary button with Unfollow in its tooltip, and a click unfollows', async () => {
		state.profile = {isFollowing: true, followerCount: 3, followingCount: 1};
		renderButton();
		const button = container.querySelector('button')!;
		expect(button.classList).toContain(buttonStyles.small);
		expect(button.classList).toContain(buttonStyles.secondary);
		expect(button.classList).toContain(styles.followingButton);
		expect(icons(button)).toEqual(['check']);
		expect(FOLLOWING_DESCRIPTOR).toMatchObject({message: 'Following', context: 'follow-button'});
		const idle = button.querySelector(`.${styles.followIdleLabel}`)!;
		const hover = button.querySelector(`.${styles.followHoverLabel}`)!;
		expect(idle.textContent).toBe('Following');
		// The hover text is for the pointer only; the name stays Following and the tooltip says Unfollow.
		expect(hover.textContent).toBe('Unfollow');
		expect(hover.getAttribute('aria-hidden')).toBe('true');
		expect(vi.mocked(Tooltip).mock.lastCall![0].text).toBe('Unfollow');
		await act(async () => button.click());
		expect(FollowCommands.unfollow).toHaveBeenCalledWith('42');
		expect(FollowCommands.follow).not.toHaveBeenCalled();
		expect(ToastCommands.error).not.toHaveBeenCalled();
	});

	it('renders nothing for yourself, a bot or a profile without is_following (restricted or refused)', () => {
		const cases: Array<[Partial<User>, Partial<Profile> | null]> = [
			[
				{...PERSON, id: 'me'},
				{isFollowing: null, followerCount: 3, followingCount: 1},
			],
			[
				{...PERSON, bot: true},
				{isFollowing: false, followerCount: 3, followingCount: 1},
			],
			[
				{...PERSON, system: true},
				{isFollowing: false, followerCount: 3, followingCount: 1},
			],
			[PERSON, {isFollowing: null, followerCount: null, followingCount: null}],
			[PERSON, null],
		];
		for (const [user, profile] of cases) {
			state.user = user;
			state.profile = profile;
			renderButton();
			expect(container.innerHTML).toBe('');
		}
	});

	it('ProfileFollowActions with hideFollowButton shows only the counts', () => {
		const followIcon = '[data-flx="follow.profile-follow-actions.icon-button.follow-click"]';
		const counts = '[data-flx="follow.profile-follow-actions.counts-button.open-lists"]';
		act(() => root.render(createElement(ProfileFollowActions, {userId: '42', hideFollowButton: true})));
		expect(container.querySelector(followIcon)).toBeNull();
		expect(container.querySelector(counts)).not.toBeNull();
		// The popout card keeps its icon.
		act(() => root.render(createElement(ProfileFollowActions, {userId: '42'})));
		expect(container.querySelector(followIcon)).not.toBeNull();
		// Nothing left to show on a restricted profile.
		state.profile = {isFollowing: false, followerCount: null, followingCount: null};
		act(() => root.render(createElement(ProfileFollowActions, {userId: '42', hideFollowButton: true})));
		expect(container.innerHTML).toBe('');
	});

	it('toastFollowFailure: forbidden and limit toasts on follow, try again otherwise, nothing on ok', () => {
		const toasts = () => vi.mocked(ToastCommands.error).mock.calls.map(([text]) => text);
		const lingui = i18n as unknown as I18n;
		toastFollowFailure(lingui, 'ok', false);
		toastFollowFailure(lingui, 'ok', true);
		expect(toasts()).toEqual([]);
		toastFollowFailure(lingui, 'forbidden', false);
		toastFollowFailure(lingui, 'limit', false);
		toastFollowFailure(lingui, 'failed', false);
		toastFollowFailure(lingui, 'forbidden', true);
		toastFollowFailure(lingui, 'failed', true);
		expect(toasts()).toEqual([
			"You can't follow this account.",
			'You can follow up to 1000 accounts.',
			'Try again in a moment.',
			'Try again in a moment.',
			'Try again in a moment.',
		]);
	});

	it('does not add a failure toast after the account limitation modal', () => {
		toastFollowFailure(i18n as unknown as I18n, 'account_limited', false);
		toastFollowFailure(i18n as unknown as I18n, 'account_limited', true);
		expect(ToastCommands.error).not.toHaveBeenCalled();
	});

	it('explains that email verification is needed to follow', () => {
		toastFollowFailure(i18n as unknown as I18n, 'verify_email', false);
		expect(ToastCommands.error).toHaveBeenCalledWith('Email verification required');
	});
});

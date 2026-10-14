// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Profile} from '@app/features/user/models/Profile';
import type {User} from '@app/features/user/models/User';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const marker = (name: string) => () => createElement('i', {'data-part': name});

vi.mock('@lingui/react/macro', () => ({Trans: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/app/components/shared/custom_status_display/CustomStatusDisplay', () => ({
	CustomStatusDisplay: () => null,
}));
vi.mock('@app/features/channel/components/ChannelUserTag', () => ({UserTag: () => null}));
vi.mock('@app/features/feed/components/ProfilePostsButton', () => ({ProfilePostsButton: marker('posts')}));
vi.mock('@app/features/game_activity/components/GameActivityDisplay', () => ({GameActivityDisplay: () => null}));
vi.mock('@app/features/follow/components/ProfileFollowActions', () => ({
	ProfileFollowActions: marker('follow-counts'),
}));
vi.mock('@app/features/user/components/PremiumUserBadge', () => ({PremiumUserBadge: () => null}));
vi.mock('@app/features/user/components/popouts/LimitedProfileNotice', () => ({
	LimitedProfileNotice: marker('limited-notice'),
}));
vi.mock('@app/features/user/components/popouts/UserProfileBadges', () => ({UserProfileBadges: marker('badges')}));
vi.mock('@app/features/user/components/popouts/UserProfileDataWarning', () => ({UserProfileDataWarning: () => null}));
vi.mock('@app/features/user/components/VerifiedUserBadge', () => ({VerifiedUserBadge: () => null}));
vi.mock('@app/features/user/hooks/useAutoplayExpandedProfileAnimations', () => ({
	useAutoplayExpandedProfileAnimations: () => false,
}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({formatTagForStreamerMode: (tag: string) => tag}));
vi.mock('@app/features/user/utils/ProfileGuildMembership', () => ({
	getProfileMembershipDisplayName: () => 'Ayşe',
	resolveProfileGuildMembership: () => ({}),
}));

const {UserInfo} = await import('@app/features/user/components/modals/user_profile_modal/UserProfileModalUserInfo');

const USER = {id: '42', tag: 'ayse#0001', bot: false, system: false} as unknown as User;
const LIMITED = {profileLimited: true, getEffectiveProfile: () => null} as unknown as Profile;

// Micup: the page shows the follow counts, the Posts tab and the limited note itself.
describe('UserInfo on the profile page', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const parts = (onPage?: boolean) => {
		act(() => root.render(createElement(UserInfo, {user: USER, profile: LIMITED, isPreview: false, onPage})));
		return [...container.querySelectorAll('[data-part]')].map((part) => part.getAttribute('data-part'));
	};

	it('keeps the follow counts, the Posts button and the limited note in the modal and the sheet', () => {
		expect(parts()).toEqual(['limited-notice', 'badges', 'follow-counts', 'posts']);
	});

	it('leaves them to the page around it', () => {
		expect(parts(true)).toEqual(['badges']);
	});
});

// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BadgeSettings} from '@app/features/user/utils/ProfileUtils';
import {PublicUserFlags, UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Micup: the premium crown in the profile badge row reads the user's
// PREMIUM_BADGE flag. The settings preview must follow the unsaved "hide the premium badge" switch, not the saved flag.

const passThrough = ({children}: {children?: ReactNode}) => children ?? null;
const marker = (name: string) => () => createElement('div', {'data-testid': name});
const i18n = {_: (descriptor: {message: string}) => descriptor.message};

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n}), Trans: passThrough}));
vi.mock('@app/features/app/components/shared/custom_status_display/CustomStatusDisplay', () => ({
	CustomStatusDisplay: () => null,
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'micup.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {}}));
vi.mock('@app/features/channel/components/ChannelUserTag', () => ({UserTag: () => null}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {getGuild: () => null}}));
const premium = vi.hoisted(() => ({open: vi.fn()}));
vi.mock('@app/features/premium/commands/PremiumModalCommands', () => ({open: premium.open}));
vi.mock('@app/features/premium/utils/PremiumUtils', () => ({
	getPremiumProductFullName: () => 'sanalyer Plus',
	shouldShowPremiumFeatures: () => true,
}));
vi.mock('@app/features/ui/button/Button', () => ({Button: () => null}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({push: vi.fn(), modal: (render: unknown) => render}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: passThrough}));
vi.mock('@app/features/ui/hooks/useTextOverflow', () => ({useTextOverflow: () => false}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: passThrough}));
vi.mock('@app/features/ui/utils/NativeUtils', () => ({handleExternalLinkClick: vi.fn()}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		warn = vi.fn();
	},
}));
vi.mock('@app/features/user/components/modals/UserProfileModal', () => ({UserProfileModal: () => null}));
vi.mock('@app/features/user/components/popouts/UserProfileShared', () => ({
	UserProfileMembershipInfo: marker('membership'),
	UserProfilePreviewBio: marker('bio'),
	UserProfileTimezoneInfo: marker('timezone'),
}));
vi.mock('@app/features/user/components/profile/profile_card/ProfileCardBanner', () => ({
	ProfileCardBanner: marker('banner'),
}));
vi.mock('@app/features/user/components/profile/profile_card/ProfileCardContent', () => ({
	ProfileCardContent: passThrough,
}));
vi.mock('@app/features/user/components/profile/profile_card/ProfileCardFooter', () => ({
	ProfileCardFooter: passThrough,
}));
vi.mock('@app/features/user/components/profile/profile_card/ProfileCardLayout', () => ({
	ProfileCardLayout: ({children}: {children: ReactNode}) => createElement('div', null, children),
}));
vi.mock('@app/features/user/components/profile/useProfileCardDisplayState', () => ({
	useProfileCardDisplayState: () => ({accentColor: null}),
}));
vi.mock('@app/features/user/components/VerifiedUserBadge', () => ({VerifiedUserBadge: () => null}));
vi.mock('@app/features/user/hooks/useAutoplayExpandedProfileAnimations', () => ({
	useAutoplayExpandedProfileAnimations: () => false,
}));
vi.mock('@app/features/user/state/UserProfile', () => ({default: {getProfile: () => null}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({
	getNickname: (user: {displayName: string}) => user.displayName,
	formatNicknameForStreamerMode: (nick: string) => nick,
	formatTagForStreamerMode: (tag: string) => tag,
}));
vi.mock('@app/features/user/utils/ProfileUtils', () => ({
	createMockProfile: () => ({getGuildMemberProfile: () => null}),
}));

const {ProfilePreview} = await import('@app/features/user/components/profile/ProfilePreview');
const {User} = await import('@app/features/user/models/User');

const CROWN = 'img[data-flx="user.user-profile-badges.img"][src*="micup-premium-badge.png"]';

const me = (flags: number, premiumType: number, premiumBadgeHidden: boolean) =>
	new User({
		id: '42',
		username: 'ayse',
		discriminator: '0001',
		global_name: 'Ayse',
		avatar: null,
		avatar_color: null,
		flags,
		premium_type: premiumType,
		premium_badge_hidden: premiumBadgeHidden,
	});

describe('ProfilePreview premium crown', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
		premium.open.mockClear();
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = (user: InstanceType<typeof User>, previewBadgeSettings?: BadgeSettings) =>
		act(() => root.render(createElement(ProfilePreview, {user, previewBadgeSettings})));

	it('hides the crown while the unsaved switch hides the badge', () => {
		render(me(PublicUserFlags.PREMIUM_BADGE, UserPremiumTypes.SUBSCRIPTION, false), {premium_badge_hidden: true});

		expect(container.querySelector(CROWN)).toBeNull();
	});

	it('shows the crown again while the unsaved switch shows a saved-hidden badge', () => {
		render(me(0, UserPremiumTypes.SUBSCRIPTION, true), {premium_badge_hidden: false});

		expect(container.querySelector(CROWN)).not.toBeNull();
	});

	it('never shows the crown for a user without premium', () => {
		render(me(0, UserPremiumTypes.NONE, false), {premium_badge_hidden: false});

		expect(container.querySelector(CROWN)).toBeNull();
	});

	// the crown follows the effective premium type. With perks disabled the server sends premium_type
	// NONE (and no PREMIUM_BADGE bit) but still sends premium_until, so a "show" switch must not bring the crown back.
	it('never shows the crown for an account with premium perks disabled, even while the switch shows the badge', () => {
		render(
			me(0, UserPremiumTypes.NONE, false).withUpdates({
				premium_perks_disabled: true,
				premium_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
			}),
			{premium_badge_hidden: false},
		);

		expect(container.querySelector(CROWN)).toBeNull();
	});

	it('keeps the saved flag when no badge setting is pending', () => {
		render(me(PublicUserFlags.PREMIUM_BADGE, UserPremiumTypes.LIFETIME, false));

		expect(container.querySelector(CROWN)).not.toBeNull();
	});

	// on self-hosted Micup the premium page is a settings tab, and opening it from here switches the tab without
	// the unsaved-changes check, so a click would drop the unsaved profile edits. The preview crown is only a picture.
	it('draws a crown that cannot open the premium page and takes no tab stop', () => {
		render(me(PublicUserFlags.PREMIUM_BADGE, UserPremiumTypes.SUBSCRIPTION, false));

		const crown = container.querySelector(CROWN) as HTMLElement;
		act(() => crown.click());

		expect(premium.open).not.toHaveBeenCalled();
		expect(crown.tagName).toBe('IMG');
		expect(crown.getAttribute('alt')).toBeTruthy();
		expect(crown.closest('button, a')).toBeNull();
		expect(crown.hasAttribute('tabindex')).toBe(false);
		expect(
			container
				.querySelector('[data-flx="user.profile.profile-card.profile-card-user-info.below-name"]')
				?.contains(crown),
		).toBe(true);
	});
});

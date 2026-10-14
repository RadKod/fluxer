// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {User} from '@app/features/user/models/User';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Micup: the small profile card is Discord's short one. Name, badges under it, bio, roles and Message;
// the #tag, follow counts, Follow and the other extras live in the full profile (UserProfileModalFollow.test.ts).

const passThrough = ({children}: {children?: ReactNode}) => children ?? null;
const marker = (name: string) => () => createElement('div', {'data-testid': name});
const i18n = {_: (descriptor: {message: string}) => descriptor.message};

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n}), Trans: passThrough}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({Logger: class {}}));
vi.mock('@app/features/app/components/alerts/DmActionErrorModal', () => ({showDmActionErrorModal: vi.fn()}));
vi.mock('@app/features/app/components/dialogs/ConfirmModal', () => ({ConfirmModal: () => null}));
vi.mock('@app/features/app/components/shared/custom_status_display/CustomStatusDisplay', () => ({
	CustomStatusDisplay: () => null,
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {directMessagesDisabled: false}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: 'me'}}));
vi.mock('@app/features/channel/commands/PrivateChannelCommands', () => ({openDMChannel: vi.fn()}));
vi.mock('@app/features/channel/components/ChannelUserTag', () => ({UserTag: () => null}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/feed/components/ProfilePostsButton', () => ({ProfilePostsButton: marker('posts')}));
vi.mock('@app/features/game_activity/components/GameActivityDisplay', () => ({GameActivityDisplay: () => null}));
vi.mock('@app/features/follow/components/ProfileFollowActions', () => ({
	ProfileFollowActions: marker('follow-actions'),
	ProfileFollowButton: marker('follow-button'),
}));
vi.mock('@app/features/member/state/GuildMembers', () => ({
	default: {getMember: () => null, fetchMembers: vi.fn(async () => {})},
}));
vi.mock('@app/features/permissions/state/Permission', () => ({default: {can: () => false}}));
vi.mock('@app/features/premium/commands/PremiumModalCommands', () => ({open: vi.fn()}));
vi.mock('@app/features/presence/hooks/usePresenceCustomStatus', () => ({usePresenceCustomStatus: () => null}));
vi.mock('@app/features/presence/state/MemberPresenceSubscription', () => ({
	default: {touchMember: vi.fn(), unsubscribe: vi.fn()},
}));
vi.mock('@app/features/relationship/state/Relationships', () => ({default: {getRelationship: () => undefined}}));
vi.mock('@app/features/streamer_mode/state/StreamerMode', () => ({default: {shouldHidePersonalInformation: false}}));
vi.mock('@app/features/ui/action_menu/items/UserImageMenuItems', () => ({
	getUserMenuAvatarUrl: () => null,
	getUserMenuBannerUrl: () => null,
	UserImageMenuItems: () => null,
}));
vi.mock('@app/features/ui/commands/ContextMenuCommands', () => ({openFromEvent: vi.fn()}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({push: vi.fn(), modal: (render: unknown) => render}));
vi.mock('@app/features/ui/commands/PopoutCommands', () => ({close: vi.fn()}));
vi.mock('@app/features/ui/commands/TextCopyCommands', () => ({copy: vi.fn()}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: passThrough}));
vi.mock('@app/features/ui/focus_ring/FocusRingScope', () => ({default: passThrough}));
vi.mock('@app/features/ui/hooks/useTextOverflow', () => ({useTextOverflow: () => false}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: passThrough}));
vi.mock('@app/features/user/commands/UserProfileCommands', () => ({
	openUserProfile: vi.fn(),
	openProfilePage: vi.fn(),
}));
vi.mock('@app/features/user/components/modals/UserSettingsModal', () => ({UserSettingsModal: () => null}));
vi.mock('@app/features/user/components/popouts/LimitedProfileNotice', () => ({LimitedProfileNotice: () => null}));
vi.mock('@app/features/user/components/popouts/UserProfileBadges', () => ({UserProfileBadges: marker('badges')}));
vi.mock('@app/features/user/components/popouts/UserProfileDataWarning', () => ({UserProfileDataWarning: () => null}));
vi.mock('@app/features/user/components/popouts/UserProfileShared', () => ({
	UserProfilePreviewBio: marker('bio'),
	UserProfileRoles: marker('roles'),
	UserProfileTimezoneInfo: marker('timezone'),
	UserProfileMembershipInfo: marker('membership'),
	UserProfileConnections: marker('connections'),
}));
vi.mock('@app/features/user/components/profile/profile_card/ProfileCardBanner', () => ({
	ProfileCardBanner: marker('banner'),
}));
vi.mock('@app/features/user/components/profile/profile_card/ProfileCardLayout', () => ({
	ProfileCardLayout: ({children}: {children: ReactNode}) => createElement('div', null, children),
}));
vi.mock('@app/features/user/components/profile/UserProfileLoadingSkeleton', () => ({
	UserProfileLoadingSkeleton: () => null,
}));
vi.mock('@app/features/user/components/profile/useProfileCardDisplayState', () => ({
	useProfileCardDisplayState: () => ({profileContext: null, accentColor: null, profileData: {pronouns: 'o/onu'}}),
}));
vi.mock('@app/features/user/components/profile/VoiceActivitySection', () => ({VoiceActivitySection: () => null}));
vi.mock('@app/features/user/components/VerifiedUserBadge', () => ({VerifiedUserBadge: () => null}));
vi.mock('@app/features/user/constants/UserProfileSurfaceGeometry', () => ({PROFILE_POPOUT_GEOMETRY_STYLE: {}}));
vi.mock('@app/features/user/hooks/useAutoplayExpandedProfileAnimations', () => ({
	useAutoplayExpandedProfileAnimations: () => false,
}));
vi.mock('@app/features/user/hooks/useUserProfileSurfaceState', () => ({
	useUserProfileSurfaceState: () => ({profile: {}, profileLoadError: false, showProfileSkeleton: false}),
}));
vi.mock('@app/features/user/state/UserNote', () => ({default: {getUserNote: () => null}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({
	getNickname: (user: {globalName: string}) => user.globalName,
	formatNicknameForStreamerMode: (nick: string) => nick,
	formatTagForStreamerMode: (tag: string) => tag,
}));
vi.mock('@app/features/user/utils/ProfileGuildMembership', () => ({
	resolveProfileGuildMembership: () => ({kind: 'global'}),
}));
vi.mock('@app/features/user/utils/ProfileUtils', () => ({createMockProfile: () => ({})}));

const {UserProfilePopout} = await import('@app/features/user/components/popouts/UserProfilePopout');
const UserProfileCommands = await import('@app/features/user/commands/UserProfileCommands');
const PopoutCommands = await import('@app/features/ui/commands/PopoutCommands');

const USER = {
	id: '42',
	username: 'gekkomsu',
	globalName: 'Gekkomsu',
	tag: 'gekkomsu#0001',
	bot: false,
	system: false,
	isClaimed: () => true,
} as unknown as User;

describe('UserProfilePopout (the small profile card)', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
		act(() =>
			root.render(createElement(UserProfilePopout, {popoutKey: 'k', user: USER, isWebhook: false, guildId: '7'})),
		);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const byTestId = (name: string) => container.querySelector(`[data-testid="${name}"]`);

	it('shows the banner, the name, the badges right under it (above the pronouns), the bio, the roles and Message', () => {
		expect(byTestId('banner')).not.toBeNull();
		const name = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Gekkomsu');
		expect(name).toBeDefined();
		const badges = byTestId('badges')!;
		expect(badges).not.toBeNull();
		expect(name!.compareDocumentPosition(badges) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		const pronouns = container.querySelector('[data-flx="user.profile.profile-card.profile-card-user-info.pronouns"]')!;
		expect(pronouns.textContent).toContain('o/onu');
		expect(badges.compareDocumentPosition(pronouns) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(byTestId('bio')).not.toBeNull();
		expect(byTestId('roles')).not.toBeNull();
		expect(container.querySelector('footer button')?.textContent).toBe('Message');
	});

	it('leaves the #tag, follow counts, Follow and the other extras to the full profile', () => {
		expect(container.textContent).not.toContain('gekkomsu#0001');
		for (const extra of ['follow-actions', 'follow-button', 'posts', 'timezone', 'membership', 'connections']) {
			expect(byTestId(extra), extra).toBeNull();
		}
		// The note and copy-ID icons.
		expect(container.querySelector('[data-flx^="user.profile.profile-card.profile-card-actions"]')).toBeNull();
	});

	// Micup: the card stays in chat and leads to the full profile page.
	it('offers Open profile under Message, which opens the full profile page and closes the card', () => {
		const buttons = [...container.querySelectorAll('footer button')].map((button) => button.textContent);
		expect(buttons).toEqual(['Message', 'Open profile']);
		act(() => [...container.querySelectorAll<HTMLButtonElement>('footer button')][1]!.click());
		expect(UserProfileCommands.openProfilePage).toHaveBeenCalledWith('42');
		expect(PopoutCommands.close).toHaveBeenCalledWith('k');
		expect(UserProfileCommands.openUserProfile).not.toHaveBeenCalled();
	});
});

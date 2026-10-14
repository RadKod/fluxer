// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
	Trans: ({children}: {children: unknown}) => children,
}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		static create() {
			return new this();
		}
		debug() {}
		error() {}
		warn() {}
	},
}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http: {get: vi.fn()}}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => ({transitionTo: vi.fn(), replaceWith: vi.fn()}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {isSelfHosted: () => false}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {isAuthenticated: true, currentUserId: 'me'}}));
vi.mock('@app/features/gift/commands/GiftCommands', () => ({openAcceptModal: vi.fn()}));
vi.mock('@app/features/invite/commands/InviteCommands', () => ({openAcceptModal: vi.fn()}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({
	push: vi.fn(),
	popAll: vi.fn(),
	popAllByType: vi.fn(),
	modal: (render: unknown) => render,
}));
vi.mock('@app/features/app/components/dialogs/LoadableSettingsModals', () => ({UserSettingsModal: () => null}));
vi.mock('@app/features/user/components/modals/UserSettingsModal', () => ({UserSettingsModal: () => null}));
vi.mock('@app/features/premium/commands/PlutoniumPageCommands', () => ({openPlutoniumPage: vi.fn()}));
vi.mock('@app/features/user/components/settings_utils/UserSettingsDeepLinks', () => ({
	parseUserSettingsDeepLinkPath: () => null,
}));
// The real profile commands run; only what would draw a profile surface is replaced.
vi.mock('@app/features/user/components/modals/UserProfileModal', () => ({UserProfileModal: () => null}));
vi.mock('@app/features/user/state/UserProfileMobile', () => ({default: {close: vi.fn(), open: vi.fn()}}));
vi.mock('@app/features/ui/commands/ContextMenuCommands', () => ({close: vi.fn()}));
vi.mock('@app/features/ui/commands/PopoutCommands', () => ({closeAll: vi.fn()}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {enabled: false, isMobileLayout: () => false}}));
vi.mock('@app/features/app/state/Initialization', () => ({default: {canNavigateToProtectedRoutes: true}}));
vi.mock('@app/features/platform/state/AuthSession', () => ({default: {isConnected: true}}));
vi.mock('@app/features/user/state/Users', () => ({default: {handleUserUpdate: vi.fn(), getUser: () => null}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));

const {navigateToLinkedUserProfile} = await import('@app/features/navigation/utils/DeepLinkUtils');
const RouterUtils = await import('@app/features/navigation/utils/RouterUtils');
const ModalCommands = await import('@app/features/ui/commands/ModalCommands');
const {http} = await import('@app/features/platform/transport/RestTransport');

describe('navigateToLinkedUserProfile', () => {
	beforeEach(() => vi.clearAllMocks());

	it('opens /users/<id> as a page for a snowflake', () => {
		navigateToLinkedUserProfile('1234567890123456789');
		expect(RouterUtils.transitionTo).toHaveBeenCalledWith('/users/1234567890123456789');
		// The page, not the modal over the home page.
		expect(ModalCommands.push).not.toHaveBeenCalled();
		expect(http.get).not.toHaveBeenCalled();
	});

	it('replaces the history entry when asked', () => {
		navigateToLinkedUserProfile('42', {replace: true});
		expect(RouterUtils.replaceWith).toHaveBeenCalledWith('/users/42');
		expect(RouterUtils.transitionTo).not.toHaveBeenCalled();
	});

	it.each(['../../users/@me/settings', '@me', '12ab', '', '0x10', ' 12', '0', '123456789012345678901'])(
		'sends %j to the home page without a request (R1, CSPT)',
		(id) => {
			navigateToLinkedUserProfile(id);
			expect(RouterUtils.transitionTo).toHaveBeenCalledWith(Routes.ME);
			expect(http.get).not.toHaveBeenCalled();
			expect(ModalCommands.push).not.toHaveBeenCalled();
		},
	);
});

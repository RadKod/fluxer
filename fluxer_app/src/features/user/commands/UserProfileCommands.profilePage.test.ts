// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug() {}
		error() {}
		warn() {}
	},
}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http: {get: vi.fn()}}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => ({transitionTo: vi.fn(), replaceWith: vi.fn()}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({
	popAll: vi.fn(),
	popAllByType: vi.fn(),
	push: vi.fn(),
	modal: (render: unknown) => render,
}));
vi.mock('@app/features/ui/commands/ContextMenuCommands', () => ({close: vi.fn()}));
vi.mock('@app/features/ui/commands/PopoutCommands', () => ({closeAll: vi.fn()}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {enabled: false}}));
vi.mock('@app/features/user/components/modals/UserProfileModal', () => ({UserProfileModal: () => null}));
vi.mock('@app/features/user/state/UserProfileMobile', () => ({default: {close: vi.fn(), open: vi.fn()}}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {}}));
vi.mock('@app/features/app/state/Initialization', () => ({default: {canNavigateToProtectedRoutes: true}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {isAuthenticated: true, currentUserId: 'me'}}));
vi.mock('@app/features/platform/state/AuthSession', () => ({default: {isConnected: true}}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {handleUserUpdate: vi.fn(), getUser: (id: string) => ({toJSON: () => wireUser(id)})},
}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));

const UserProfileCommands = await import('@app/features/user/commands/UserProfileCommands');
const RouterUtils = await import('@app/features/navigation/utils/RouterUtils');
const ModalCommands = await import('@app/features/ui/commands/ModalCommands');
const ContextMenuCommands = await import('@app/features/ui/commands/ContextMenuCommands');
const PopoutCommands = await import('@app/features/ui/commands/PopoutCommands');
const {default: UserProfileMobile} = await import('@app/features/user/state/UserProfileMobile');
const {http} = await import('@app/features/platform/transport/RestTransport');
const {default: UserProfile} = await import('@app/features/user/state/UserProfile');

function wireUser(id: string) {
	return {
		id,
		username: `user${id}`,
		discriminator: '0001',
		global_name: null,
		avatar: null,
		avatar_color: null,
		flags: 0,
	};
}

// the id goes into request paths, so only a plain decimal snowflake passes.
const INVALID_IDS = [
	'../../users/@me/settings',
	'@me',
	'12ab',
	'',
	'0x10',
	' 12',
	'12 ',
	'0',
	'-1',
	'1e5',
	'123456789012345678901',
];

describe('isProfileId', () => {
	it.each(['1', '1234567890123456789', '18446744073709551615'])('accepts %j', (id) => {
		expect(UserProfileCommands.isProfileId(id)).toBe(true);
	});

	it.each(INVALID_IDS)('refuses %j', (id) => {
		expect(UserProfileCommands.isProfileId(id)).toBe(false);
	});
});

describe('openProfilePage', () => {
	beforeEach(() => vi.clearAllMocks());

	it('closes open modals, popouts, context menus and the mobile sheet, then navigates to the page', () => {
		expect(UserProfileCommands.openProfilePage('1234567890123456789')).toBe(true);
		expect(PopoutCommands.closeAll).toHaveBeenCalled();
		expect(ContextMenuCommands.close).toHaveBeenCalled();
		expect(UserProfileMobile.close).toHaveBeenCalled();
		expect(ModalCommands.popAll).toHaveBeenCalled();
		expect(RouterUtils.transitionTo).toHaveBeenCalledWith('/users/1234567890123456789');
		const closedModals = vi.mocked(ModalCommands.popAll).mock.invocationCallOrder[0]!;
		expect(closedModals).toBeLessThan(vi.mocked(RouterUtils.transitionTo).mock.invocationCallOrder[0]!);
	});

	it.each(INVALID_IDS)('does nothing for %j', (id) => {
		expect(UserProfileCommands.openProfilePage(id)).toBe(false);
		expect(RouterUtils.transitionTo).not.toHaveBeenCalled();
		expect(ModalCommands.popAll).not.toHaveBeenCalled();
		expect(http.get).not.toHaveBeenCalled();
	});
});

// the page asks for the profile without the mutual lists; they come only when About opens. A profile
// cached without them never answers a caller that wants them (the modal and the popup ask as before).
describe('fetch and the mutual lists', () => {
	const answer = (id: string) => ({
		body: {
			user: wireUser(id),
			user_profile: {bio: null, pronouns: null, banner: null, accent_color: null},
			timezone_offset: null,
		},
	});

	beforeEach(() => {
		vi.clearAllMocks();
		UserProfile.handleGatewayReady();
		vi.mocked(http.get).mockImplementation(async (url: string) => answer(url.split('/')[2]!) as never);
	});

	const queries = () => vi.mocked(http.get).mock.calls.map(([, options]) => (options as {query: unknown}).query);

	it('asks for the mutual lists by default', async () => {
		const profile = await UserProfileCommands.fetch('42');
		expect(queries()).toEqual([{with_mutual_friends: true, with_mutual_guilds: true}]);
		expect(profile.mutualsLoaded).toBe(true);
	});

	it('leaves them out when asked to, and marks the cached profile', async () => {
		const profile = await UserProfileCommands.fetch('42', undefined, false, {withMutuals: false});
		expect(queries()).toEqual([{}]);
		expect(profile.mutualsLoaded).toBe(false);
		expect(UserProfile.getProfile('42')?.mutualsLoaded).toBe(false);
	});

	it('a profile cached without them makes the next default fetch ask again, with them', async () => {
		await UserProfileCommands.fetch('42', undefined, false, {withMutuals: false});
		const profile = await UserProfileCommands.fetch('42');
		expect(queries()).toEqual([{}, {with_mutual_friends: true, with_mutual_guilds: true}]);
		expect(profile.mutualsLoaded).toBe(true);
	});

	it('a profile cached with them answers a fetch that does not need them', async () => {
		await UserProfileCommands.fetch('42');
		await UserProfileCommands.fetch('42', undefined, false, {withMutuals: false});
		expect(http.get).toHaveBeenCalledTimes(1);
	});

	it('a request without them in flight does not answer one that needs them', async () => {
		await Promise.all([
			UserProfileCommands.fetch('42', undefined, false, {withMutuals: false}),
			UserProfileCommands.fetch('42'),
		]);
		expect(queries()).toEqual([{}, {with_mutual_friends: true, with_mutual_guilds: true}]);
	});

	it('a request with them in flight answers one that does not need them', async () => {
		await Promise.all([
			UserProfileCommands.fetch('42'),
			UserProfileCommands.fetch('42', undefined, false, {withMutuals: false}),
		]);
		expect(http.get).toHaveBeenCalledTimes(1);
	});
});

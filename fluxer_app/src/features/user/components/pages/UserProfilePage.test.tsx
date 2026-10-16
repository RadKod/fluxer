// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {HttpError} from '@app/features/platform/types/EndpointError';
import {RelationshipTypes} from '@fluxer/constants/src/UserConstants';
import {runInAction} from 'mobx';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	users: new Map<string, unknown>(),
	relationship: undefined as number | undefined,
	bodyProps: null as null | Record<string, unknown>,
	listProps: null as null | Record<string, unknown>,
	gridProps: null as null | Record<string, unknown>,
	userInfoProps: null as null | Record<string, unknown>,
}));
const passThrough = ({children}: {children?: ReactNode}) => children;
const marker = (name: string) => () => createElement('i', {'data-part': name});

// Fills {name} and a "{key, plural, one {…} other {…}}" message (# is the number), enough to read the text.
function format(message: string, values?: Record<string, unknown>): string {
	if (!values) return message;
	return message
		.replace(/\{(\w+), plural, one \{(.*?)\} other \{(.*?)\}\}/g, (_, key: string, one: string, other: string) =>
			(values[key] === 1 ? one : other).replace('#', String(values[key])),
		)
		.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]));
}
const i18n = {
	_: (descriptor: {message: string}, values?: Record<string, unknown>) => format(descriptor.message, values),
	number: (value: number) => String(value),
	locale: 'en-US',
};

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n}), Trans: passThrough}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug() {}
		info() {}
		warn() {}
		error() {}
	},
}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http: {get: vi.fn()}}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {directMessagesDisabled: false, localInstanceDomain: 'micup.test'},
}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => 1000}}));
// Observable, as the limit behind it is: the page follows it while open.
vi.mock('@app/features/feed/utils/FeedUtils', async (importOriginal) => {
	const feed = (await import('mobx')).observable.box(true);
	return {
		...(await importOriginal<typeof import('@app/features/feed/utils/FeedUtils')>()),
		isFeedEnabled: () => feed.get(),
		feedForTest: feed,
	};
});
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: '1', isAuthenticated: true}}));
vi.mock('@app/features/platform/state/AuthSession', () => ({default: {isConnected: true}}));
vi.mock('@app/features/app/state/Initialization', () => ({default: {canNavigateToProtectedRoutes: true}}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {
		getUser: (id: string) => state.users.get(id) ?? null,
		handleUserUpdate: (wire: {id: string}) => state.users.set(wire.id, makeUser(wire)),
		currentUser: {isClaimed: () => true},
	},
}));
vi.mock('@app/features/relationship/state/Relationships', () => ({
	default: {getRelationship: () => (state.relationship === undefined ? undefined : {type: state.relationship})},
}));
vi.mock('@app/features/relationship/utils/RelationshipActionUtils', () => ({
	sendFriendRequest: vi.fn(),
	cancelFriendRequest: vi.fn(),
	showAcceptFriendRequestConfirmation: vi.fn(),
	showUnblockUserConfirmation: vi.fn(),
	shouldBypassRelationshipConfirmation: () => false,
}));
vi.mock('@app/features/channel/commands/PrivateChannelCommands', () => ({openDMChannel: vi.fn()}));
vi.mock('@app/features/app/components/alerts/DmActionErrorModal', () => ({showDmActionErrorModal: vi.fn()}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({
	push: vi.fn(),
	pop: vi.fn(),
	popAll: vi.fn(),
	popAllByType: vi.fn(),
	update: vi.fn(),
	modal: (render: unknown) => render,
}));
vi.mock('@app/features/ui/commands/ContextMenuCommands', () => ({
	openFromElementBottomRight: vi.fn(),
	openFromEvent: vi.fn(),
	close: vi.fn(),
}));
vi.mock('@app/features/ui/commands/PopoutCommands', () => ({closeAll: vi.fn()}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {enabled: false}}));
vi.mock('@app/features/user/state/UserProfileMobile', () => ({default: {close: vi.fn(), open: vi.fn()}}));
vi.mock('@app/features/user/components/modals/UserProfileModal', () => ({UserProfileModal: () => null}));
vi.mock('@app/features/user/components/modals/UserSettingsModal', () => ({UserSettingsModal: () => null}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => ({transitionTo: vi.fn(), replaceWith: vi.fn()}));
vi.mock('@app/features/channel/components/direct_message/DMPageFrame', () => ({
	DMPageFrame: ({title, children}: {title: string; children: ReactNode}) =>
		createElement('section', {'data-title': title}, children),
}));
vi.mock('@app/features/user/components/modals/user_profile_modal/ProfileMediaHeader', () => ({
	ProfileMediaHeader: ({renderActionButtons, identity}: {renderActionButtons: () => ReactNode; identity?: ReactNode}) =>
		createElement('header', null, identity, renderActionButtons()),
}));
vi.mock('@app/features/user/components/modals/user_profile_modal/UserProfileModalUserInfo', () => ({
	UserInfo: (props: Record<string, unknown>) => {
		state.userInfoProps = props;
		return createElement('i', {'data-part': 'user-info'});
	},
}));
vi.mock('@app/features/user/components/modals/user_profile_modal/ProfileBody', () => ({
	ProfileBody: (props: Record<string, unknown>) => {
		state.bodyProps = props;
		return createElement('i', {'data-part': 'about'});
	},
}));
vi.mock('@app/features/cosmetics/components/ProfileEffectOverlay', () => ({ProfileEffectOverlay: () => null}));
vi.mock('@app/features/user/components/profile/UserProfileLoadingSkeleton', () => ({
	UserProfileLoadingSkeleton: marker('skeleton'),
}));
vi.mock('@app/features/feed/components/FeedTimelineList', () => ({
	FeedTimelineList: (props: Record<string, unknown>) => {
		state.listProps = props;
		return createElement('i', {'data-part': 'posts'});
	},
}));
vi.mock('@app/features/user/components/pages/ProfileMediaGrid', () => ({
	ProfileMediaGrid: (props: Record<string, unknown>) => {
		state.gridProps = props;
		return createElement('i', {'data-part': 'media'});
	},
}));
vi.mock('@app/features/follow/components/ProfileFollowActions', () => ({ProfileFollowButton: marker('follow-button')}));
vi.mock('@app/features/follow/components/FollowListModal', () => ({FollowListModal: () => null}));
vi.mock('@app/features/ui/components/Avatar', () => ({Avatar: () => null}));
vi.mock('@app/features/ui/action_menu/UserContextMenu', () => ({UserContextMenu: () => null}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick, ...rest}: {children?: ReactNode; onClick?: () => void; 'aria-label'?: string}) =>
		createElement('button', {type: 'button', onClick, 'aria-label': rest['aria-label']}, children),
}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: passThrough}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: passThrough}));
vi.mock('@app/features/ui/tabs/Tabs', () => ({
	Tabs: ({tabs, onTabChange}: {tabs: Array<{key: string; label: string}>; onTabChange: (key: string) => void}) =>
		createElement(
			'div',
			{role: 'tablist'},
			tabs.map((tab) =>
				createElement(
					'button',
					{key: tab.key, type: 'button', role: 'tab', onClick: () => onTabChange(tab.key)},
					tab.label,
				),
			),
		),
}));
vi.mock('@app/features/user/utils/ProfileDisplayUtils', () => ({
	getProfileAvatarUrls: () => ({avatarUrl: null, hoverAvatarUrl: null}),
	getProfileBannerUrls: () => ({bannerUrl: null, hoverBannerUrl: null}),
}));
vi.mock('@app/features/user/utils/ProfileGuildMembership', () => ({
	resolveProfileGuildMembership: () => ({}),
	toProfileDisplayContext: () => ({}),
}));
vi.mock('@app/features/theme/utils/AccentColorUtils', () => ({getUserAccentColor: () => '#000000'}));
vi.mock('@app/features/user/state/UserNote', () => ({default: {getUserNote: () => null}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getNickname: (user: {username: string}) => user.username}));

const {User} = await import('@app/features/user/models/User');
function makeUser(wire: {id: string}) {
	return new User(wire as never);
}
const {http} = await import('@app/features/platform/transport/RestTransport');
const ModalCommands = await import('@app/features/ui/commands/ModalCommands');
const RouterUtils = await import('@app/features/navigation/utils/RouterUtils');
const PrivateChannelCommands = await import('@app/features/channel/commands/PrivateChannelCommands');
const {default: UserProfile} = await import('@app/features/user/state/UserProfile');
const {default: FeedTimeline} = await import('@app/features/feed/state/FeedTimeline');
const {Profile} = await import('@app/features/user/models/Profile');
const {useUserProfileSurfaceState} = await import('@app/features/user/hooks/useUserProfileSurfaceState');
const {createMockProfile} = await import('@app/features/user/utils/ProfileUtils');
const {UserProfilePage} = await import('@app/features/user/components/pages/UserProfilePage');
const {feedForTest} = (await import('@app/features/feed/utils/FeedUtils')) as unknown as {
	feedForTest: {set: (value: boolean) => void};
};
const setFeed = (enabled: boolean) => act(() => runInAction(() => feedForTest.set(enabled)));

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
function wireProfile(id: string, fields: Record<string, unknown> = {}) {
	return {
		user: wireUser(id),
		user_profile: {bio: null, pronouns: null, banner: null, accent_color: null},
		timezone_offset: null,
		follower_count: 12,
		following_count: 3,
		is_following: false,
		...fields,
	};
}
const refuse = (status: number) => new HttpError({method: 'GET', path: '/users/42/profile', status});

type Answer = Record<string, unknown> | HttpError;
let profileAnswer: Answer;
function answerRequests() {
	vi.mocked(http.get).mockImplementation(async (url: string) => {
		if (url.endsWith('/profile')) {
			if (profileAnswer instanceof HttpError) throw profileAnswer;
			return {ok: true, status: 200, statusText: '', headers: {}, body: profileAnswer} as never;
		}
		return {ok: true, status: 200, statusText: '', headers: {}, body: []} as never;
	});
}
const requests = () =>
	vi.mocked(http.get).mock.calls.map(([url, options]) => ({url, query: (options as {query?: unknown})?.query}));

describe('UserProfilePage', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		state.users.clear();
		state.relationship = undefined;
		setFeed(true);
		state.bodyProps = null;
		state.listProps = null;
		state.gridProps = null;
		state.userInfoProps = null;
		UserProfile.handleGatewayReady();
		FeedTimeline.reset();
		profileAnswer = wireProfile('42');
		answerRequests();
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const open = async (userId = '42') => {
		await act(async () => root.render(createElement(UserProfilePage, {userId})));
		await act(async () => {});
	};
	const text = () => container.textContent ?? '';
	const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].map((tab) => tab.textContent);
	const clickTab = (label: string) =>
		act(async () =>
			[...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) => t.textContent === label)!.click(),
		);
	const button = (label: string) =>
		[...container.querySelectorAll<HTMLButtonElement>('button')].find(
			(element) => element.textContent === label || element.getAttribute('aria-label') === label,
		) ?? null;

	it.each(['../../users/@me/settings', '0x10', '0', '12ab'])(
		'sends no request for %j and shows "user not found" (R1)',
		async (id) => {
			await open(id);
			expect(http.get).not.toHaveBeenCalled();
			expect(text()).toContain('User not found');
		},
	);

	it.each([400, 404])('shows "user not found", not a skeleton, when the server answers %i', async (status) => {
		profileAnswer = refuse(status);
		await open();
		expect(text()).toContain('User not found');
		expect(container.querySelector('[data-part="skeleton"]')).toBeNull();
		expect(requests().map((request) => request.url)).toEqual(['/users/42/profile']);
	});

	it('on 403 shows "you cannot see" with the known name and asks for no posts or lists', async () => {
		state.users.set('42', makeUser(wireUser('42')));
		profileAnswer = refuse(403);
		await open();
		expect(text()).toContain("You can't see this profile");
		expect(text()).toContain('user42');
		expect(text()).not.toContain('No posts to show.');
		expect(requests().map((request) => request.url)).toEqual(['/users/42/profile']);
	});

	it('opens with the profile (no mutual lists asked) and one more request, the first page of posts', async () => {
		await open();
		expect(requests()).toEqual([
			{url: '/users/42/profile', query: {}},
			{url: '/users/42/posts', query: {limit: 25}},
		]);
	});

	it('a profile cached in the last 60 s costs no request: only the first page of posts goes out', async () => {
		state.users.set('42', makeUser(wireUser('42')));
		UserProfile.handleProfileCreate(new Profile(wireProfile('42') as never));
		await open();
		expect(requests().map((request) => request.url)).toEqual(['/users/42/posts']);
	});

	it('asks for the mutual friends and communities only when About opens (denetim 4b)', async () => {
		await open();
		expect(requests().some((request) => JSON.stringify(request.query).includes('with_mutual'))).toBe(false);
		await clickTab('About');
		expect(requests().at(-1)).toEqual({
			url: '/users/42/profile',
			query: {with_mutual_friends: true, with_mutual_guilds: true},
		});
	});

	it('a profile cached by the page without mutuals makes the modal ask again with them', async () => {
		await open();
		vi.mocked(http.get).mockClear();
		const Modal = () => {
			const fallbackProfile = createMockProfile(makeUser(wireUser('42')));
			const {profile} = useUserProfileSurfaceState({userId: '42', enabled: true, fallbackProfile});
			return createElement('i', {'data-mutuals': String(profile?.mutualsLoaded)});
		};
		const modalContainer = document.createElement('div');
		const modalRoot = createRoot(modalContainer);
		await act(async () => modalRoot.render(createElement(Modal)));
		expect(requests()).toEqual([
			{url: '/users/42/profile', query: {with_mutual_friends: true, with_mutual_guilds: true}},
		]);
		expect(modalContainer.querySelector('[data-mutuals]')!.getAttribute('data-mutuals')).toBe('true');
		act(() => modalRoot.unmount());
	});

	it('a limited profile shows the header and a note, asks for no posts or lists, and has no tabs', async () => {
		profileAnswer = wireProfile('42', {profile_limited: true, follower_count: undefined, following_count: undefined});
		await open();
		expect(container.querySelector('[data-part="user-info"]')).not.toBeNull();
		expect(text()).toContain('This person shows their profile only to certain people.');
		expect(tabs()).toEqual([]);
		expect(text()).not.toContain('followers');
		expect(requests().map((request) => request.url)).toEqual(['/users/42/profile']);
	});

	it('shows Posts | Media | About; About holds the profile body without a second user info', async () => {
		await open();
		expect(tabs()).toEqual(['Posts', 'Media', 'About']);
		expect(container.querySelector('[data-part="posts"]')).not.toBeNull();
		expect(state.userInfoProps?.onPage).toBe(true);
		await clickTab('About');
		expect(container.querySelector('[data-part="about"]')).not.toBeNull();
		expect(state.bodyProps?.hideUserInfo).toBe(true);
	});

	it('Posts shows the user timeline under the header; Media shows the grid of the same timeline', async () => {
		await open();
		expect(state.listProps?.timelineKey).toBe('user:42');
		expect(state.listProps?.scrollerRef).toBeDefined();
		await clickTab('Media');
		expect(container.querySelector('[data-part="posts"]')).toBeNull();
		expect(state.gridProps?.timelineKey).toBe('user:42');
		// Switching tabs keeps the timeline: no second first page.
		expect(requests().filter((request) => request.url.endsWith('/posts'))).toHaveLength(1);
	});

	it("hides Posts and Media when the viewer's feed is off, opens on About and asks for no posts", async () => {
		setFeed(false);
		await open();
		expect(tabs()).toEqual(['About']);
		expect(container.querySelector('[data-part="about"]')).not.toBeNull();
		expect(requests().every((request) => request.url.endsWith('/profile'))).toBe(true);
	});

	it('falls back to About when the feed closes while Posts is open', async () => {
		await open();
		setFeed(false);
		expect(tabs()).toEqual(['About']);
		expect(container.querySelector('[data-part="about"]')).not.toBeNull();
		expect(container.querySelector('[data-part="posts"]')).toBeNull();
	});

	it('says "No posts to show" on someone else\'s profile and "No posts yet" on your own', async () => {
		await open();
		expect(state.listProps?.emptyText).toBe('No posts to show.');
		act(() => root.unmount());
		root = createRoot(container);
		profileAnswer = wireProfile('1', {is_following: undefined});
		await open('1');
		expect(state.listProps?.emptyText).toBe('No posts yet.');
	});

	it('on your own profile shows "Edit profile" (Settings > Profile) instead of Message and Follow', async () => {
		profileAnswer = wireProfile('1', {is_following: undefined});
		await open('1');
		expect(button('Edit profile')).not.toBeNull();
		expect(button('Edit profile')?.closest('[data-flx="user.user-profile-page.header.card"]')).not.toBeNull();
		expect(container.querySelector('[data-flx="user.user-profile-page.content.actions-row"]')).toBeNull();
		expect(button('Message')).toBeNull();
		expect(container.querySelector('[data-part="follow-button"]')).toBeNull();
		act(() => button('Edit profile')!.click());
		const render = vi.mocked(ModalCommands.push).mock.calls[0]![0] as unknown as () => {props: {initialTab: string}};
		expect(render().props.initialTab).toBe('my_profile');
	});

	it("on someone else's profile shows Message, Follow, Add friend and more", async () => {
		await open();
		expect(button('Message')).not.toBeNull();
		expect(button('Message')?.closest('[data-flx="user.user-profile-page.header.card"]')).not.toBeNull();
		expect(container.querySelector('[data-flx="user.user-profile-page.content.actions-row"]')).toBeNull();
		expect(container.querySelector('[data-part="follow-button"]')).not.toBeNull();
		expect(button('Add friend')).not.toBeNull();
		expect(button('More options')).not.toBeNull();
		await act(async () => button('Message')!.click());
		expect(PrivateChannelCommands.openDMChannel).toHaveBeenCalledWith('42');
	});

	it('a blocked account offers Unblock and no Message', async () => {
		state.relationship = RelationshipTypes.BLOCKED;
		await open();
		expect(button('Message')).toBeNull();
		expect(button('Unblock')).not.toBeNull();
	});

	it('follower and following counts open the follow window on the matching list', async () => {
		await open();
		act(() => button('12 followers')!.click());
		act(() => button('3 following')!.click());
		const kinds = vi
			.mocked(ModalCommands.push)
			.mock.calls.map(([render]) => (render as unknown as () => {props: {initialKind: string}})().props.initialKind);
		expect(kinds).toEqual(['followers', 'following']);
	});

	it('the mutual friend row opens that profile page, not a modal (R5b)', async () => {
		await open();
		await clickTab('About');
		const {onOpenUser, onLeave} = state.bodyProps as {onOpenUser: (id: string) => void; onLeave: () => void};
		onOpenUser('7');
		expect(RouterUtils.transitionTo).toHaveBeenCalledWith('/users/7');
		onLeave();
		expect(ModalCommands.pop).not.toHaveBeenCalled();
	});

	// The client keeps a profile 60 s and drops it sooner when it changes (an edit of your own, a community joined); the
	// page outlives both, and its Follow button and counts read that cache.
	it('asks for the profile again when the client cache drops it while the page shows it', async () => {
		await open();
		vi.mocked(http.get).mockClear();
		await act(async () => UserProfile.handleProfileInvalidate('42'));
		expect(requests()).toEqual([{url: '/users/42/profile', query: {}}]);
		expect(UserProfile.getProfile('42')).not.toBeNull();
		expect(container.querySelector('[data-part="user-info"]')).not.toBeNull();
	});
});

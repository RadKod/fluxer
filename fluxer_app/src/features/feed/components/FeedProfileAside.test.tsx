// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {ProfilePrivacyLevels, PublicUserFlags} from '@fluxer/constants/src/UserConstants';
import {runInAction} from 'mobx';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Observable like the UserProfile store it stands in for, so a test can change the profile under a mounted rail (a
// Profile is a class instance, which MobX keeps as it is).
const stored = await vi.hoisted(async () => {
	const {observable} = await import('mobx');
	return observable({profile: null as unknown, discover: true, privacy: 0, hydrated: true});
});

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {localInstanceDomain: 'micup.test', mediaEndpoint: 'https://media.micup.test'},
}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({
	LimitResolver: {
		resolve: ({key}: {key: string}) => (key === 'feature_feed_discover' ? Number(stored.discover) : 1000),
	},
}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http: {get: vi.fn(), post: vi.fn()}}));
vi.mock('@app/features/user/commands/UserProfileCommands', () => ({fetch: vi.fn()}));
vi.mock('@app/features/user/state/UserProfile', () => ({default: {getProfile: () => stored.profile}}));
vi.mock('@app/features/user/state/UserSettings', () => ({
	default: {getProfilePrivacy: () => stored.privacy, isHydrated: () => stored.hydrated},
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick}: {children: ReactNode; onClick: () => void}) =>
		createElement('button', {type: 'button', onClick}, children),
}));
vi.mock('@app/features/ui/components/Avatar', () => ({
	Avatar: ({user, size}: {user: {id: string}; size: number}) =>
		createElement('span', {'data-avatar-user': user.id, 'data-avatar-size': size}),
}));
vi.mock('@app/features/ui/components/icons/VerifiedBadgeIcon', () => ({VerifiedBadgeIcon: () => null}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/user/state/Users', () => ({default: {currentUser: null}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({
	getNickname: (user: {username: string}) => user.username,
	formatTagForStreamerMode: vi.fn((tag: string) => tag),
}));

const {http} = await import('@app/features/platform/transport/RestTransport');
const NicknameUtils = await import('@app/features/user/utils/NicknameUtils');
const UserProfileCommands = await import('@app/features/user/commands/UserProfileCommands');
const {default: Users} = await import('@app/features/user/state/Users');
const {User} = await import('@app/features/user/models/User');
const {Profile} = await import('@app/features/user/models/Profile');
const {FeedProfileAside} = await import('@app/features/feed/components/FeedProfileAside');

const signedIn = (fields: {banner?: string | null; accent_color?: number | null} = {}) =>
	new User({
		id: '1',
		username: 'epha',
		discriminator: '0001',
		global_name: null,
		avatar: null,
		avatar_color: null,
		flags: PublicUserFlags.VERIFIED,
		public_profile_allowed: true, // a stored public level counts only while the account may have one
		...fields,
	});

const loadedProfile = (user: InstanceType<typeof User>, userProfile: {banner: string | null; accent_color: number}) =>
	new Profile({
		user: user.toJSON(),
		user_profile: {bio: null, pronouns: null, ...userProfile},
		timezone_offset: null,
	} as never);

describe('FeedProfileAside', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const byFlx = (flx: string) => container.querySelector<HTMLElement>(`[data-flx="${flx}"]`);
	const render = (props: {onShowPosts?: () => void} = {}) =>
		act(() => root.render(createElement(FeedProfileAside, props)));

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		(Users as {currentUser: unknown}).currentUser = signedIn();
		stored.profile = null;
		stored.discover = true;
		stored.privacy = ProfilePrivacyLevels.ALL_GUILDS;
		stored.hydrated = true;
		vi.clearAllMocks();
		vi.mocked(NicknameUtils.formatTagForStreamerMode).mockImplementation((tag: string) => tag);
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it('shows your 80px avatar, name, tick and name#discriminator tag without any request', () => {
		render();
		expect(container.querySelector('[data-avatar-user="1"]')!.getAttribute('data-avatar-size')).toBe('80');
		expect(container.querySelector('[aria-label="Verified account"]')).not.toBeNull();
		expect(container.textContent).toContain('epha#0001');
		expect(container.textContent).not.toContain('@epha');
		expect(http.get).not.toHaveBeenCalled();
		expect(UserProfileCommands.fetch).not.toHaveBeenCalled();
	});

	it('opens your posts from its button, and has no button when there is nowhere to go', () => {
		const onShowPosts = vi.fn();
		render({onShowPosts});
		const button = Array.from(container.querySelectorAll('button')).find((entry) => entry.textContent === 'Your posts');
		act(() => button!.click());
		expect(onShowPosts).toHaveBeenCalledTimes(1);
		render();
		expect(container.querySelector('button')).toBeNull();
	});

	it('renders nothing before the account is known', () => {
		(Users as {currentUser: unknown}).currentUser = null;
		render();
		expect(container.innerHTML).toBe('');
	});

	it('shows the streamer-mode tag instead of the full name#discriminator', () => {
		vi.mocked(NicknameUtils.formatTagForStreamerMode).mockReturnValue('e…');
		render();
		expect(byFlx('feed.feed-profile-aside.tag')?.textContent).toBe('e…');
		expect(container.textContent).not.toContain('epha#0001');
	});

	it('draws the cover image when the user has a banner', () => {
		stored.profile = loadedProfile(signedIn(), {banner: 'bannerhash', accent_color: 0x123456});
		render();
		const image = byFlx('feed.feed-profile-aside.cover')!.querySelector('img')!;
		// The media proxy banner at the popout size (MEDIA_PROXY_PROFILE_BANNER_SIZE_POPOUT), not the 1024 modal size.
		expect(image.getAttribute('src')).toBe('https://media.micup.test/banners/1/bannerhash.webp?size=600');
		expect(image.getAttribute('alt')).toBe('');
		expect(image.getAttribute('loading')).toBe('lazy');
	});

	// The rail stays mounted beside the feed: a profile stored later (opened elsewhere, or changed) shows at once, though
	// the account object is the same one.
	it('follows the stored profile when it arrives after the first render', () => {
		render();
		expect(byFlx('feed.feed-profile-aside.cover')!.querySelector('img')).toBeNull();
		// No new props: only the store changes, as when the profile loads elsewhere while the rail stays mounted.
		act(() =>
			runInAction(() => {
				stored.profile = loadedProfile(signedIn(), {banner: 'bannerhash', accent_color: 0x123456});
			}),
		);
		expect(byFlx('feed.feed-profile-aside.cover')!.querySelector('img')?.getAttribute('src')).toBe(
			'https://media.micup.test/banners/1/bannerhash.webp?size=600',
		);
	});

	it('paints the cover with the profile accent colour when there is no banner', () => {
		(Users as {currentUser: unknown}).currentUser = signedIn({accent_color: 0xff0000});
		stored.profile = loadedProfile(signedIn(), {banner: null, accent_color: 0x123456});
		render();
		const cover = byFlx('feed.feed-profile-aside.cover')!;
		expect(cover.querySelector('img')).toBeNull();
		expect(cover.getAttribute('style')).toMatch(/background-color: (#123456|rgb\(18, 52, 86\))/);
	});

	it('falls back to a mock profile without any request', () => {
		(Users as {currentUser: unknown}).currentUser = signedIn({banner: 'ownbanner', accent_color: 0x654321});
		render();
		const cover = byFlx('feed.feed-profile-aside.cover')!;
		expect(cover.querySelector('img')!.getAttribute('src')).toBe(
			'https://media.micup.test/banners/1/ownbanner.webp?size=600',
		);
		expect(cover.getAttribute('style')).toMatch(/background-color: (#654321|rgb\(101, 67, 33\))/);
		expect(http.get).not.toHaveBeenCalled();
		expect(UserProfileCommands.fetch).not.toHaveBeenCalled();
	});

	// Micup: the note follows the public profile; narrowing closes posts to strangers on their next request
	// and Discover drops them shortly after, so the note says "shortly", not "at once".
	const PUBLIC_NOTE =
		'Your profile is public: anyone signed in can see your posts, and new ones can appear in Discover. If you limit your profile in Privacy, your posts close to strangers, and they leave Discover shortly after.';

	it('shows the public posts note while the profile is public', () => {
		stored.privacy = ProfilePrivacyLevels.EVERYONE;
		render();
		expect(byFlx('feed.feed-profile-aside.note')?.textContent).toBe(PUBLIC_NOTE);
	});

	// No note with Discover off, any narrower profile or before the settings load. No second text for a limited profile.
	it('has no note while the profile is not public', () => {
		const cases: Array<Partial<{discover: boolean; privacy: number; hydrated: boolean}>> = [
			{discover: false},
			{privacy: ProfilePrivacyLevels.ALL_GUILDS},
			{privacy: ProfilePrivacyLevels.SMALL_GUILDS_ONLY},
			{privacy: ProfilePrivacyLevels.FRIENDS_ONLY},
			{privacy: ProfilePrivacyLevels.ONLY_ME},
			{hydrated: false},
		];
		for (const change of cases) {
			Object.assign(stored, {discover: true, privacy: ProfilePrivacyLevels.EVERYONE, hydrated: true}, change);
			render({onShowPosts: () => {}});
			expect(byFlx('feed.feed-profile-aside.note')).toBeNull();
			expect(container.textContent).not.toContain('Discover');
		}
	});

	// Feed design the card shows no follower, following or post counts.
	it('has no follow counts', () => {
		stored.profile = new Profile({
			user: signedIn().toJSON(),
			user_profile: {bio: null, banner: null, pronouns: null, accent_color: null},
			timezone_offset: null,
			follower_count: 1382,
			following_count: 211,
		} as never);
		render({onShowPosts: () => {}});
		expect(container.textContent).not.toMatch(/1382|1\.382|211/);
		expect(container.textContent).not.toMatch(/follow/i);
	});
});

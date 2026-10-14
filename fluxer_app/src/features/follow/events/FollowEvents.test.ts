// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import type {ProfileWire} from '@app/features/user/models/Profile';
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: 'me'}}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'fluxer.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => 1000}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {getUser: (id: string) => (id === 'gone' ? undefined : {toJSON: () => wireUser(id)})},
}));

const {handleFollowCreate} = await import('@app/features/follow/events/FollowCreate');
const {handleFollowDelete} = await import('@app/features/follow/events/FollowDelete');
const {Profile} = await import('@app/features/user/models/Profile');
const {default: UserProfile} = await import('@app/features/user/state/UserProfile');
const {default: FeedTimeline, DISCOVER_TIMELINE} = await import('@app/features/feed/state/FeedTimeline');

const CONTEXT = {} as GatewayHandlerContext;

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

function seedProfile(userId: string, fields: Partial<ProfileWire>): void {
	UserProfile.handleProfileCreate(
		new Profile({
			user: wireUser(userId),
			user_profile: {bio: null, pronouns: null, banner: null, accent_color: null},
			timezone_offset: null,
			...fields,
		}),
	);
}

function followState(userId: string) {
	const profile = UserProfile.getProfile(userId);
	return {following: profile?.isFollowing, followers: profile?.followerCount, followingCount: profile?.followingCount};
}

beforeEach(() => {
	UserProfile.handleGatewayReady();
	seedProfile('me', {follower_count: 5, following_count: 3});
});

describe('FOLLOW_CREATE', () => {
	it('marks the followed profile and counts the follow once', () => {
		seedProfile('42', {is_following: false, follower_count: 10, following_count: 1});
		handleFollowCreate({id: '7001', user: wireUser('42')}, CONTEXT);
		expect(followState('42')).toEqual({following: true, followers: 11, followingCount: 1});
		expect(followState('me').followingCount).toBe(4);
		handleFollowCreate({id: '7001', user: wireUser('42')}, CONTEXT);
		expect(followState('42').followers).toBe(11);
		expect(followState('me').followingCount).toBe(4);
	});

	it('keeps counts hidden on a profile that does not show them', () => {
		seedProfile('42', {is_following: false});
		handleFollowCreate({id: '7001', user: wireUser('42')}, CONTEXT);
		expect(followState('42')).toEqual({following: true, followers: null, followingCount: null});
	});

	it('leaves the store alone when the followed profile is not cached', () => {
		handleFollowCreate({id: '7001', user: wireUser('42')}, CONTEXT);
		expect(UserProfile.getProfile('42')).toBeNull();
		expect(followState('me').followingCount).toBe(3);
	});

	it('drops a cached profile it cannot rebuild instead of throwing', () => {
		seedProfile('gone', {is_following: false, follower_count: 1});
		expect(() => handleFollowCreate({id: '7001', user: wireUser('gone')}, CONTEXT)).not.toThrow();
		expect(UserProfile.getProfile('gone')).toBeNull();
	});
});

describe('FOLLOW_DELETE', () => {
	it('clears the follow and counts the unfollow once', () => {
		seedProfile('42', {is_following: true, follower_count: 11, following_count: 1});
		handleFollowDelete({user_id: '42'}, CONTEXT);
		expect(followState('42')).toEqual({following: false, followers: 10, followingCount: 1});
		expect(followState('me').followingCount).toBe(2);
		handleFollowDelete({user_id: '42'}, CONTEXT);
		expect(followState('42').followers).toBe(10);
		expect(followState('me').followingCount).toBe(2);
	});
});

describe('Discover cards', () => {
	it("FOLLOW_CREATE and FOLLOW_DELETE flip the author's Discover cards", () => {
		FeedTimeline.reset();
		FeedTimeline.open(DISCOVER_TIMELINE);
		FeedTimeline.handleFetchSuccess(
			DISCOVER_TIMELINE,
			[
				{
					id: '900',
					author: wireUser('42'),
					content: 'hello',
					attachments: [],
					edited_at: null,
					like_count: 0,
					comment_count: 0,
					liked: false,
					public: true,
					author_following: false,
				},
			],
			true,
			'1.1',
		);
		// Followed from another session: the profile is not cached here, the card is.
		handleFollowCreate({id: '7001', user: wireUser('42')}, CONTEXT);
		expect(FeedTimeline.getPost('900')!.authorFollowing).toBe(true);
		expect(followState('me').followingCount).toBe(4);
		handleFollowDelete({user_id: '42'}, CONTEXT);
		expect(FeedTimeline.getPost('900')!.authorFollowing).toBe(false);
		expect(followState('me').followingCount).toBe(3);
		FeedTimeline.reset();
	});
});

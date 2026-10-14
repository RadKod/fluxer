// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Profile, ProfileWire} from '@app/features/user/models/Profile';
import type {User} from '@app/features/user/models/User';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/utils/AppLogger', () => ({Logger: class {}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: 'me'}}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {getUser: (id: string) => ({toJSON: () => wireUser(id)})},
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'fluxer.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => 1000}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));

const {applyFollowChange, canFollowThroughPost, getFollowControls} = await import(
	'@app/features/follow/utils/FollowProfileUtils'
);
const {default: FeedTimeline, DISCOVER_TIMELINE} = await import('@app/features/feed/state/FeedTimeline');
const {default: FeedSuggestionPicks} = await import('@app/features/feed/state/FeedSuggestionPicks');
const {Profile: ProfileModel} = await import('@app/features/user/models/Profile');
const {default: UserProfile} = await import('@app/features/user/state/UserProfile');
const {default: FollowLists} = await import('@app/features/follow/state/FollowLists');

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

function profileWith(fields: Partial<Pick<Profile, 'isFollowing' | 'followerCount' | 'followingCount'>>): Profile {
	return {isFollowing: null, followerCount: null, followingCount: null, ...fields} as Profile;
}

const PERSON = {id: '42', bot: false, system: false} as User;

describe('getFollowControls', () => {
	it('shows the button and the counts when the profile carries them', () => {
		expect(
			getFollowControls(profileWith({isFollowing: false, followerCount: 3, followingCount: 1}), PERSON, 'me'),
		).toEqual({canFollow: true, showCounts: true});
	});

	it('hides both on a restricted profile that leaves the fields out', () => {
		expect(getFollowControls(profileWith({}), PERSON, 'me')).toEqual({canFollow: false, showCounts: false});
	});

	it('shows only the counts on your own profile', () => {
		const self = {...PERSON, id: 'me'} as User;
		expect(getFollowControls(profileWith({followerCount: 3, followingCount: 1}), self, 'me')).toEqual({
			canFollow: false,
			showCounts: true,
		});
	});

	it('never offers to follow a bot or a system account', () => {
		const fields = {isFollowing: false, followerCount: 3, followingCount: 1};
		expect(getFollowControls(profileWith(fields), {...PERSON, bot: true} as User, 'me').canFollow).toBe(false);
		expect(getFollowControls(profileWith(fields), {...PERSON, system: true} as User, 'me').canFollow).toBe(false);
	});
});

describe('applyFollowChange', () => {
	function seedProfile(userId: string, fields: Partial<ProfileWire>): void {
		UserProfile.handleProfileCreate(
			new ProfileModel({
				user: wireUser(userId),
				user_profile: {bio: null, pronouns: null, banner: null, accent_color: null},
				timezone_offset: null,
				...fields,
			}),
		);
	}

	function discoverPost(id: string, authorId: string) {
		return {
			id,
			author: wireUser(authorId),
			content: 'hello',
			attachments: [],
			edited_at: null,
			like_count: 0,
			comment_count: 0,
			liked: false,
			public: true,
			author_following: false,
		};
	}

	const myFollowingCount = () => UserProfile.getProfile('me')?.followingCount;

	it('moves my following count once when only Discover cards flip, and not again on the echo', () => {
		UserProfile.handleGatewayReady();
		FeedTimeline.reset();
		seedProfile('me', {follower_count: 5, following_count: 3});
		seedProfile('42', {is_following: false, follower_count: 10});
		FeedTimeline.open(DISCOVER_TIMELINE);
		FeedTimeline.handleFetchSuccess(
			DISCOVER_TIMELINE,
			[discoverPost('1', '77'), discoverPost('2', '77'), discoverPost('3', '42')],
			true,
			'1.3',
		);
		// A stranger known only from Discover cards: both cards flip, my count moves once.
		expect(applyFollowChange('77', true)).toBe(true);
		expect(FeedTimeline.getPost('1')!.authorFollowing).toBe(true);
		expect(FeedTimeline.getPost('2')!.authorFollowing).toBe(true);
		expect(myFollowingCount()).toBe(4);
		// The FOLLOW_CREATE echo of the same follow changes nothing.
		expect(applyFollowChange('77', true)).toBe(false);
		expect(myFollowingCount()).toBe(4);
		// A profile and a card of the same author flip together: still one move.
		expect(applyFollowChange('42', true)).toBe(true);
		expect(FeedTimeline.getPost('3')!.authorFollowing).toBe(true);
		expect(UserProfile.getProfile('42')?.isFollowing).toBe(true);
		expect(myFollowingCount()).toBe(5);
		FeedTimeline.reset();
	});

	// Micup akis-oneri: the one way in for the list beside the feed, whose people have no cached profile.
	it('flips a suggested person beside the feed and moves my following count once, not again on the echo', () => {
		UserProfile.handleGatewayReady();
		FeedSuggestionPicks.reset();
		FeedSuggestionPicks.handleLoaded(FeedSuggestionPicks.beginLoad()!, {userIds: ['55'], guilds: []});
		seedProfile('me', {follower_count: 5, following_count: 3});
		expect(applyFollowChange('55', true)).toBe(true);
		expect(FeedSuggestionPicks.isFollowed('55')).toBe(true);
		expect(myFollowingCount()).toBe(4);
		expect(applyFollowChange('55', true)).toBe(false);
		expect(myFollowingCount()).toBe(4);
		// An unfollow from anywhere (the profile, another device's FOLLOW_DELETE) turns the list back to Follow.
		expect(applyFollowChange('55', false)).toBe(true);
		expect(FeedSuggestionPicks.isFollowed('55')).toBe(false);
		expect(myFollowingCount()).toBe(3);
		FeedSuggestionPicks.reset();
	});

	// Micup: the Follow button on the rows of an open follow window, whose people have no cached profile.
	it('flips a row of an open follow list and moves my following count once, not again on the echo', () => {
		UserProfile.handleGatewayReady();
		seedProfile('me', {follower_count: 5, following_count: 3});
		const listId = FollowLists.open('followers', '42');
		FollowLists.handleFetchSuccess(listId, [
			{id: '91', user: wireUser('7'), is_following: false},
			{id: '90', user: wireUser('8')},
		]);
		expect(applyFollowChange('7', true)).toBe(true);
		expect(FollowLists.getEntries(listId).map((entry) => entry.isFollowing)).toEqual([true, undefined]);
		expect(myFollowingCount()).toBe(4);
		expect(applyFollowChange('7', true)).toBe(false);
		expect(myFollowingCount()).toBe(4);
		// A row the server sent without is_following (an older server) has no button to flip.
		expect(applyFollowChange('8', true)).toBe(false);
		expect(FollowLists.getEntries(listId)[1]!.isFollowing).toBeUndefined();
		FollowLists.close(listId);
	});
});

describe('canFollowThroughPost', () => {
	const HOUR = 3_600_000;
	const NOW = Date.UTC(2026, 8, 28, 12);
	const viewer = ({verified = true, claimed = true, ageHours = 48} = {}) => ({
		verified,
		isClaimed: () => claimed,
		createdAt: new Date(NOW - ageHours * HOUR),
	});

	it('asks what the server asks of a stranger following through a post: a verified email, a claimed account, 24 hours', () => {
		expect(canFollowThroughPost(viewer(), NOW)).toBe(true);
		expect(canFollowThroughPost(viewer({ageHours: 24}), NOW)).toBe(true);
		expect(canFollowThroughPost(viewer({ageHours: 23.9}), NOW)).toBe(false);
		expect(canFollowThroughPost(viewer({verified: false}), NOW)).toBe(false);
		// A user object without the private fields (not the signed-in account's own payload).
		expect(canFollowThroughPost({...viewer(), verified: undefined}, NOW)).toBe(false);
		expect(canFollowThroughPost(viewer({claimed: false}), NOW)).toBe(false);
		expect(canFollowThroughPost(null, NOW)).toBe(false);
	});
});

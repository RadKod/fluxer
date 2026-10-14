// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {HttpError} from '@app/features/platform/types/EndpointError';
import type {RestResponse} from '@app/features/platform/types/TransportTypes';
import type {ProfileWire} from '@app/features/user/models/Profile';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {FollowResponse} from '@fluxer/schema/src/domains/follow/FollowResponseSchemas';
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'fluxer.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => 1000}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: 'me'}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {getUser: (id: string) => ({toJSON: () => wireUser(id)})},
}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({
	http: {get: vi.fn(), put: vi.fn(), delete: vi.fn()},
}));
vi.mock('@app/features/user/utils/AccountLimitUtils', () => ({
	blockIfAccountLimited: vi.fn(() => false),
	handleAccountLimitedError: vi.fn(() => false),
}));

const {http} = await import('@app/features/platform/transport/RestTransport');
const AccountLimitUtils = await import('@app/features/user/utils/AccountLimitUtils');
const FollowCommands = await import('@app/features/follow/commands/FollowCommands');
const {default: FollowLists} = await import('@app/features/follow/state/FollowLists');
const {Profile} = await import('@app/features/user/models/Profile');
const {default: UserProfile} = await import('@app/features/user/state/UserProfile');
const {default: FeedTimeline, DISCOVER_TIMELINE} = await import('@app/features/feed/state/FeedTimeline');

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

// Follow ids count down like snowflakes on a newest-first followers list; user ids count up like a following list.
function followPage(start: number, size = 100): Array<FollowResponse> {
	return Array.from({length: size}, (_, index) => ({
		id: String(900_000 - start - index),
		user: wireUser(String(start + index + 1)),
	}));
}

function reply<T>(body: T, status = 200): RestResponse<T> {
	return {ok: status < 300, status, statusText: '', headers: {}, body};
}

function refusal(method: 'GET' | 'PUT' | 'DELETE', status: number): HttpError {
	return new HttpError({method, path: '/users/42/follow', status});
}

function seedProfile(userId: string, fields: Partial<ProfileWire>, guildId?: string): void {
	const wire: ProfileWire = {
		user: wireUser(userId),
		user_profile: {bio: null, pronouns: null, banner: null, accent_color: null},
		timezone_offset: null,
		...fields,
	};
	UserProfile.handleProfileCreate(new Profile(wire, guildId));
}

function followState(userId: string, guildId?: string) {
	const profile = UserProfile.getProfile(userId, guildId);
	return {following: profile?.isFollowing, followers: profile?.followerCount, followingCount: profile?.followingCount};
}

beforeEach(() => {
	vi.mocked(AccountLimitUtils.blockIfAccountLimited).mockReset().mockReturnValue(false);
	vi.mocked(AccountLimitUtils.handleAccountLimitedError).mockReset().mockReturnValue(false);
	vi.mocked(http.get).mockReset();
	vi.mocked(http.put).mockReset();
	vi.mocked(http.delete).mockReset();
	UserProfile.handleGatewayReady();
	for (const listId of Object.keys(FollowLists.lists)) FollowLists.close(listId);
});

describe('follow list paging', () => {
	it('asks for the next followers page with the oldest loaded follow id as the before cursor', async () => {
		vi.mocked(http.get)
			.mockResolvedValueOnce(reply(followPage(0)))
			.mockResolvedValueOnce(reply(followPage(100)));
		const listId = FollowLists.open('followers', '42');
		await FollowCommands.loadNextPage(listId);
		await FollowCommands.loadNextPage(listId);
		expect(vi.mocked(http.get).mock.calls).toEqual([
			[Endpoints.USER_FOLLOWERS('42'), {query: {limit: 100}}],
			[Endpoints.USER_FOLLOWERS('42'), {query: {limit: 100, before: followPage(0)[99]!.id}}],
		]);
		expect(FollowLists.getEntries(listId).map((entry) => entry.user.id)).toEqual(
			Array.from({length: 200}, (_, index) => String(index + 1)),
		);
	});

	it('asks for the next following page with the last loaded user id as the after cursor', async () => {
		vi.mocked(http.get)
			.mockResolvedValueOnce(reply(followPage(0)))
			.mockResolvedValueOnce(reply(followPage(100)));
		const listId = FollowLists.open('following', '42');
		await FollowCommands.loadNextPage(listId);
		await FollowCommands.loadNextPage(listId);
		expect(vi.mocked(http.get).mock.calls[1]).toEqual([
			Endpoints.USER_FOLLOWING('42'),
			{query: {limit: 100, after: '100'}},
		]);
	});

	it('keeps at most five pages in memory and drops the oldest ones', async () => {
		for (let page = 0; page < 7; page++) {
			vi.mocked(http.get).mockResolvedValueOnce(reply(followPage(page * 100)));
		}
		const listId = FollowLists.open('followers', '42');
		for (let page = 0; page < 7; page++) {
			await FollowCommands.loadNextPage(listId);
		}
		const list = FollowLists.getList(listId)!;
		expect(list.pages).toHaveLength(5);
		expect(list.droppedCount).toBe(200);
		const entries = FollowLists.getEntries(listId);
		expect(entries).toHaveLength(500);
		expect(entries[0]!.user.id).toBe('201');
		expect(entries[499]!.user.id).toBe('700');
		expect(vi.mocked(http.get).mock.calls[6]![1]).toEqual({query: {limit: 100, before: followPage(500)[99]!.id}});
	});

	it('stops asking once a page comes back empty', async () => {
		vi.mocked(http.get)
			.mockResolvedValueOnce(reply(followPage(0, 3)))
			.mockResolvedValueOnce(reply([]));
		const listId = FollowLists.open('followers', '42');
		await FollowCommands.loadNextPage(listId);
		await FollowCommands.loadNextPage(listId);
		await FollowCommands.loadNextPage(listId);
		expect(http.get).toHaveBeenCalledTimes(2);
		expect(FollowLists.getList(listId)!.hasMore).toBe(false);
		expect(FollowLists.getEntries(listId)).toHaveLength(3);
	});

	it('marks a list the viewer may not see as forbidden without throwing and stops asking', async () => {
		vi.mocked(http.get).mockRejectedValueOnce(refusal('GET', 403));
		const listId = FollowLists.open('followers', '42');
		await expect(FollowCommands.loadNextPage(listId)).resolves.toBeUndefined();
		await FollowCommands.loadNextPage(listId);
		expect(http.get).toHaveBeenCalledTimes(1);
		expect(FollowLists.getList(listId)).toMatchObject({failure: 'forbidden', isLoading: false, hasMore: false});
	});

	it('keeps a list that failed to load retryable from the same cursor', async () => {
		vi.mocked(http.get)
			.mockResolvedValueOnce(reply(followPage(0)))
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce(reply(followPage(100)));
		const listId = FollowLists.open('followers', '42');
		await FollowCommands.loadNextPage(listId);
		await FollowCommands.loadNextPage(listId);
		expect(FollowLists.getList(listId)!.failure).toBe('error');
		await FollowCommands.loadNextPage(listId);
		expect(http.get).toHaveBeenCalledTimes(2);
		await FollowCommands.retry(listId);
		expect(vi.mocked(http.get).mock.calls[2]![1]).toEqual({query: {limit: 100, before: followPage(0)[99]!.id}});
		expect(FollowLists.getEntries(listId)).toHaveLength(200);
	});

	it('goes back to the first page when restarted', async () => {
		for (let page = 0; page < 6; page++) {
			vi.mocked(http.get).mockResolvedValueOnce(reply(followPage(page * 100)));
		}
		vi.mocked(http.get).mockResolvedValueOnce(reply(followPage(0)));
		const listId = FollowLists.open('followers', '42');
		for (let page = 0; page < 6; page++) {
			await FollowCommands.loadNextPage(listId);
		}
		expect(FollowLists.getList(listId)!.droppedCount).toBe(100);
		await FollowCommands.restart(listId);
		expect(vi.mocked(http.get).mock.calls[6]![1]).toEqual({query: {limit: 100}});
		expect(FollowLists.getList(listId)).toMatchObject({droppedCount: 0});
		expect(FollowLists.getEntries(listId)[0]!.user.id).toBe('1');
	});

	it('drops a page that lands after its list closed', async () => {
		let answer: (value: RestResponse<Array<FollowResponse>>) => void = () => {};
		vi.mocked(http.get).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		const listId = FollowLists.open('followers', '42');
		const loading = FollowCommands.loadNextPage(listId);
		FollowLists.close(listId);
		answer(reply(followPage(0)));
		await loading;
		expect(FollowLists.getList(listId)).toBeNull();
	});
});

describe('follow and unfollow', () => {
	beforeEach(() => {
		seedProfile('42', {is_following: false, follower_count: 10, following_count: 1});
		seedProfile('42', {is_following: false, follower_count: 10, following_count: 1}, 'g1');
		seedProfile('me', {follower_count: 5, following_count: 3});
	});

	it('shows the follow at once and keeps it when the server agrees', async () => {
		let answer: (value: RestResponse<null>) => void = () => {};
		vi.mocked(http.put).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
		const following = FollowCommands.follow('42');
		expect(followState('42')).toEqual({following: true, followers: 11, followingCount: 1});
		expect(followState('42', 'g1')).toEqual({following: true, followers: 11, followingCount: 1});
		expect(followState('me').followingCount).toBe(4);
		answer(reply(null, 204));
		await expect(following).resolves.toBe('ok');
		expect(http.put).toHaveBeenCalledWith(Endpoints.USER_FOLLOW('42'));
		expect(followState('42')).toEqual({following: true, followers: 11, followingCount: 1});
		expect(followState('me').followingCount).toBe(4);
	});

	it('rolls the follow back when the server refuses it', async () => {
		vi.mocked(http.put).mockRejectedValueOnce(refusal('PUT', 403));
		await expect(FollowCommands.follow('42')).resolves.toBe('forbidden');
		expect(followState('42')).toEqual({following: false, followers: 10, followingCount: 1});
		expect(followState('42', 'g1')).toEqual({following: false, followers: 10, followingCount: 1});
		expect(followState('me').followingCount).toBe(3);
	});

	it('reports the follow limit when the server answers 400', async () => {
		vi.mocked(http.put).mockRejectedValueOnce(refusal('PUT', 400));
		await expect(FollowCommands.follow('42')).resolves.toBe('limit');
		expect(followState('42').following).toBe(false);
	});

	it('asks for email verification and rolls back a refused Discover follow', async () => {
		vi.mocked(http.put).mockRejectedValueOnce(
			new HttpError({
				method: 'PUT',
				path: '/users/42/follow',
				status: 403,
				body: {code: APIErrorCodes.EMAIL_VERIFICATION_REQUIRED},
			}),
		);
		await expect(FollowCommands.follow('42', {postId: '900'})).resolves.toBe('verify_email');
		expect(followState('42')).toEqual({following: false, followers: 10, followingCount: 1});
		expect(followState('me').followingCount).toBe(3);
	});

	it('shows the account limitation and rolls the follow back without a refusal toast', async () => {
		const refusedWith = (code: string) =>
			new HttpError({method: 'PUT', path: '/users/42/follow', status: 403, body: {code, message: 'refused'}});
		const limited = refusedWith(APIErrorCodes.ACCOUNT_LIMITED);
		vi.mocked(AccountLimitUtils.handleAccountLimitedError).mockReturnValueOnce(true);
		vi.mocked(http.put).mockRejectedValueOnce(limited);
		await expect(FollowCommands.follow('42', {postId: '900'})).resolves.toBe('account_limited');
		expect(AccountLimitUtils.handleAccountLimitedError).toHaveBeenCalledWith(limited);
		expect(followState('42')).toEqual({following: false, followers: 10, followingCount: 1});
		expect(followState('me').followingCount).toBe(3);
		vi.mocked(http.put).mockRejectedValueOnce(refusedWith(APIErrorCodes.MISSING_ACCESS));
		await expect(FollowCommands.follow('42', {postId: '900'})).resolves.toBe('forbidden');
	});

	it.each(['follow', 'unfollow'] as const)(
		'blocks %s before optimistic state or a request for limited accounts',
		async (action) => {
			vi.mocked(AccountLimitUtils.blockIfAccountLimited).mockReturnValue(true);
			await expect(FollowCommands[action]('42')).resolves.toBe('account_limited');
			expect(http.put).not.toHaveBeenCalled();
			expect(http.delete).not.toHaveBeenCalled();
			expect(followState('42')).toEqual({following: false, followers: 10, followingCount: 1});
			expect(followState('me').followingCount).toBe(3);
		},
	);

	it('rolls an unfollow back when the request fails', async () => {
		seedProfile('42', {is_following: true, follower_count: 11, following_count: 1});
		vi.mocked(http.delete).mockRejectedValueOnce(new Error('offline'));
		const unfollowing = FollowCommands.unfollow('42');
		expect(followState('42')).toEqual({following: false, followers: 10, followingCount: 1});
		expect(followState('me').followingCount).toBe(2);
		await expect(unfollowing).resolves.toBe('failed');
		expect(http.delete).toHaveBeenCalledWith(Endpoints.USER_FOLLOW('42'));
		expect(followState('42')).toEqual({following: true, followers: 11, followingCount: 1});
		expect(followState('me').followingCount).toBe(3);
	});

	it('sends post_id in the body when following through a post, and no body otherwise', async () => {
		vi.mocked(http.put).mockResolvedValue(reply(null, 204));
		await expect(FollowCommands.follow('42', {postId: '900'})).resolves.toBe('ok');
		await FollowCommands.follow('43');
		expect(vi.mocked(http.put).mock.calls).toEqual([
			[Endpoints.USER_FOLLOW('42'), {body: {post_id: '900'}}],
			[Endpoints.USER_FOLLOW('43')],
		]);
	});

	it("flips the author's Discover cards at once and back when the follow fails", async () => {
		FeedTimeline.reset();
		FeedTimeline.open(DISCOVER_TIMELINE);
		// A stranger whose profile the viewer never opened: only the Discover card knows the follow state.
		FeedTimeline.handleFetchSuccess(
			DISCOVER_TIMELINE,
			[
				{
					id: '900',
					author: wireUser('77'),
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
		let refuse: (error: unknown) => void = () => {};
		vi.mocked(http.put).mockReturnValueOnce(new Promise((_, reject) => (refuse = reject)));
		const following = FollowCommands.follow('77', {postId: '900'});
		expect(FeedTimeline.getPost('900')!.authorFollowing).toBe(true);
		expect(followState('me').followingCount).toBe(4);
		refuse(refusal('PUT', 403));
		await expect(following).resolves.toBe('forbidden');
		expect(FeedTimeline.getPost('900')!.authorFollowing).toBe(false);
		expect(followState('me').followingCount).toBe(3);
		FeedTimeline.reset();
	});

	it('does not undo someone else’s change when a redundant request fails', async () => {
		seedProfile('42', {is_following: true, follower_count: 11});
		seedProfile('42', {is_following: true, follower_count: 11}, 'g1');
		vi.mocked(http.put).mockRejectedValueOnce(new Error('offline'));
		await FollowCommands.follow('42');
		expect(followState('42')).toMatchObject({following: true, followers: 11});
		expect(followState('me').followingCount).toBe(3);
	});
});

describe('removing a follower', () => {
	it('blocks removal before a request when the account is limited', async () => {
		vi.mocked(AccountLimitUtils.blockIfAccountLimited).mockReturnValue(true);
		await expect(FollowCommands.removeFollower('2')).resolves.toBe(false);
		expect(http.delete).not.toHaveBeenCalled();
	});

	it('uses the account limitation modal when removal is refused', async () => {
		const error = new HttpError({
			method: 'DELETE',
			path: '/users/me/followers/2',
			status: 403,
			body: {code: APIErrorCodes.ACCOUNT_LIMITED, message: 'paused'},
		});
		vi.mocked(http.delete).mockRejectedValueOnce(error);
		vi.mocked(AccountLimitUtils.handleAccountLimitedError).mockReturnValueOnce(true);
		await expect(FollowCommands.removeFollower('2')).resolves.toBe(false);
		expect(AccountLimitUtils.handleAccountLimitedError).toHaveBeenCalledWith(error);
	});

	it('drops them from my open followers list and my count once the server agrees', async () => {
		seedProfile('me', {follower_count: 5, following_count: 3});
		vi.mocked(http.get).mockResolvedValueOnce(reply(followPage(0, 3)));
		vi.mocked(http.delete).mockResolvedValueOnce(reply(null, 204));
		const listId = FollowLists.open('followers', 'me');
		await FollowCommands.loadNextPage(listId);
		await expect(FollowCommands.removeFollower('2')).resolves.toBe(true);
		expect(http.delete).toHaveBeenCalledWith(Endpoints.USER_FOLLOWER('2'));
		expect(FollowLists.getEntries(listId).map((entry) => entry.user.id)).toEqual(['1', '3']);
		expect(followState('me').followers).toBe(4);
	});

	it('keeps them when the server refuses', async () => {
		vi.mocked(http.get).mockResolvedValueOnce(reply(followPage(0, 3)));
		vi.mocked(http.delete).mockRejectedValueOnce(refusal('DELETE', 500));
		const listId = FollowLists.open('followers', 'me');
		await FollowCommands.loadNextPage(listId);
		await expect(FollowCommands.removeFollower('2')).resolves.toBe(false);
		expect(FollowLists.getEntries(listId)).toHaveLength(3);
	});
});

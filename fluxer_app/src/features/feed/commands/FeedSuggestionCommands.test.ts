// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {HttpError} from '@app/features/platform/types/EndpointError';
import type {RestResponse} from '@app/features/platform/types/TransportTypes';
import type {FeedSuggestionsResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const warn = vi.hoisted(() => vi.fn());

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'micup.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => 1000}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: 'me'}}));
vi.mock('@app/features/platform/state/AuthSession', () => ({
	default: {currentAccountKey: 'micup.test:me', userId: 'me'},
}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		static create = () => new this();
		debug = vi.fn();
		info = vi.fn();
		warn = warn;
		error = vi.fn();
	},
}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http: {get: vi.fn()}}));

const {http} = await import('@app/features/platform/transport/RestTransport');
const {default: Users} = await import('@app/features/user/state/Users');
const {fetchSuggestions, loadSuggestions} = await import('@app/features/feed/commands/FeedSuggestionCommands');
const {default: FeedSuggestionPicks} = await import('@app/features/feed/state/FeedSuggestionPicks');

const person = (id: string) => ({
	id,
	username: `user${id}`,
	discriminator: '0001',
	global_name: `Person ${id}`,
	avatar: null,
	avatar_color: null,
	flags: 0,
});

const community = (id: string) => ({
	id,
	name: `Community ${id}`,
	icon: 'icon-hash',
	banner: 'banner-hash',
	description: 'A place to talk',
	category_type: 1,
	primary_language: 'tr',
	custom_tags: ['games'],
	member_count: 1200,
	online_count: 40,
	features: ['DISCOVERABLE'],
	verification_level: 0,
});

function reply(body: FeedSuggestionsResponse): RestResponse<FeedSuggestionsResponse> {
	return {ok: true, status: 200, statusText: '', headers: {}, body};
}

describe('fetchSuggestions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('asks GET /feed/suggestions once and stores the people in the Users store', async () => {
		vi.mocked(http.get).mockResolvedValueOnce(reply({users: [person('7'), person('8')], guilds: []}));
		await fetchSuggestions();
		expect(http.get).toHaveBeenCalledTimes(1);
		expect(http.get).toHaveBeenCalledWith(Endpoints.FEED_SUGGESTIONS);
		expect(Endpoints.FEED_SUGGESTIONS).toBe('/feed/suggestions');
		// The profile modal of a stranger falls back to the stored user, so the name and avatar come from here.
		expect(Users.getUser('7')?.username).toBe('user7');
		expect(Users.getUser('8')?.globalName).toBe('Person 8');
	});

	// The suggestion snapshot can be minutes old; a person the store already holds (gateway-fresh) keeps its data.
	it('stores only the people the Users store does not hold yet', async () => {
		Users.cacheUsers([{...person('21'), username: 'fresh21', global_name: 'Fresh 21', flags: 1}]);
		vi.mocked(http.get).mockResolvedValueOnce(reply({users: [person('21'), person('22')], guilds: []}));
		await expect(fetchSuggestions()).resolves.toMatchObject({userIds: ['21', '22']});
		expect(Users.getUser('21')?.username).toBe('fresh21');
		expect(Users.getUser('21')?.globalName).toBe('Fresh 21');
		expect(Users.getUser('21')?.flags).toBe(1);
		expect(Users.getUser('22')?.username).toBe('user22');
	});

	it('returns the ids and the communities, with missing optional fields as null', async () => {
		const bare = {...community('6')} as Partial<ReturnType<typeof community>>;
		delete bare.icon;
		delete bare.banner;
		delete bare.description;
		delete bare.primary_language;
		vi.mocked(http.get).mockResolvedValueOnce(
			reply({users: [person('9')], guilds: [community('5'), bare as ReturnType<typeof community>]}),
		);
		await expect(fetchSuggestions()).resolves.toEqual({
			userIds: ['9'],
			guilds: [
				community('5'),
				{...community('6'), icon: null, banner: null, description: null, primary_language: null},
			],
		});
	});

	it.each([
		['403', new HttpError({method: 'GET', path: '/feed/suggestions', status: 403})],
		['429', new HttpError({method: 'GET', path: '/feed/suggestions', status: 429})],
		['a network error', new TypeError('Failed to fetch')],
	])('returns null and logs on 403, 429 or a network error (%s)', async (_, error) => {
		vi.mocked(http.get).mockRejectedValueOnce(error);
		await expect(fetchSuggestions()).resolves.toBeNull();
		expect(warn).toHaveBeenCalledWith('Failed to load feed suggestions:', error);
	});
});

describe('loadSuggestions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		FeedSuggestionPicks.reset();
	});

	it('sends one request per feed page opening and puts the picks in FeedSuggestionPicks', async () => {
		let answer: (value: RestResponse<FeedSuggestionsResponse>) => void = () => {};
		vi.mocked(http.get).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)) as never);
		const first = loadSuggestions();
		const second = loadSuggestions();
		expect(http.get).toHaveBeenCalledTimes(1);
		answer(reply({users: [person('7')], guilds: []}));
		await Promise.all([first, second]);
		expect(FeedSuggestionPicks.picks).toEqual({userIds: ['7'], guilds: []});
		await loadSuggestions();
		expect(http.get).toHaveBeenCalledTimes(1);
		// The next opening (FeedPage reset) asks again.
		FeedSuggestionPicks.reset();
		vi.mocked(http.get).mockResolvedValueOnce(reply({users: [person('8')], guilds: []}));
		await loadSuggestions();
		expect(http.get).toHaveBeenCalledTimes(2);
		expect(FeedSuggestionPicks.picks).toEqual({userIds: ['8'], guilds: []});
	});

	it('does not ask again after a failed request until the next opening', async () => {
		vi.mocked(http.get).mockRejectedValueOnce(new HttpError({method: 'GET', path: '/feed/suggestions', status: 429}));
		await loadSuggestions();
		await loadSuggestions();
		expect(http.get).toHaveBeenCalledTimes(1);
		expect(FeedSuggestionPicks.picks).toBeNull();
	});

	it('drops the answer of a request that outlived its feed page', async () => {
		let answer: (value: RestResponse<FeedSuggestionsResponse>) => void = () => {};
		vi.mocked(http.get).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)) as never);
		const loading = loadSuggestions();
		FeedSuggestionPicks.reset();
		answer(reply({users: [person('7')], guilds: []}));
		await loading;
		expect(FeedSuggestionPicks.picks).toBeNull();
	});
});

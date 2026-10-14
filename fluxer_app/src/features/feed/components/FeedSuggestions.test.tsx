// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import type {GatewayHandlerContext} from '@app/features/gateway/events/EventRouter';
import {HttpError} from '@app/features/platform/types/EndpointError';
import type {RestResponse} from '@app/features/platform/types/TransportTypes';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {FeedSuggestionsResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	limits: {feature_feed_suggestions: 1} as Record<string, number>,
	memberOf: new Set<string>(),
}));

// Fills {name} and a "{key, plural, one {…} other {…}}" message (# is the number), enough to read the text.
function format(message: string, values?: Record<string, unknown>): string {
	if (!values) return message;
	return message
		.replace(/^\{(\w+), plural, one \{(.*?)\} other \{(.*)\}\}$/, (_, key: string, one: string, other: string) =>
			(values[key] === 1 ? one : other).replace('#', String(values[key])),
		)
		.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]));
}

const i18n = vi.hoisted(() => ({
	_: (descriptor: {message: string}, values?: Record<string, unknown>) => format(descriptor.message, values),
	number: (value: number) => String(value),
}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n}),
	Trans: ({children}: {children: ReactNode}) => children,
	Plural: ({value, one, other}: {value: number; one: string; other: string}) =>
		(value === 1 ? one : other).replace('#', String(value)),
}));
vi.mock('@app/app/I18n', () => ({default: i18n}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {localInstanceDomain: 'micup.test', singleCommunityEnabled: false},
}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({
	LimitResolver: {resolve: ({key, fallback}: {key: string; fallback: number}) => state.limits[key] ?? fallback},
}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({
	default: {getGuild: (id: string) => (state.memberOf.has(id) ? {id} : undefined)},
}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: 'me'}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		static create() {
			return new this();
		}
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({
	http: {get: vi.fn(), put: vi.fn(), delete: vi.fn()},
}));
vi.mock('@app/features/app/components/alerts/GenericErrorModal', () => ({GenericErrorModal: () => null}));
vi.mock('@app/features/discovery/commands/DiscoveryCommands', () => ({joinGuild: vi.fn()}));
vi.mock('@app/features/discovery/components/modals/DiscoveryGuildPreviewModal', () => ({
	DiscoveryGuildPreviewModal: () => null,
}));
vi.mock('@app/features/follow/components/FollowListModal', () => ({FollowListModal: () => null}));
vi.mock('@app/features/guild/components/popouts/GuildIcon', () => ({
	GuildIcon: ({id, sizePx}: {id: string; sizePx: number}) =>
		createElement('span', {'data-guild-icon': id, 'data-size': sizePx}),
}));
vi.mock('@app/features/navigation/commands/NavigationCommands', () => ({selectGuild: vi.fn()}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({push: vi.fn(), modal: (render: unknown) => render}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({error: vi.fn()}));
vi.mock('@app/features/user/utils/AccountLimitUtils', () => ({
	blockIfAccountLimited: vi.fn(() => false),
	handleAccountLimitedError: vi.fn(() => false),
}));
vi.mock('@app/features/ui/components/Avatar', () => ({
	Avatar: ({user, size}: {user: {id: string}; size: number}) =>
		createElement('span', {'data-avatar-user': user.id, 'data-size': size}),
}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {enabled: false, isMobileLayout: () => false}}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/user/commands/UserProfileCommands', () => ({
	openProfilePage: vi.fn(),
	openUserProfile: vi.fn(),
}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({
	getNickname: (user: {globalName: string | null; username: string}) => user.globalName ?? user.username,
	formatTagForStreamerMode: (tag: string) => tag,
}));
vi.mock('@phosphor-icons/react', async (importOriginal) => {
	const icon = (name: string) => () => createElement('svg', {'data-icon': name});
	return {
		...(await importOriginal<typeof import('@phosphor-icons/react')>()),
		PlusIcon: icon('plus'),
		CheckIcon: icon('check'),
	};
});

// Idle and LocalPresence import each other; loading Idle first keeps its timer from calling a half-loaded store.
await import('@app/features/ui/state/Idle');
const {http} = await import('@app/features/platform/transport/RestTransport');
const {default: RuntimeConfig} = await import('@app/features/app/state/RuntimeConfig');
const {default: MobileLayout} = await import('@app/features/ui/state/MobileLayout');
const DiscoveryCommands = await import('@app/features/discovery/commands/DiscoveryCommands');
const NavigationCommands = await import('@app/features/navigation/commands/NavigationCommands');
const ModalCommands = await import('@app/features/ui/commands/ModalCommands');
const ToastCommands = await import('@app/features/ui/commands/ToastCommands');
const UserProfileCommands = await import('@app/features/user/commands/UserProfileCommands');
const {DiscoveryGuildPreviewModal} = await import(
	'@app/features/discovery/components/modals/DiscoveryGuildPreviewModal'
);
const AccountLimitUtils = await import('@app/features/user/utils/AccountLimitUtils');
const {TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR} = await import('@app/features/i18n/utils/CommonMessageDescriptors');
const {default: buttonStyles} = await import('@app/features/ui/button/Button.module.css');
const {default: followStyles} = await import('@app/features/follow/components/ProfileFollowActions.module.css');
const {default: FeedSuggestionPicks} = await import('@app/features/feed/state/FeedSuggestionPicks');
const FollowCommands = await import('@app/features/follow/commands/FollowCommands');
const {handleFollowCreate} = await import('@app/features/follow/events/FollowCreate');
const {handleFollowDelete} = await import('@app/features/follow/events/FollowDelete');
const {FeedSuggestions} = await import('@app/features/feed/components/FeedSuggestions');

const person = (id: string, name: string) => ({
	id,
	username: `user${id}`,
	discriminator: '0001',
	global_name: name,
	avatar: null,
	avatar_color: null,
	flags: 0,
});

const community = (id: string, name: string, memberCount = 1200) => ({
	id,
	name,
	icon: null,
	banner: null,
	description: null,
	category_type: 0,
	primary_language: 'tr',
	custom_tags: [],
	member_count: memberCount,
	online_count: 30,
	features: [],
	verification_level: 0,
});

const PICKS: FeedSuggestionsResponse = {
	users: [person('7', 'Seven'), person('8', 'Eight')],
	guilds: [community('5', 'Chess club'), community('6', 'Film night', 1)],
};

const ok = <T,>(body: T): RestResponse<T> => ({ok: true, status: 200, statusText: '', headers: {}, body});

describe('FeedSuggestions', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	const mount = () => act(async () => root.render(createElement(FeedSuggestions)));
	// The section mounts again on the same feed page (Your posts remounts the feed column).
	const remount = () => {
		act(() => root.unmount());
		root = createRoot(container);
		return mount();
	};
	// A new feed page: FeedPage resets the picks when it goes away.
	const nextPage = () => {
		FeedSuggestionPicks.reset();
		return remount();
	};
	const sections = () => [...container.querySelectorAll('section')];
	// The heading that names each section (aria-labelledby), in order.
	const headings = () =>
		sections().map((section) => document.getElementById(section.getAttribute('aria-labelledby')!)?.textContent);
	const rows = (heading: string) => {
		const section = sections().find(
			(element) => document.getElementById(element.getAttribute('aria-labelledby')!)?.textContent === heading,
		);
		return [...(section?.querySelectorAll('li') ?? [])];
	};
	const rowByText = (heading: string, text: string) => rows(heading).find((row) => row.textContent?.includes(text))!;
	// The row's action button (Follow / Join): the last button in the row.
	const actionOf = (row: Element) => [...row.querySelectorAll('button')].at(-1)!;
	// What a sighted user reads on a button: its text without the aria-hidden hover label.
	const visibleText = (button: Element) => {
		const copy = button.cloneNode(true) as Element;
		for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
		return copy.textContent;
	};

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		FeedSuggestionPicks.reset();
		state.limits = {feature_feed_suggestions: 1};
		state.memberOf = new Set();
		(MobileLayout as {enabled: boolean}).enabled = false;
		(RuntimeConfig as {singleCommunityEnabled: boolean}).singleCommunityEnabled = false;
		vi.mocked(http.get).mockResolvedValue(ok(PICKS));
		vi.mocked(http.put).mockResolvedValue(ok(undefined));
		vi.mocked(http.delete).mockResolvedValue(ok(undefined));
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it('sends no request and renders nothing while feature_feed_suggestions is 0', async () => {
		state.limits = {feature_feed_suggestions: 0};
		await mount();
		expect(http.get).not.toHaveBeenCalled();
		expect(container.innerHTML).toBe('');
		// Not set at all counts as off too.
		state.limits = {};
		await mount();
		expect(http.get).not.toHaveBeenCalled();
		expect(container.innerHTML).toBe('');
	});

	it('sends no request and renders nothing in the mobile layout', async () => {
		(MobileLayout as {enabled: boolean}).enabled = true;
		await mount();
		expect(http.get).not.toHaveBeenCalled();
		expect(container.innerHTML).toBe('');
	});

	it('shows the people and communities of one request under their headings', async () => {
		await mount();
		expect(http.get).toHaveBeenCalledTimes(1);
		expect(http.get).toHaveBeenCalledWith(Endpoints.FEED_SUGGESTIONS);
		expect(headings()).toEqual(['Popular people', 'Popular communities']);
		for (const section of sections()) {
			expect(document.getElementById(section.getAttribute('aria-labelledby')!)?.tagName).toBe('H2');
		}
		const people = rows('Popular people');
		expect(people.map((row) => row.querySelector('[data-avatar-user]')?.getAttribute('data-avatar-user'))).toEqual([
			'7',
			'8',
		]);
		expect(people[0].querySelector('[data-avatar-user]')?.getAttribute('data-size')).toBe('32');
		expect(people[0].textContent).toContain('Seven');
		expect(people[0].textContent).toContain('user7#0001');
		expect(visibleText(actionOf(people[0]))).toBe('Follow');
		const communities = rows('Popular communities');
		expect(communities.map((row) => row.querySelector('[data-guild-icon]')?.getAttribute('data-guild-icon'))).toEqual([
			'5',
			'6',
		]);
		expect(communities[0].querySelector('[data-guild-icon]')?.getAttribute('data-size')).toBe('32');
		expect(communities[0].textContent).toContain('Chess club');
		expect(communities[0].textContent).toContain('1200 members');
		expect(communities[1].textContent).toContain('1 member');
		expect(visibleText(actionOf(communities[0]))).toBe('Join');
		expect(actionOf(communities[0]).classList).toContain(buttonStyles.secondary);
	});

	it('keeps the same suggestions across re-renders, tab changes and a remount on the same feed page; the next feed page asks again', async () => {
		// The feed page re-renders the rail on a tab change; the section stays mounted and keeps its picks.
		const Page = ({tab}: {tab: string}) => createElement('div', {'data-tab': tab}, createElement(FeedSuggestions));
		await act(async () => root.render(createElement(Page, {tab: 'discover'})));
		await act(async () => root.render(createElement(Page, {tab: 'home'})));
		await act(async () => root.render(createElement(Page, {tab: 'discover'})));
		expect(http.get).toHaveBeenCalledTimes(1);
		expect(rows('Popular people')).toHaveLength(2);
		vi.mocked(http.get).mockResolvedValueOnce(ok({users: [person('9', 'Nine')], guilds: []}));
		await remount();
		expect(http.get).toHaveBeenCalledTimes(1);
		expect(rows('Popular people')).toHaveLength(2);
		await nextPage();
		expect(http.get).toHaveBeenCalledTimes(2);
		expect(rows('Popular people').map((row) => row.textContent?.includes('Nine'))).toEqual([true]);
	});

	it('a person followed from the list still shows Following when the section mounts again on the same page', async () => {
		await mount();
		await act(async () => actionOf(rowByText('Popular people', 'Seven')).click());
		await remount();
		expect(http.get).toHaveBeenCalledTimes(1);
		expect(visibleText(actionOf(rowByText('Popular people', 'Seven')))).toBe('Following');
		expect(visibleText(actionOf(rowByText('Popular people', 'Eight')))).toBe('Follow');
	});

	it('hides a section with no entries, and everything when the request fails', async () => {
		vi.mocked(http.get).mockResolvedValueOnce(ok({users: [], guilds: PICKS.guilds}));
		await mount();
		expect(headings()).toEqual(['Popular communities']);
		vi.mocked(http.get).mockResolvedValueOnce(ok({users: PICKS.users, guilds: []}));
		await nextPage();
		expect(headings()).toEqual(['Popular people']);
		vi.mocked(http.get).mockResolvedValueOnce(ok({users: [], guilds: []}));
		await nextPage();
		expect(container.innerHTML).toBe('');
		vi.mocked(http.get).mockRejectedValueOnce(new HttpError({method: 'GET', path: '/feed/suggestions', status: 403}));
		await nextPage();
		expect(container.innerHTML).toBe('');
		// A failed request is not sent again on the same page.
		await remount();
		expect(http.get).toHaveBeenCalledTimes(4);
		expect(container.innerHTML).toBe('');
	});

	it('Follow follows without a post id, turns into Following, and a second click unfollows', async () => {
		await mount();
		const follow = actionOf(rowByText('Popular people', 'Seven'));
		expect(follow.classList).toContain(buttonStyles.small);
		// The same quiet look as Your posts in the card above.
		expect(follow.classList).toContain(buttonStyles.secondary);
		expect(follow.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('plus');
		await act(async () => follow.click());
		// The pool path: no post_id body, so the server checks its suggestion pool.
		expect(http.put).toHaveBeenCalledTimes(1);
		expect(vi.mocked(http.put).mock.calls[0]).toEqual([Endpoints.USER_FOLLOW('7')]);
		const following = actionOf(rowByText('Popular people', 'Seven'));
		expect(visibleText(following)).toBe('Following');
		expect(following.classList).toContain(buttonStyles.secondary);
		expect(following.classList).toContain(followStyles.followingButton);
		expect(following.querySelector(`.${followStyles.followHoverLabel}`)?.textContent).toBe('Unfollow');
		expect(following.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('check');
		await act(async () => following.click());
		expect(vi.mocked(http.delete).mock.calls[0]).toEqual([Endpoints.USER_FOLLOW('7')]);
		expect(visibleText(actionOf(rowByText('Popular people', 'Seven')))).toBe('Follow');
		expect(ToastCommands.error).not.toHaveBeenCalled();
		// The other person was not touched.
		expect(visibleText(actionOf(rowByText('Popular people', 'Eight')))).toBe('Follow');
	});

	it('drops a person whose follow is refused', async () => {
		vi.mocked(http.put).mockRejectedValueOnce(new HttpError({method: 'PUT', path: '/users/7/follow', status: 403}));
		await mount();
		await act(async () => actionOf(rowByText('Popular people', 'Seven')).click());
		// Out of the server's pool (or no longer allowed): the card goes, the toast says why, the others stay.
		expect(rows('Popular people').map((row) => row.textContent?.includes('Eight'))).toEqual([true]);
		expect(vi.mocked(ToastCommands.error).mock.calls).toEqual([["You can't follow this account."]]);
		// The last person refused: the whole people section goes.
		vi.mocked(http.put).mockRejectedValueOnce(new HttpError({method: 'PUT', path: '/users/8/follow', status: 403}));
		await act(async () => actionOf(rowByText('Popular people', 'Eight')).click());
		expect(headings()).toEqual(['Popular communities']);
	});

	it('shows Following after a follow made in the profile modal', async () => {
		await mount();
		// The profile modal's Follow button (ProfileFollowButton) follows through the same command.
		await act(async () => {
			await FollowCommands.follow('7');
		});
		expect(visibleText(actionOf(rowByText('Popular people', 'Seven')))).toBe('Following');
		expect(visibleText(actionOf(rowByText('Popular people', 'Eight')))).toBe('Follow');
	});

	it('shows Follow again after an unfollow elsewhere', async () => {
		await mount();
		await act(async () => actionOf(rowByText('Popular people', 'Seven')).click());
		expect(visibleText(actionOf(rowByText('Popular people', 'Seven')))).toBe('Following');
		// Another device unfollowed: this session gets FOLLOW_DELETE.
		act(() => handleFollowDelete({user_id: '7'}, {} as GatewayHandlerContext));
		expect(visibleText(actionOf(rowByText('Popular people', 'Seven')))).toBe('Follow');
		// And a follow from another device shows here too.
		act(() => handleFollowCreate({id: '900', user: person('8', 'Eight')}, {} as GatewayHandlerContext));
		expect(visibleText(actionOf(rowByText('Popular people', 'Eight')))).toBe('Following');
	});

	it.each([
		['400', new HttpError({method: 'PUT', path: '/users/7/follow', status: 400}), 'You can follow up to 0 accounts.'],
		[
			'other',
			new HttpError({method: 'PUT', path: '/users/7/follow', status: 500}),
			TRY_AGAIN_IN_A_MOMENT_DESCRIPTOR.message,
		],
	])('a refused follow keeps Follow and shows the follow failure toast (%s)', async (_, error, toast) => {
		vi.mocked(http.put).mockRejectedValueOnce(error);
		await mount();
		await act(async () => actionOf(rowByText('Popular people', 'Seven')).click());
		expect(visibleText(actionOf(rowByText('Popular people', 'Seven')))).toBe('Follow');
		expect(vi.mocked(ToastCommands.error).mock.calls).toEqual([[toast]]);
	});

	it('handles an account limitation without a second failure toast on a Discover follow', async () => {
		const error = new HttpError({
			method: 'PUT',
			path: '/users/7/follow',
			status: 403,
			body: {code: APIErrorCodes.ACCOUNT_LIMITED, message: 'paused'},
		});
		vi.mocked(AccountLimitUtils.handleAccountLimitedError).mockReturnValueOnce(true);
		vi.mocked(http.put).mockRejectedValueOnce(error);
		await mount();
		await act(async () => actionOf(rowByText('Popular people', 'Seven')).click());
		expect(visibleText(actionOf(rowByText('Popular people', 'Seven')))).toBe('Follow');
		expect(AccountLimitUtils.handleAccountLimitedError).toHaveBeenCalledWith(error);
		expect(ToastCommands.error).not.toHaveBeenCalled();
	});

	it("names the person in the follow button's accessible name, which contains its visible text", async () => {
		await mount();
		const follow = actionOf(rowByText('Popular people', 'Seven'));
		expect(follow.getAttribute('aria-label')).toBe('Follow Seven');
		expect(follow.getAttribute('aria-label')).toContain(visibleText(follow)!);
		await act(async () => follow.click());
		const following = actionOf(rowByText('Popular people', 'Seven'));
		expect(following.getAttribute('aria-label')).toBe('Following Seven');
		expect(following.getAttribute('aria-label')).toContain(visibleText(following)!);
	});

	it('a click on a person opens their profile; a click on a community opens its preview', async () => {
		await mount();
		act(() => rowByText('Popular people', 'Seven').querySelector('button')!.click());
		expect(UserProfileCommands.openProfilePage).toHaveBeenCalledWith('7');
		expect(UserProfileCommands.openUserProfile).not.toHaveBeenCalled();
		act(() => rowByText('Popular communities', 'Chess club').querySelector('button')!.click());
		expect(ModalCommands.push).toHaveBeenCalledTimes(1);
		const render = vi.mocked(ModalCommands.push).mock.calls[0][0] as unknown as () => {
			type: unknown;
			props: {guild: {id: string}};
		};
		expect(render().type).toBe(DiscoveryGuildPreviewModal);
		expect(render().props.guild).toMatchObject({id: '5', name: 'Chess club'});
		expect(http.put).not.toHaveBeenCalled();
		expect(DiscoveryCommands.joinGuild).not.toHaveBeenCalled();
	});

	it('Join joins without leaving the feed and shows Joined; a failed join keeps Join', async () => {
		vi.mocked(DiscoveryCommands.joinGuild)
			.mockResolvedValueOnce(undefined as never)
			.mockRejectedValueOnce(new HttpError({method: 'POST', path: '/discovery/guilds/6/join', status: 500}));
		await mount();
		await act(async () => actionOf(rowByText('Popular communities', 'Chess club')).click());
		expect(DiscoveryCommands.joinGuild).toHaveBeenCalledWith('5');
		expect(NavigationCommands.selectGuild).not.toHaveBeenCalled();
		const joined = rowByText('Popular communities', 'Chess club');
		expect(joined.querySelectorAll('button')).toHaveLength(1);
		expect(joined.textContent).toContain('Joined');
		expect(joined.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('check');
		await act(async () => actionOf(rowByText('Popular communities', 'Film night')).click());
		expect(DiscoveryCommands.joinGuild).toHaveBeenCalledWith('6');
		expect(visibleText(actionOf(rowByText('Popular communities', 'Film night')))).toBe('Join');
		// The join error modal of the Discovery page.
		expect(ModalCommands.push).toHaveBeenCalledTimes(1);
		expect(NavigationCommands.selectGuild).not.toHaveBeenCalled();
	});

	it('a community the viewer is already in shows Joined', async () => {
		state.memberOf = new Set(['6']);
		await mount();
		const inside = rowByText('Popular communities', 'Film night');
		expect(inside.querySelectorAll('button')).toHaveLength(1);
		expect(inside.textContent).toContain('Joined');
		expect(visibleText(actionOf(rowByText('Popular communities', 'Chess club')))).toBe('Join');
	});

	it('no community section while the instance runs a single community', async () => {
		(RuntimeConfig as {singleCommunityEnabled: boolean}).singleCommunityEnabled = true;
		await mount();
		expect(headings()).toEqual(['Popular people']);
	});
});

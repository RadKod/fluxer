// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {HttpError} from '@app/features/platform/types/EndpointError';
import {act, createElement, forwardRef, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'micup.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => 1000}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({
	http: {get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn()},
}));
vi.mock('@app/features/platform/utils/SharedIntersectionObserver', () => ({
	observeIntersection: vi.fn(() => () => {}),
}));
vi.mock('@app/features/app/components/dialogs/Modal', () => ({
	Root: ({children}: {children: ReactNode}) => createElement('div', {role: 'dialog'}, children),
	Header: ({title}: {title: string}) => createElement('h2', null, title),
	Content: forwardRef<HTMLDivElement, {children: ReactNode}>(({children}, ref) =>
		createElement('div', {ref}, children),
	),
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick}: {children: ReactNode; onClick: () => void}) =>
		createElement('button', {type: 'button', onClick}, children),
}));
vi.mock('@app/features/ui/components/Avatar', () => ({Avatar: () => null}));
vi.mock('@app/features/ui/components/Spinner', () => ({Spinner: () => createElement('span', {role: 'status'})}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/user/commands/UserProfileCommands', () => ({
	openProfilePage: vi.fn(),
	openUserProfile: vi.fn(),
}));
vi.mock('@app/features/user/components/VerifiedUserBadge', () => ({VerifiedUserBadge: () => null}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({
	getNickname: (user: {username: string}) => user.username,
	formatTagForStreamerMode: (tag: string) => tag,
}));

const {http} = await import('@app/features/platform/transport/RestTransport');
const {observeIntersection} = await import('@app/features/platform/utils/SharedIntersectionObserver');
const UserProfileCommands = await import('@app/features/user/commands/UserProfileCommands');
const {FeedLikers} = await import('@app/features/feed/components/FeedLikers');

const wireUser = (id: number) => ({
	id: String(id),
	username: `user${id}`,
	discriminator: '0001',
	global_name: null,
	avatar: null,
	avatar_color: null,
	flags: 0,
});
const page = (from: number, count: number) => ({
	body: Array.from({length: count}, (_, index) => wireUser(from + index)),
});

describe('FeedLikers', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const rows = () => Array.from(container.querySelectorAll('li button'));
	const settle = () =>
		act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	// The end-of-list watcher last registered, as SharedIntersectionObserver would call it.
	const scrollToEnd = async () => {
		const call = vi.mocked(observeIntersection).mock.calls.at(-1)!;
		await act(async () => {
			call[1]({isIntersecting: true} as IntersectionObserverEntry);
		});
		await settle();
	};

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it('pages likers with after until an empty page and hides the list on 403', async () => {
		vi.mocked(http.get)
			.mockResolvedValueOnce(page(1, 50) as never)
			.mockResolvedValueOnce(page(51, 3) as never)
			.mockResolvedValueOnce({body: []} as never);
		act(() => root.render(createElement(FeedLikers, {postId: '100'})));
		await settle();
		expect(container.querySelector('h2')?.textContent).toBe('Liked by');
		expect(http.get).toHaveBeenCalledWith('/feed/posts/100/likes', {query: {limit: 50}});
		expect(rows()).toHaveLength(50);

		await scrollToEnd();
		expect(http.get).toHaveBeenLastCalledWith('/feed/posts/100/likes', {query: {limit: 50, after: '50'}});
		expect(rows()).toHaveLength(53);
		// The server leaves deleted accounts out of a page, so a short page is not the end; an empty one is.
		await scrollToEnd();
		expect(http.get).toHaveBeenLastCalledWith('/feed/posts/100/likes', {query: {limit: 50, after: '53'}});
		expect(rows()).toHaveLength(53);
		const watchers = vi.mocked(observeIntersection).mock.calls.length;
		await settle();
		expect(vi.mocked(observeIntersection).mock.calls.length).toBe(watchers);
		expect(http.get).toHaveBeenCalledTimes(3);

		act(() => rows()[0]!.dispatchEvent(new MouseEvent('click', {bubbles: true})));
		expect(UserProfileCommands.openProfilePage).toHaveBeenCalledWith('1');
		expect(UserProfileCommands.openUserProfile).not.toHaveBeenCalled();

		act(() => root.unmount());
		root = createRoot(container);
		vi.mocked(http.get).mockRejectedValueOnce(
			new HttpError({method: 'GET', path: '/feed/posts/200/likes', status: 403}),
		);
		act(() => root.render(createElement(FeedLikers, {postId: '200'})));
		await settle();
		expect(rows()).toHaveLength(0);
		expect(container.textContent).toContain("You can't see who liked this post.");
		expect(container.querySelector('[role="status"]')).toBeNull();
	});

	it('offers a retry when a page fails', async () => {
		vi.mocked(http.get)
			.mockRejectedValueOnce(new HttpError({method: 'GET', path: '/feed/posts/100/likes', status: 500}))
			.mockResolvedValueOnce(page(1, 2) as never);
		act(() => root.render(createElement(FeedLikers, {postId: '100'})));
		await settle();
		expect(container.textContent).toContain("Couldn't load who liked this post.");
		const retry = Array.from(container.querySelectorAll('button')).find(
			(element) => element.textContent === 'Try again',
		);
		act(() => retry!.click());
		await settle();
		expect(http.get).toHaveBeenCalledTimes(2);
		expect(rows()).toHaveLength(2);
	});
});

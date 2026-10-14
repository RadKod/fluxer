// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ScrollerHandle} from '@app/features/ui/components/Scroller';
import type {FollowResponse} from '@fluxer/schema/src/domains/follow/FollowResponseSchemas';
import {act, createElement, forwardRef, type ReactNode, useImperativeHandle} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const passThrough = ({children}: {children?: ReactNode}) => children;
const viewport = vi.hoisted(() => ({current: null as HTMLElement | null}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {getSnapshotOrNull: () => null, localInstanceDomain: 'micup.test'},
}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => 1000}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		static create = () => new this();
		debug() {}
		warn() {}
		error() {}
	},
}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: '1'}}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({
	http: {get: vi.fn(), put: vi.fn(), delete: vi.fn()},
}));
vi.mock('@app/features/app/components/dialogs/Modal', () => ({
	Root: passThrough,
	Header: passThrough,
	// The list's scroller: a 600px element the virtualizer can read (happy-dom has no layout).
	Content: forwardRef<ScrollerHandle, {children: ReactNode}>(({children}, ref) => {
		useImperativeHandle(ref, () => ({getViewportElement: () => viewport.current}) as unknown as ScrollerHandle);
		return createElement('div', null, children);
	}),
}));
vi.mock('@app/features/ui/tabs/Tabs', () => ({Tabs: () => null}));
vi.mock('@app/features/ui/components/Avatar', () => ({Avatar: () => null}));
vi.mock('@app/features/ui/components/Spinner', () => ({Spinner: () => null}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: passThrough}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: passThrough}));
vi.mock('@app/features/ui/utils/AppZoomUtils', () => ({
	getAppRemScale: () => 1,
	applyAppZoomToDocument: vi.fn(),
}));
vi.mock('@app/features/ui/commands/ToastCommands', () => ({error: vi.fn()}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({push: vi.fn(), modal: (render: unknown) => render}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick, ...rest}: {children?: ReactNode; onClick?: () => void; 'data-flx'?: string}) =>
		createElement('button', {type: 'button', onClick, 'data-flx': rest['data-flx']}, children),
}));
vi.mock('@app/features/user/commands/UserProfileCommands', () => ({
	openProfilePage: vi.fn(),
	openUserProfile: vi.fn(),
}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {getUser: () => null, currentUser: {maxFollowing: 1000}},
}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({
	getNickname: (user: {username: string}) => user.username,
	formatTagForStreamerMode: (tag: string) => tag,
}));

// Idle and LocalPresence import each other; loading Idle first keeps its timer from calling a half-loaded store.
await import('@app/features/ui/state/Idle');
const {http} = await import('@app/features/platform/transport/RestTransport');
const UserProfileCommands = await import('@app/features/user/commands/UserProfileCommands');
const ToastCommands = await import('@app/features/ui/commands/ToastCommands');
const {HttpError} = await import('@app/features/platform/types/EndpointError');
const {applyFollowChange} = await import('@app/features/follow/utils/FollowProfileUtils');
const {FollowListModal} = await import('@app/features/follow/components/FollowListModal');

function row(id: string, isFollowing?: boolean): FollowResponse {
	return {
		id: `9${id}`,
		user: {
			id,
			username: `user${id}`,
			discriminator: '0001',
			global_name: null,
			avatar: null,
			avatar_color: null,
			flags: 0,
		},
		...(isFollowing === undefined ? {} : {is_following: isFollowing}),
	} as FollowResponse;
}

describe('FollowListModal rows', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		const element = document.createElement('div');
		Object.defineProperty(element, 'offsetHeight', {value: 600});
		Object.defineProperty(element, 'offsetWidth', {value: 400});
		viewport.current = element;
		vi.mocked(http.get).mockImplementation(async (_url, options) => {
			const query = options?.query as Record<string, unknown> | undefined;
			const body = query?.before ? [] : [row('7', false), row('8', true), row('1', false), row('9')];
			return {ok: true, status: 200, statusText: '', headers: {}, body} as never;
		});
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const open = async () => {
		await act(async () => root.render(createElement(FollowListModal, {userId: '42', initialKind: 'followers'})));
		await act(async () => {});
	};
	const rowOf = (id: string) =>
		[...container.querySelectorAll<HTMLElement>('[data-flx="follow.follow-list-modal.follow-list-view.row"]')].find(
			(element) => element.textContent?.includes(`user${id}`),
		)!;
	const followButtonOf = (id: string) =>
		rowOf(id).querySelector<HTMLButtonElement>('[data-flx="follow.follow-list-modal.render-row.follow-button"]');

	it('a row opens that profile page, not the modal', async () => {
		await open();
		act(() =>
			rowOf('7')
				.querySelector<HTMLButtonElement>(
					'[data-flx="follow.follow-list-modal.render-row.user-button.open-user-profile"]',
				)!
				.click(),
		);
		expect(UserProfileCommands.openProfilePage).toHaveBeenCalledWith('7');
		expect(UserProfileCommands.openUserProfile).not.toHaveBeenCalled();
	});

	it('shows Follow or Following from the page itself, none on your own row or without is_following', async () => {
		await open();
		expect(followButtonOf('7')!.textContent).toBe('Follow');
		expect(followButtonOf('8')!.textContent).toBe('FollowingUnfollow');
		expect(followButtonOf('1')).toBeNull();
		expect(followButtonOf('9')).toBeNull();
		// Only the list's own pages went out (the short first page asks for the next, empty one): no look-up per row.
		expect(vi.mocked(http.get).mock.calls.map(([url]) => url)).toEqual(['/users/42/followers', '/users/42/followers']);
	});

	it('follows and unfollows in place, and rolls back with the follow toast when the server refuses', async () => {
		await open();
		vi.mocked(http.put).mockResolvedValueOnce({ok: true, status: 204} as never);
		await act(async () => followButtonOf('7')!.click());
		expect(http.put).toHaveBeenCalledWith('/users/7/follow');
		expect(followButtonOf('7')!.textContent).toBe('FollowingUnfollow');
		vi.mocked(http.delete).mockResolvedValueOnce({ok: true, status: 204} as never);
		await act(async () => followButtonOf('8')!.click());
		expect(http.delete).toHaveBeenCalledWith('/users/8/follow');
		expect(followButtonOf('8')!.textContent).toBe('Follow');
		vi.mocked(http.put).mockRejectedValueOnce(new HttpError({method: 'PUT', path: '/users/8/follow', status: 403}));
		await act(async () => followButtonOf('8')!.click());
		expect(followButtonOf('8')!.textContent).toBe('Follow');
		expect(ToastCommands.error).toHaveBeenCalledWith("You can't follow this account.");
	});

	it('a FOLLOW_CREATE from elsewhere turns the open row to Following', async () => {
		await open();
		act(() => {
			applyFollowChange('7', true);
		});
		expect(followButtonOf('7')!.textContent).toBe('FollowingUnfollow');
	});
});

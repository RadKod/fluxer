// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {FeedPostResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {act, createElement, type ReactNode} from 'react';
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
vi.mock('@app/features/feed/commands/FeedCommands', () => ({loadNextPage: vi.fn(), retry: vi.fn()}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => ({transitionTo: vi.fn()}));
vi.mock('@app/features/ui/components/Spinner', () => ({Spinner: () => null}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({children, onClick}: {children: ReactNode; onClick: () => void}) =>
		createElement('button', {type: 'button', onClick}, children),
}));

const FeedCommands = await import('@app/features/feed/commands/FeedCommands');
const RouterUtils = await import('@app/features/navigation/utils/RouterUtils');
const {default: FeedTimeline, userTimelineKey} = await import('@app/features/feed/state/FeedTimeline');
const {ProfileMediaGrid} = await import('@app/features/user/components/pages/ProfileMediaGrid');

const KEY = userTimelineKey('42');
let nextId = 1000;

function wirePost(fields: Partial<FeedPostResponse> = {}): FeedPostResponse {
	nextId -= 1;
	return {
		id: String(nextId),
		author: {
			id: '42',
			username: 'user42',
			discriminator: '0001',
			global_name: null,
			avatar: null,
			avatar_color: null,
			flags: 0,
		},
		content: 'text',
		attachments: [],
		edited_at: null,
		like_count: 0,
		comment_count: 0,
		liked: false,
		...fields,
	};
}
const withImage = () =>
	wirePost({
		attachments: [
			{
				id: '1',
				filename: 'a.png',
				size: 1,
				url: 'https://media.micup.test/a.png',
				proxy_url: 'https://media.micup.test/a.png',
				content_type: 'image/png',
				width: 800,
				height: 600,
				flags: 0,
			},
		] as never,
	});
const withVideo = () =>
	wirePost({
		video: {id: 'v', status: 'ready', poster_url: 'https://media.micup.test/poster.jpg'} as never,
	});
const textPage = (count: number) => Array.from({length: count}, () => wirePost());

describe('ProfileMediaGrid', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.clearAllMocks();
		FeedTimeline.reset();
		FeedTimeline.open(KEY);
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = () => act(() => root.render(createElement(ProfileMediaGrid, {timelineKey: KEY})));
	const tiles = () => [...container.querySelectorAll<HTMLButtonElement>('[data-flx="user.profile-media-grid.tile"]')];
	const olderButton = () =>
		[...container.querySelectorAll('button')].find((button) => button.textContent === 'Show older posts') ?? null;

	it('shows only posts with pictures or a video; a tile opens the post', () => {
		const image = withImage();
		const video = withVideo();
		FeedTimeline.handleFetchSuccess(KEY, [wirePost(), image, video], true);
		FeedTimeline.handleFetchSuccess(KEY, [], false);
		render();
		expect(tiles()).toHaveLength(2);
		const sources = tiles().map((tile) => tile.querySelector('img')!.getAttribute('src')!);
		expect(sources[0]).toMatch(/^https:\/\/media\.micup\.test\/a\.png\?format=webp&width=\d+$/);
		expect(sources[1]).toBe('https://media.micup.test/poster.jpg');
		act(() => tiles()[1]!.click());
		expect(RouterUtils.transitionTo).toHaveBeenCalledWith(`/feed/posts/${video.id}`);
		expect(FeedCommands.loadNextPage).not.toHaveBeenCalled();
	});

	it('lays the tiles out three to a row', () => {
		const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ProfileMediaGrid.module.css'), 'utf8');
		expect(css).toMatch(/\n\.grid \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
		expect(css).toMatch(/\n\.tile \{[^}]*aspect-ratio: 1;/);
	});

	// TEMPORARY: a text-heavy account would otherwise chain requests until its grid fills.
	it('asks for older pages by itself at most five times, then shows a button', async () => {
		vi.mocked(FeedCommands.loadNextPage).mockImplementation(async () => {
			FeedTimeline.handleFetchSuccess(KEY, textPage(25), false);
		});
		FeedTimeline.handleFetchSuccess(KEY, [withImage(), ...textPage(24)], true);
		await act(async () => render());
		expect(FeedCommands.loadNextPage).toHaveBeenCalledTimes(5);
		expect(tiles()).toHaveLength(1);
		expect(olderButton()).not.toBeNull();
		act(() => olderButton()!.click());
		expect(FeedCommands.retry).toHaveBeenCalledWith(KEY);
		expect(FeedCommands.loadNextPage).toHaveBeenCalledTimes(5);
	});

	it('asks for nothing more once the grid has a screenful', () => {
		FeedTimeline.handleFetchSuccess(KEY, Array.from({length: 12}, withImage), true);
		render();
		expect(FeedCommands.loadNextPage).not.toHaveBeenCalled();
		expect(olderButton()).not.toBeNull();
	});

	it('says "No media to show." when the posts hold none, never that you cannot see them', () => {
		FeedTimeline.handleFetchSuccess(KEY, textPage(3), true);
		FeedTimeline.handleFetchSuccess(KEY, [], false);
		render();
		expect(container.textContent).toBe('No media to show.');
	});
});

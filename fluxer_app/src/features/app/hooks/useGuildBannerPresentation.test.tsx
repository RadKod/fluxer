// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {useGuildBannerPresentation} from '@app/features/app/hooks/useGuildBannerPresentation';
import type {Guild} from '@app/features/guild/models/Guild';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {motionValue} from 'framer-motion';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';

vi.mock('@app/features/accessibility/state/Accessibility', () => ({
	default: {useReducedMotion: false, isAnimationKeptUnderReducedMotion: () => false},
}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {getGifAutoPlay: () => true}}));
vi.mock('@app/features/app/hooks/useSaveData', () => ({useSaveData: () => false}));
vi.mock('@app/features/ui/state/MobileLayout', () => ({default: {isMobileLayout: () => false}}));
vi.mock('@app/features/user/utils/AvatarUtils', () => ({
	getGuildBannerURL: ({banner}: {banner: string | null}, animated: boolean) =>
		banner ? `${animated && banner.startsWith('a_') ? 'animated' : 'static'}:${banner}` : null,
}));

let root: Root;
let host: HTMLElement;
let result: ReturnType<typeof useGuildBannerPresentation>;
const scrollY = motionValue(0);
function Header({guild}: {guild: Guild}) {
	result = useGuildBannerPresentation({guild, scrollY});
	return <div ref={result.hoverRef} />;
}
const guild = (banner: string | null, detached = false) =>
	({id: 'B', banner, features: new Set(detached ? [GuildFeatures.DETACHED_BANNER] : [])}) as unknown as Guild;
beforeEach(() => {
	document.documentElement.classList.add('window-focused');
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
	vi.stubGlobal('fetch', vi.fn());
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	document.documentElement.classList.remove('window-focused');
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
test.each([null, 'static_hash'])('a %s banner returns a no-op hover ref', async (banner) => {
	await act(async () => root.render(<Header guild={guild(banner)} />));
	const node = document.createElement('div');
	const add = vi.spyOn(node, 'addEventListener');
	act(() => result.hoverRef(node));
	expect(add).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
});
test('the integrated instance of a detached banner neither fetches nor subscribes to playback', async () => {
	const add = vi.spyOn(document, 'addEventListener');
	await act(async () => root.render(<Header guild={guild('a_hash', true)} />));
	expect(fetch).not.toHaveBeenCalled();
	expect(add.mock.calls.map(([event]) => event)).not.toContain('visibilitychange');
	expect(result.imageUrl).toBeNull();
});
test('unchanged presentation retains its identity on a parent rerender', async () => {
	const server = guild(null);
	await act(async () => root.render(<Header guild={server} />));
	const previous = result;
	await act(async () => root.render(<Header guild={server} />));
	expect(result).toBe(previous);
});

test('animated banner hover and static-to-Blob changes retain the channel list value', async () => {
	const bytes = new Uint8Array([
		71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44,
		1, 0, 0x3b,
	]);
	let finish!: (response: Response) => void;
	vi.mocked(fetch).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	const createURL = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:entry').mockReturnValue('blob:hover');
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
	const server = guild('a_hash');
	await act(async () => root.render(<Header guild={server} />));
	const previous = result.channelList;
	expect(previous).toMatchObject({collapsible: true});
	expect(result.imageUrl).toBe('static:a_hash');
	await act(async () =>
		finish({
			ok: true,
			headers: new Headers(),
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				},
			}),
		} as Response),
	);
	expect(result.imageUrl).toBe('blob:entry');
	expect(result.channelList).toBe(previous);
	vi.spyOn(host.firstElementChild!, 'matches').mockReturnValue(true);
	await act(async () => {
		host.firstElementChild!.dispatchEvent(new MouseEvent('mouseenter'));
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
	expect(createURL).toHaveBeenCalledTimes(2);
	expect(result.imageUrl).toBe('blob:hover');
	expect(result.channelList).toBe(previous);
});

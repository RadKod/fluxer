// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {GuildDetachedBanner} from '@app/features/app/components/layout/GuildDetachedBanner';
import type {Guild} from '@app/features/guild/models/Guild';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';

vi.mock('@app/features/accessibility/state/Accessibility', () => ({
	default: {useReducedMotion: false, isAnimationKeptUnderReducedMotion: () => false},
}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {getGifAutoPlay: () => true}}));
vi.mock('@app/features/app/hooks/useSaveData', () => ({useSaveData: () => false}));
vi.mock('@app/features/app/hooks/useAnimatedMediaPlayback', () => ({useAnimatedMediaPlaybackAllowed: () => true}));
vi.mock('@app/features/user/utils/AvatarUtils', () => ({
	getGuildBannerURL: ({id, banner}: {id: string; banner: string | null}, animated: boolean) =>
		banner ? `${animated ? 'animated' : 'static'}:${id}:${banner}` : null,
}));

class FakeObserver {
	static instances: Array<FakeObserver> = [];
	observe = vi.fn();
	unobserve = vi.fn();
	disconnect = vi.fn();
	constructor(readonly callback: IntersectionObserverCallback) {
		FakeObserver.instances.push(this);
	}
	enter(target: Element, visible: boolean) {
		this.callback(
			[{target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0} as IntersectionObserverEntry],
			this as unknown as IntersectionObserver,
		);
	}
}
let root: Root;
let host: HTMLElement;
const fetchMock = vi.fn();
const revokeURL = vi.fn();
const guild = (id = 'A', banner = 'a_hash') =>
	({
		id,
		banner,
		features: new Set([GuildFeatures.DETACHED_BANNER]),
	}) as unknown as Guild;
const node = () => host.querySelector('[data-flx="app.guild-detached-banner.container"]')!;
const image = () => host.querySelector('img')!.getAttribute('src');
async function render(server = guild()) {
	await act(async () => root.render(<GuildDetachedBanner guild={server} />));
}
beforeEach(() => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
	FakeObserver.instances = [];
	vi.stubGlobal('IntersectionObserver', FakeObserver);
	const bytes = new Uint8Array([
		71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44,
		1, 0, 0x3b,
	]);
	fetchMock.mockReset().mockImplementation(async () => ({
		ok: true,
		headers: new Headers(),
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
	}));
	vi.stubGlobal('fetch', fetchMock);
	vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:banner');
	revokeURL.mockReset();
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeURL);
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test('offscreen entry waits, enters once and never autoplays again after scrolling out', async () => {
	await render();
	expect(fetchMock).not.toHaveBeenCalled();
	expect(image()).toBe('static:A:a_hash');
	expect(FakeObserver.instances).toHaveLength(1);
	const observer = FakeObserver.instances[0];
	expect(observer.observe).toHaveBeenCalledExactlyOnceWith(node());
	await act(async () => observer.enter(node(), false));
	expect(fetchMock).not.toHaveBeenCalled();
	await act(async () => observer.enter(node(), true));
	expect(fetchMock).toHaveBeenCalledOnce();
	expect(image()).toBe('blob:banner');
	await act(async () => observer.enter(node(), false));
	expect(revokeURL).toHaveBeenCalledExactlyOnceWith('blob:banner');
	await act(async () => observer.enter(node(), true));
	expect(fetchMock).toHaveBeenCalledOnce();
	expect(image()).toBe('static:A:a_hash');
});

test.each(['guild', 'hash'] as const)(
	'a changed %s disconnects observation and waits for the new entry',
	async (kind) => {
		await render();
		expect(FakeObserver.instances).toHaveLength(1);
		const first = FakeObserver.instances[0];
		const oldNode = node();
		await act(async () => first.enter(oldNode, true));
		await render(kind === 'guild' ? guild('B') : guild('A', 'a_new'));
		expect(first.unobserve).toHaveBeenCalledExactlyOnceWith(oldNode);
		expect(first.disconnect).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(FakeObserver.instances).toHaveLength(2);
		const next = FakeObserver.instances[1];
		await act(async () => next.enter(node(), true));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		act(() => root.render(null));
		expect(next.unobserve).toHaveBeenCalledOnce();
		expect(next.disconnect).toHaveBeenCalledOnce();
	},
);

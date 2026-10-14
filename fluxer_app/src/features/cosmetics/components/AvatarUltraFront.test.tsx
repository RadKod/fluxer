// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import type {UltraFront} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const accessibility = vi.hoisted(() => ({useReducedMotion: false}));
const saveData = vi.hoisted(() => ({value: false}));
type Assets = typeof import('@app/features/cosmetics/utils/UltraFrontAssets');
const assets = vi.hoisted(() => ({
	preloadFrontFrames: vi.fn<Assets['preloadFrontFrames']>(),
	loadFrontIdle: vi.fn<Assets['loadFrontIdle']>(),
}));
// The real loaders, for the case that counts what reaches the network.
const real = vi.hoisted(() => ({}) as Partial<Assets>);
const ultraLayouts = vi.hoisted(() => ({frontFailed: vi.fn<(itemId: string) => void>()}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {mediaEndpoint: 'https://media.micup.test/'}}));
// The tooltip layer's root as the real hook gives it outside a portal host: the given document's root, one render
// later. The real module pulls in app stores.
vi.mock('@app/features/ui/tooltip/Tooltip', async () => {
	const {useLayoutEffect, useState} = await import('react');
	const rootOf = (owner: Document) => {
		const existing = owner.querySelector<HTMLElement>('[data-tooltip-portal-root]');
		if (existing) return existing;
		const root = owner.createElement('div');
		root.setAttribute('data-tooltip-portal-root', 'true');
		owner.body.append(root);
		return root;
	};
	return {
		useTooltipPortalRoot: (enabled = true, targetDocument: Document = document) => {
			const [root, setRoot] = useState<HTMLElement | undefined>(undefined);
			useLayoutEffect(() => {
				if (enabled) setRoot(rootOf(targetDocument));
			}, [enabled, targetDocument]);
			return enabled ? root : undefined;
		},
	};
});
// Fluxer's layout-shift watcher: measures at once, then again on each shift the test plays through `watcher.shift`.
const watcher = vi.hoisted(() => ({
	shift: () => {},
	stop: vi.fn(),
	anchor: null as Element | null,
	box: null as Element | null,
	options: null as unknown,
}));
vi.mock('@floating-ui/react-dom', () => ({
	autoUpdate: (anchor: Element, box: Element, update: () => void, options: unknown) => {
		Object.assign(watcher, {shift: update, anchor, box, options});
		update();
		return watcher.stop;
	},
}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: accessibility}));
vi.mock('@app/features/app/hooks/useSaveData', () => ({useSaveData: () => saveData.value}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/cosmetics/utils/UltraFrontAssets', async (importOriginal) => {
	Object.assign(real, await importOriginal<Assets>());
	return assets;
});
vi.mock('@app/features/cosmetics/state/UltraLayouts', () => ({default: ultraLayouts}));

const {AvatarUltraFront} = await import('@app/features/cosmetics/components/AvatarUltraFront');
const {resetTooltipScrollCoordinatorForTests} = await import('@app/features/ui/tooltip/TooltipScrollCoordinator');
const {default: styles} = await import('@app/features/cosmetics/components/AvatarUltraFront.module.css');

type Surface = 'compact' | 'voice' | 'profile';
const ITEM = '1490000000000000010';
const BASE = `https://media.micup.test/branding/cosmetic-avatar_ultra-${ITEM}`;
const FRONT: UltraFront = {closed: 'c0', open: Array.from({length: 24}, (_, i) => `f${i}`), idle: 'a_idle'};
const FRAME = 33;
// 23 steps reach the last opening frame and the 24th starts the loop; one frame to spare.
const OPEN_MS = 25 * FRAME;
const at160 = (hash: string) => `${BASE}/${hash}.webp?size=160`;

// Loads on the next microtask, as the browser's image element would.
class FakeImage {
	static requested: Array<string> = [];
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	decoding = '';
	complete = false;
	naturalWidth = 0;
	naturalHeight = 0;
	currentSrc = '';
	private url = '';
	set src(value: string) {
		this.url = value;
		FakeImage.requested.push(value);
		queueMicrotask(() => {
			this.complete = true;
			this.naturalWidth = 80;
			this.naturalHeight = 160;
			this.onload?.();
		});
	}
	get src() {
		return this.url;
	}
}

let blobs = 0;
const createObjectURL = vi.fn((_blob: Blob) => `blob:loop-${++blobs}`);
const revokeObjectURL = vi.fn((_url: string) => {});
const realObjectURL = {createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL};

describe('AvatarUltraFront', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.useFakeTimers();
		// The fake clock starts again at 0 each test; the last scroll time must not outlive its test.
		resetTooltipScrollCoordinatorForTests();
		Object.assign(URL, {createObjectURL, revokeObjectURL});
		createObjectURL.mockClear();
		revokeObjectURL.mockClear();
		assets.preloadFrontFrames.mockReset().mockImplementation(() => Promise.resolve());
		assets.loadFrontIdle.mockReset().mockImplementation(() => Promise.resolve(new Blob(['loop'])));
		ultraLayouts.frontFailed.mockClear();
		Object.assign(watcher, {shift: () => {}, anchor: null, box: null, options: null});
		watcher.stop.mockClear();
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		accessibility.useReducedMotion = false;
		saveData.value = false;
		act(() => root.unmount());
		container.remove();
		// Before the real timers come back: a spied timer must restore to the fake one the real timers then replace.
		vi.restoreAllMocks();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		Object.assign(URL, realObjectURL);
	});

	const render = ({
		size = 40,
		animate = false,
		surface = 'compact',
		key,
		itemId = ITEM,
	}: {
		size?: number;
		animate?: boolean;
		surface?: Surface;
		key?: string;
		itemId?: string;
	} = {}) =>
		act(() => root.render(createElement(AvatarUltraFront, {key, itemId, front: FRONT, size, animate, surface})));
	// Settles the frame and loop downloads the first open asked for.
	const flush = () => act(async () => {});
	// Commits between small slices of time, as the browser renders between timers.
	const advance = async (ms: number, slice = FRAME) => {
		for (let left = ms; left > 0; left -= slice) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(Math.min(slice, left));
			});
		}
	};
	// One layer's images, in place or in the tooltip layer.
	const images = () => Array.from(document.body.querySelectorAll('img'));
	const frame = () => images()[0]?.getAttribute('src') ?? null;
	const loop = () => images()[2]?.getAttribute('src') ?? null;
	const inPlace = (node: Element = container) => Array.from(node.querySelectorAll('img'));
	const overlaid = () =>
		Array.from(document.querySelector('[data-tooltip-portal-root]')?.querySelectorAll('img') ?? []);
	const sources = (list: Array<HTMLImageElement>) => list.map((image) => image.getAttribute('src'));

	it('shows the closed frame at rest from one URL in both halves, the right one mirrored', () => {
		render();
		const [left, right] = images();
		expect(images()).toHaveLength(2);
		expect(left.getAttribute('src')).toBe(at160('c0'));
		expect(right.getAttribute('src')).toBe(at160('c0'));
		expect(right.classList.contains(styles.mirror)).toBe(true);
		expect(left.classList.contains(styles.mirror)).toBe(false);
		expect(assets.preloadFrontFrames).not.toHaveBeenCalled();
		expect(assets.loadFrontIdle).not.toHaveBeenCalled();
	});

	it('caps an in-front image at 600', () => {
		render({size: 192, surface: 'voice'});
		expect(frame()).toBe(`${BASE}/c0.webp?size=600`);
	});

	it('does not step before every frame has loaded', async () => {
		let loaded = () => {};
		assets.preloadFrontFrames.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					loaded = () => resolve();
				}),
		);
		render({animate: true});
		expect(assets.preloadFrontFrames).toHaveBeenCalledWith(FRONT.open.map(at160));
		await advance(200);
		expect(frame()).toBe(at160('c0'));
		await act(async () => loaded());
		expect(frame()).toBe(at160('f0'));
		await advance(FRAME);
		expect(frame()).toBe(at160('f1'));
	});

	it('opens at 33 ms a frame, then loops the idle from a blob URL', async () => {
		render({animate: true});
		await flush();
		expect(frame()).toBe(at160('f0'));
		await advance(FRAME);
		expect(frame()).toBe(at160('f1'));
		await advance(22 * FRAME);
		expect(frame()).toBe(at160('f23'));
		expect(loop()).toBeNull();
		await advance(2 * FRAME);
		expect(loop()).toMatch(/^blob:/);
		expect(images()[3].getAttribute('src')).toBe(loop());
		expect(images()[3].classList.contains(styles.mirror)).toBe(true);
		expect(images()[0].classList.contains(styles.hidden)).toBe(false);
		act(() => {
			images()[2].dispatchEvent(new Event('load'));
		});
		expect(images()[0].classList.contains(styles.hidden)).toBe(true);
		expect(images()[1].classList.contains(styles.hidden)).toBe(true);
	});

	it('keeps the 0.8 s opening and closing when every timer fires late', async () => {
		// Chrome on Windows fires a 33 ms timer after ~47 ms: model a 16 ms timer grain.
		const fine = globalThis.setTimeout;
		vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms = 0) =>
			fine(callback, Math.ceil(ms / 16) * 16)) as typeof setTimeout);
		render({animate: true});
		await flush();
		// A late step skips to the frame due by now: 410 ms into the opening is frame 12.
		await advance(410, 2);
		expect(frame()).toBe(at160('f12'));
		// The loop starts 24 frames (792 ms) in, within one timer grain.
		await advance(370, 2);
		expect(loop()).toBeNull();
		await advance(28, 2);
		expect(loop()).toMatch(/^blob:/);
		// Closing steps back from frame 23: at rest 23 frames (759 ms) later, within one timer grain.
		render({animate: false});
		await advance(740, 2);
		expect(frame()).not.toBe(at160('c0'));
		await advance(36, 2);
		expect(frame()).toBe(at160('c0'));
	});

	it('closes back from the frame it is on', async () => {
		render({animate: true});
		await flush();
		await advance(10 * FRAME);
		expect(frame()).toBe(at160('f10'));
		render({animate: false});
		expect(frame()).toBe(at160('f10'));
		await advance(FRAME);
		expect(frame()).toBe(at160('f9'));
		await advance(FRAME);
		expect(frame()).toBe(at160('f8'));
		await advance(8 * FRAME);
		expect(frame()).toBe(at160('c0'));
		expect(vi.getTimerCount()).toBe(0);
	});

	it('restarts the loop without the network: ten open-close cycles after the first', async () => {
		// Real frame and loop loading through a fresh item; only the network under them is faked.
		const item = '1490000000000000011';
		const base = `https://media.micup.test/branding/cosmetic-avatar_ultra-${item}`;
		assets.preloadFrontFrames.mockImplementation((urls) =>
			(real.preloadFrontFrames as Assets['preloadFrontFrames'])(urls),
		);
		assets.loadFrontIdle.mockImplementation((url) => (real.loadFrontIdle as Assets['loadFrontIdle'])(url));
		FakeImage.requested = [];
		vi.stubGlobal('Image', FakeImage);
		const fetchSpy = vi.fn(async (_url: string) => new Response(new Blob(['loop']), {status: 200}));
		vi.stubGlobal('fetch', fetchSpy);
		const loops = new Set<string | null>();
		render({itemId: item, animate: true});
		await flush();
		await advance(OPEN_MS);
		expect(loop()).toMatch(/^blob:/);
		loops.add(loop());
		for (let cycle = 0; cycle < 10; cycle++) {
			render({itemId: item, animate: false});
			await advance(OPEN_MS);
			expect(frame()).toBe(`${base}/c0.webp?size=160`);
			expect(loop()).toBeNull();
			render({itemId: item, animate: true});
			await advance(OPEN_MS);
			expect(loop()).toMatch(/^blob:/);
			loops.add(loop());
		}
		expect(loops.size).toBe(11);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy).toHaveBeenCalledWith(`${base}/a_idle.webp?size=160&animated=true`);
		expect(FakeImage.requested).toEqual(FRONT.open.map((hash) => `${base}/${hash}.webp?size=160`));
		expect(createObjectURL).toHaveBeenCalledTimes(11);
		expect(revokeObjectURL).toHaveBeenCalledTimes(10);
	});

	it('keeps it closed and still under reduced motion and save data, on a profile card too', async () => {
		accessibility.useReducedMotion = true;
		render({size: 80, surface: 'profile', animate: true, key: 'reduced-motion'});
		await flush();
		await advance(OPEN_MS);
		expect(frame()).toBe(`${BASE}/c0.webp?size=300`);
		expect(images()).toHaveLength(2);

		accessibility.useReducedMotion = false;
		saveData.value = true;
		render({size: 80, surface: 'profile', animate: true, key: 'save-data'});
		await flush();
		await advance(OPEN_MS);
		expect(frame()).toBe(`${BASE}/c0.webp?size=300`);
		expect(images()).toHaveLength(2);
		expect(assets.preloadFrontFrames).not.toHaveBeenCalled();
		expect(assets.loadFrontIdle).not.toHaveBeenCalled();
	});

	it('a voice tile stays open for one loop', async () => {
		render({size: 48, surface: 'voice', animate: true});
		await flush();
		await advance(OPEN_MS);
		expect(loop()).toMatch(/^blob:/);
		await advance(1000);
		render({size: 48, surface: 'voice', animate: false});
		// The loop started at 24 frames (792 ms); it holds until 792 + 3,400 ms.
		await advance(2300);
		expect(loop()).toMatch(/^blob:/);
		await advance(200);
		expect(loop()).toBeNull();
		await advance(OPEN_MS);
		expect(frame()).toContain('/c0.webp?size=');
	});

	it('stops speaking during the opening, still opens fully and loops once', async () => {
		render({size: 48, surface: 'voice', animate: true});
		await flush();
		await advance(10 * FRAME);
		render({size: 48, surface: 'voice', animate: false});
		await advance(OPEN_MS - 10 * FRAME);
		expect(loop()).toMatch(/^blob:/);
		await advance(3300);
		expect(loop()).toMatch(/^blob:/);
		await advance(200);
		expect(loop()).toBeNull();
		await advance(OPEN_MS);
		expect(frame()).toContain('/c0.webp?size=');
	});

	it('plays the loop when speaking stops before the loop download lands', async () => {
		let land = (_blob: Blob) => {};
		assets.loadFrontIdle.mockImplementationOnce(
			() =>
				new Promise<Blob>((resolve) => {
					land = resolve;
				}),
		);
		render({size: 48, surface: 'voice', animate: true});
		await flush();
		await advance(10 * FRAME);
		render({size: 48, surface: 'voice', animate: false});
		await advance(OPEN_MS - 10 * FRAME);
		await act(async () => land(new Blob(['loop'])));
		expect(loop()).toMatch(/^blob:/);
	});

	it('opens on keyboard focus of the row it sits in', async () => {
		const row = document.createElement('button');
		container.append(row);
		const matches = row.matches.bind(row);
		Object.defineProperty(row, 'matches', {
			value: (selector: string) => selector === ':focus-visible' || matches(selector),
		});
		const rowRoot = createRoot(row);
		act(() =>
			rowRoot.render(
				createElement(AvatarUltraFront, {itemId: ITEM, front: FRONT, size: 40, animate: false, surface: 'compact'}),
			),
		);
		expect(frame()).toBe(at160('c0'));
		act(() => {
			row.dispatchEvent(new FocusEvent('focusin', {bubbles: true}));
		});
		await flush();
		await advance(3 * FRAME);
		expect(frame()).toBe(at160('f3'));
		act(() => {
			row.dispatchEvent(new FocusEvent('focusout', {bubbles: true}));
		});
		await advance(OPEN_MS);
		expect(frame()).toBe(at160('c0'));
		act(() => rowRoot.unmount());
	});

	it('does not open for a wide focusable ancestor', async () => {
		// A list three levels above the avatar container: focusing anything in it must not open every wing.
		const list = document.createElement('div');
		list.tabIndex = 0;
		const avatar = list
			.appendChild(document.createElement('div'))
			.appendChild(document.createElement('div'))
			.appendChild(document.createElement('div'));
		container.append(list);
		const matches = list.matches.bind(list);
		Object.defineProperty(list, 'matches', {
			value: (selector: string) => selector === ':focus-visible' || matches(selector),
		});
		const avatarRoot = createRoot(avatar);
		act(() =>
			avatarRoot.render(
				createElement(AvatarUltraFront, {itemId: ITEM, front: FRONT, size: 40, animate: false, surface: 'compact'}),
			),
		);
		act(() => {
			list.dispatchEvent(new FocusEvent('focusin', {bubbles: true}));
		});
		await flush();
		await advance(OPEN_MS);
		expect(frame()).toBe(at160('c0'));
		expect(assets.preloadFrontFrames).not.toHaveBeenCalled();
		act(() => avatarRoot.unmount());
	});

	// The avatar's real ancestors, outermost first; the last is BaseAvatar's container, where the layer mounts.
	type Shape = Array<[tag: string, attributes?: Record<string, string>]>;
	const SCROLLER: Shape[number] = ['div', {role: 'group', tabindex: '-1', 'data-fluxer-scroll-container': 'true'}];
	const AVATAR: Shape[number] = ['div', {'aria-hidden': 'true'}];
	const mountIn = (shape: Shape) => {
		const nodes = shape.map(([tag, attributes = {}]) => {
			const node = document.createElement(tag);
			for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
			// happy-dom has no :focus-visible; every node here counts as keyboard-focused.
			const matches = node.matches.bind(node);
			Object.defineProperty(node, 'matches', {
				value: (selector: string) => selector === ':focus-visible' || matches(selector),
			});
			return node;
		});
		nodes.reduce((parent, child) => parent.appendChild(child));
		container.append(nodes[0]);
		const avatarRoot = createRoot(nodes[nodes.length - 1]);
		act(() =>
			avatarRoot.render(
				createElement(AvatarUltraFront, {itemId: ITEM, front: FRONT, size: 40, animate: false, surface: 'compact'}),
			),
		);
		return {nodes, unmount: () => act(() => avatarRoot.unmount())};
	};
	const focus = (node: Element) =>
		act(() => {
			node.dispatchEvent(new FocusEvent('focusin', {bubbles: true}));
		});

	it.each<[string, Shape]>([
		// MemberListItem: scroller > virtual row > button > grid > content > avatar container > avatar.
		['a member list row', [SCROLLER, ['div'], ['button', {type: 'button'}], ['div'], ['span'], ['div'], AVATAR]],
		[
			'a member list row with a nameplate',
			[SCROLLER, ['div'], ['button', {type: 'button'}], ['div'], ['div'], ['span'], ['div'], AVATAR],
		],
		// VoiceParticipantTile: tile (role=button) > placeholder > avatar ring > avatar.
		['a voice tile', [['div', {role: 'button', tabindex: '0'}], ['div'], ['div'], AVATAR]],
	])('opens on keyboard focus of %s', async (_surface, shape) => {
		const {nodes, unmount} = mountIn(shape);
		const owner = nodes.find((node) => node.matches('button, [role="button"]'));
		expect(owner).toBeDefined();
		if (owner) focus(owner);
		await flush();
		await advance(3 * FRAME);
		expect(frame()).toBe(at160('f3'));
		unmount();
	});

	it('in a chat row, focusing the message or the message list never opens it', async () => {
		// ChannelMessages: scroller > content > log > message group > message (tabindex -1) > avatar; no button on the way.
		const {nodes, unmount} = mountIn([
			SCROLLER,
			['div'],
			['div', {role: 'log'}],
			['div', {role: 'group'}],
			['div', {role: 'article', tabindex: '-1'}],
			AVATAR,
		]);
		for (const node of nodes) focus(node);
		await flush();
		await advance(OPEN_MS);
		expect(frame()).toBe(at160('c0'));
		expect(assets.preloadFrontFrames).not.toHaveBeenCalled();
		unmount();
	});

	it.each<[string, Shape[number]]>([
		['a list', ['div', {role: 'list'}]],
		['a scroller', SCROLLER],
	])('never climbs past %s to a button around it', async (_root, stop) => {
		const {nodes, unmount} = mountIn([['button', {type: 'button'}], stop, ['div'], AVATAR]);
		focus(nodes[0]);
		await flush();
		await advance(OPEN_MS);
		expect(frame()).toBe(at160('c0'));
		expect(assets.preloadFrontFrames).not.toHaveBeenCalled();
		unmount();
	});

	it('never stacks timers when the pointer flaps', async () => {
		render();
		let animate = false;
		for (let elapsed = 0; elapsed < 2000; elapsed += 50) {
			animate = !animate;
			render({animate});
			await advance(50);
		}
		render({animate: false});
		await advance(1000);
		expect(frame()).toBe(at160('c0'));
		expect(vi.getTimerCount()).toBe(0);
	});

	it('revokes the loop URL and stops stepping when unmounted', async () => {
		render({animate: true});
		await flush();
		await advance(OPEN_MS);
		const url = loop();
		expect(url).toMatch(/^blob:/);
		act(() => root.unmount());
		expect(revokeObjectURL).toHaveBeenCalledWith(url);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('takes its tooltip layer box, watcher and listeners away when unmounted open', async () => {
		const ownerWindow = document.defaultView ?? window;
		const spies = [
			[
				vi.spyOn(document, 'addEventListener'),
				vi.spyOn(document, 'removeEventListener'),
				['pointerdown', 'focusin', 'scroll'],
			],
			[vi.spyOn(ownerWindow, 'addEventListener'), vi.spyOn(ownerWindow, 'removeEventListener'), ['resize', 'blur']],
		] as const;
		render({animate: true});
		await flush();
		await advance(FRAME);
		expect(overlaid()).toHaveLength(2);
		act(() => root.unmount());
		expect(overlaid()).toHaveLength(0);
		expect(watcher.stop).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		const count = (spy: {mock: {calls: Array<Array<unknown>>}}, type: string) =>
			spy.mock.calls.filter(([name]) => name === type).length;
		for (const [added, removed, types] of spies) {
			for (const type of types) {
				expect(count(added, type)).toBeGreaterThan(0);
				expect(count(removed, type)).toBe(count(added, type));
			}
		}
	});

	it('runs one frame timer at a time, also when the direction turns', async () => {
		render({animate: true});
		await flush();
		await advance(5 * FRAME);
		expect(vi.getTimerCount()).toBe(1);
		render({animate: false});
		expect(vi.getTimerCount()).toBe(1);
		render({animate: true});
		expect(vi.getTimerCount()).toBe(1);
		await advance(OPEN_MS);
		expect(loop()).toMatch(/^blob:/);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('falls back to the plain loop URL when the download fails', async () => {
		assets.loadFrontIdle.mockImplementationOnce(() => Promise.reject(new Error('cors')));
		render({animate: true});
		await flush();
		await advance(OPEN_MS);
		expect(loop()).toBe(`${BASE}/a_idle.webp?size=160&animated=true`);
		expect(images()[3].getAttribute('src')).toBe(loop());
		expect(createObjectURL).not.toHaveBeenCalled();
	});

	it('draws the item behind when the closed frame fails to load', () => {
		render();
		act(() => {
			images()[0].dispatchEvent(new Event('error'));
		});
		expect(ultraLayouts.frontFailed).toHaveBeenCalledWith(ITEM);
	});

	it('draws the open wings of a chat or member row in the tooltip layer over the avatar, measured once', async () => {
		const measure = vi
			.spyOn(Element.prototype, 'getBoundingClientRect')
			.mockReturnValue(new DOMRect(60, 200, 138.72, 138.72));
		render({animate: true});
		await flush();
		await advance(3 * FRAME);
		expect(inPlace()).toHaveLength(0);
		expect(sources(overlaid())).toEqual([at160('f3'), at160('f3')]);
		const box = overlaid()[0].parentElement;
		expect(box?.style.left).toBe('60px');
		expect(box?.style.top).toBe('200px');
		expect(box?.style.width).toBe('138.72px');
		expect(box?.style.height).toBe('138.72px');
		expect(box?.getAttribute('aria-hidden')).toBe('true');
		expect(box?.classList.contains(styles.floating)).toBe(true);
		expect(box?.getAttribute('data-flx')).toMatch(/^cosmetics\.avatar-ultra-front\./);
		await advance(OPEN_MS);
		expect(overlaid()[2]?.getAttribute('src')).toMatch(/^blob:/);
		expect(measure).toHaveBeenCalledTimes(1);
		render({animate: false});
		await advance(OPEN_MS);
		expect(overlaid()).toHaveLength(0);
		expect(sources(inPlace())).toEqual([at160('c0'), at160('c0')]);
	});

	it('follows a layout shift while open, as tooltips do, and stops watching once closed', async () => {
		const measure = vi
			.spyOn(Element.prototype, 'getBoundingClientRect')
			.mockReturnValue(new DOMRect(60, 200, 138.72, 138.72));
		render({animate: true});
		await flush();
		await advance(FRAME);
		const box = overlaid()[0].parentElement;
		expect(watcher.anchor).toBe(container.firstElementChild);
		expect(watcher.box).toBe(box);
		expect(watcher.options).toEqual({
			ancestorScroll: false,
			ancestorResize: true,
			elementResize: true,
			layoutShift: true,
		});
		// A member row above it came and went: the avatar moved up without a scroll.
		measure.mockReturnValue(new DOMRect(60, 164, 138.72, 138.72));
		act(() => watcher.shift());
		expect(box?.style.top).toBe('164px');
		expect(watcher.stop).not.toHaveBeenCalled();
		render({animate: false});
		await advance(OPEN_MS);
		expect(watcher.stop).toHaveBeenCalledTimes(1);
	});

	it.each<[Surface, number]>([
		['voice', 48],
		['profile', 80],
	])('keeps the open wings in place on a %s', async (surface, size) => {
		render({surface, size, animate: true});
		await flush();
		await advance(3 * FRAME);
		expect(overlaid()).toHaveLength(0);
		expect(inPlace()[0]?.getAttribute('src')).toContain('/f3.webp?size=');
	});

	it.each<[string, () => void]>([
		['a scroll', () => container.dispatchEvent(new Event('scroll'))],
		['a resize', () => window.dispatchEvent(new Event('resize'))],
		// A click opens a popout or a context menu, both under the tooltip layer.
		['a click', () => document.body.dispatchEvent(new Event('pointerdown', {bubbles: true}))],
		// So can the keyboard: a modal, a popout or a context menu takes the focus.
		[
			'a focus elsewhere',
			() => {
				const elsewhere = document.body.appendChild(document.createElement('button'));
				elsewhere.dispatchEvent(new FocusEvent('focusin', {bubbles: true}));
				elsewhere.remove();
			},
		],
		['a window blur', () => window.dispatchEvent(new Event('blur'))],
	])('closes the open wings at once on %s and keeps them closed until the next hover', async (_event, fire) => {
		render({animate: true});
		await flush();
		await advance(5 * FRAME);
		act(() => {
			fire();
		});
		// A scroll closes on the next animation frame, as tooltips do.
		await advance(FRAME);
		expect(overlaid()).toHaveLength(0);
		expect(sources(inPlace())).toEqual([at160('c0'), at160('c0')]);
		await advance(OPEN_MS);
		expect(frame()).toBe(at160('c0'));
		render({animate: false});
		render({animate: true});
		await advance(FRAME);
		expect(overlaid()[0]?.getAttribute('src')).toBe(at160('f1'));
	});

	it('stays open when the focus comes to its own row', async () => {
		render({animate: true});
		await flush();
		await advance(3 * FRAME);
		act(() => {
			container.dispatchEvent(new FocusEvent('focusin', {bubbles: true}));
		});
		await advance(FRAME);
		expect(sources(overlaid())).toEqual([at160('f4'), at160('f4')]);
	});

	it('counts a scroll that comes while the frames still load', async () => {
		let loaded = () => {};
		assets.preloadFrontFrames.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					loaded = () => resolve();
				}),
		);
		render({animate: true});
		// A page's clock is never at 0, where the coordinator reads no scroll.
		await advance(FRAME);
		act(() => {
			container.dispatchEvent(new Event('scroll'));
		});
		await advance(FRAME);
		await act(async () => loaded());
		expect(overlaid()).toHaveLength(0);
		await advance(100, 10);
		expect(overlaid()).toHaveLength(2);
	});

	it("keeps the wings in place until the tooltip layer's first frame is decoded", async () => {
		let decoded = () => {};
		vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					decoded = () => resolve();
				}),
		);
		render({animate: true});
		await flush();
		// The layer box is up but hidden; the frame stays drawn in place meanwhile, never a blank frame.
		expect(overlaid()).toHaveLength(2);
		expect(overlaid()[0].parentElement?.style.visibility).toBe('hidden');
		expect(sources(inPlace())).toEqual([at160('f0'), at160('f0')]);
		await act(async () => decoded());
		expect(inPlace()).toHaveLength(0);
		expect(overlaid()[0].parentElement?.style.visibility).toBe('');
	});

	it('waits for the frame to load when its decode was rejected before it did', async () => {
		// The frame moved on before the first one loaded from the disk cache: the decode is rejected, nothing drawn yet.
		vi.spyOn(HTMLImageElement.prototype, 'decode').mockRejectedValue(new Error('EncodingError'));
		vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false);
		render({animate: true});
		await flush();
		await advance(FRAME);
		expect(overlaid()[0].parentElement?.style.visibility).toBe('hidden');
		expect(sources(inPlace())).toEqual([at160('f1'), at160('f1')]);
		act(() => {
			overlaid()[0].dispatchEvent(new Event('load'));
		});
		expect(inPlace()).toHaveLength(0);
		expect(overlaid()[0].parentElement?.style.visibility).toBe('');
	});

	it('shows the layer at once when the decode was rejected but the frame is drawn', async () => {
		vi.spyOn(HTMLImageElement.prototype, 'decode').mockRejectedValue(new Error('EncodingError'));
		vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
		render({animate: true});
		await flush();
		await flush();
		expect(inPlace()).toHaveLength(0);
		expect(sources(overlaid())).toEqual([at160('f0'), at160('f0')]);
		expect(overlaid()[0].parentElement?.style.visibility).toBe('');
	});

	it('waits out a scroll that came while no row was open or hovered', async () => {
		// A sparse list: the one winged row is on screen, nothing is open when the scroll comes.
		render({animate: false});
		// A page's clock is never at 0, where the coordinator reads no scroll.
		await advance(FRAME);
		act(() => {
			container.dispatchEvent(new Event('scroll'));
		});
		await advance(FRAME);
		render({animate: true});
		await flush();
		expect(overlaid()).toHaveLength(0);
		expect(sources(inPlace())).toEqual([at160('c0'), at160('c0')]);
		await advance(60, 10);
		expect(overlaid()).toHaveLength(0);
		// Settled 120 ms after the scroll: the row still under the pointer opens.
		await advance(40, 10);
		expect(inPlace()).toHaveLength(0);
		expect(overlaid()).toHaveLength(2);
	});

	// A second chat or member row layer beside the one `render` draws.
	const mountSecond = () => {
		const host = document.createElement('div');
		document.body.append(host);
		const secondRoot = createRoot(host);
		return {
			host,
			render: (animate: boolean) =>
				act(() =>
					secondRoot.render(
						createElement(AvatarUltraFront, {itemId: ITEM, front: FRONT, size: 40, animate, surface: 'compact'}),
					),
				),
			unmount: () => {
				act(() => secondRoot.unmount());
				host.remove();
			},
		};
	};

	it('does not open a row a scroll brings under a still pointer until the scroll settles', async () => {
		const second = mountSecond();
		second.render(false);
		render({animate: true});
		await flush();
		await advance(FRAME);
		const scroll = () =>
			act(() => {
				container.dispatchEvent(new Event('scroll'));
			});
		// The scroll closes this row's wings on the next animation frame, then brings the next row under the pointer.
		scroll();
		await advance(FRAME);
		render({animate: false});
		second.render(true);
		await flush();
		expect(overlaid()).toHaveLength(0);
		expect(sources(inPlace(second.host))).toEqual([at160('c0'), at160('c0')]);
		for (let wheel = 0; wheel < 5; wheel++) {
			await advance(50, 10);
			scroll();
		}
		await advance(100, 10);
		expect(overlaid()).toHaveLength(0);
		expect(sources(inPlace(second.host))).toEqual([at160('c0'), at160('c0')]);
		// Settled (120 ms, as tooltips wait): the row still under the pointer opens.
		await advance(60, 10);
		expect(inPlace(second.host)).toHaveLength(0);
		expect(overlaid()).toHaveLength(2);
		second.unmount();
	});

	it('lands on the loop after a long sleep without stepping through every missed frame', async () => {
		render({animate: true});
		await flush();
		vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1e12);
		await advance(FRAME);
		expect(loop()).toMatch(/^blob:/);
	});

	it("draws and listens in the avatar's own document", async () => {
		const other = document.implementation.createHTMLDocument('');
		const host = other.createElement('div');
		other.body.append(host);
		const otherRoot = createRoot(host);
		act(() =>
			otherRoot.render(
				createElement(AvatarUltraFront, {itemId: ITEM, front: FRONT, size: 40, animate: true, surface: 'compact'}),
			),
		);
		await flush();
		await advance(FRAME);
		const layer = other.querySelector('[data-tooltip-portal-root]');
		expect(sources(Array.from(layer?.querySelectorAll('img') ?? []))).toEqual([at160('f1'), at160('f1')]);
		expect(overlaid()).toHaveLength(0);
		act(() => {
			other.body.dispatchEvent(new Event('pointerdown', {bubbles: true}));
		});
		expect(sources(inPlace(host))).toEqual([at160('c0'), at160('c0')]);
		act(() => otherRoot.unmount());
	});

	it('keeps one open wing in the tooltip layer: opening a second closes the first', async () => {
		const second = document.createElement('div');
		document.body.append(second);
		const secondRoot = createRoot(second);
		const renderSecond = (animate: boolean) =>
			act(() =>
				secondRoot.render(
					createElement(AvatarUltraFront, {itemId: ITEM, front: FRONT, size: 40, animate, surface: 'compact'}),
				),
			);
		renderSecond(false);
		render({animate: true});
		await flush();
		await advance(3 * FRAME);
		renderSecond(true);
		await flush();
		await advance(2 * FRAME);
		expect(sources(overlaid())).toEqual([at160('f2'), at160('f2')]);
		expect(inPlace(second)).toHaveLength(0);
		expect(sources(inPlace())).toEqual([at160('c0'), at160('c0')]);
		act(() => secondRoot.unmount());
		second.remove();
	});

	it('is decoration only', () => {
		render();
		const box = container.firstElementChild;
		expect(box?.getAttribute('aria-hidden')).toBe('true');
		expect(box?.getAttribute('data-flx')).toBe('cosmetics.avatar-ultra-front.box');
		for (const image of images()) {
			expect(image.getAttribute('alt')).toBe('');
			expect(image.getAttribute('data-flx')).toMatch(/^cosmetics\.avatar-ultra-front\./);
		}
		const css = readFileSync('src/features/cosmetics/components/AvatarUltraFront.module.css', 'utf8');
		const rule = (selector: string) => {
			const start = css.indexOf(`${selector} {`);
			return start === -1 ? '' : css.slice(start, css.indexOf('}', start));
		};
		expect(rule('.front')).toContain('pointer-events: none;');
		expect(rule('.floating')).toContain('pointer-events: none;');
		expect(rule('.front')).toContain('width: 346.8%;');
		expect(rule('.front')).toContain('height: 346.8%;');
		expect(rule('.mirror')).toContain('transform: scaleX(-1);');
		// Voice tiles clip it; nothing shrinks it.
		expect(css).not.toContain('100cqh');
		expect(css).not.toContain(':has(');
	});
});

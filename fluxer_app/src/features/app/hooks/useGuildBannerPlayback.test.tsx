// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {GUILD_BANNER_MAX_BYTES, useGuildBannerPlayback} from '@app/features/app/hooks/useGuildBannerPlayback';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';

const policy = vi.hoisted(() => ({
	autoplay: true,
	reduced: false,
	kept: false,
	saveData: false,
	hovering: false,
	allowed: true,
}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({
	default: {
		get useReducedMotion() {
			return policy.reduced;
		},
		isAnimationKeptUnderReducedMotion: () => policy.kept,
	},
}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {getGifAutoPlay: () => policy.autoplay}}));
vi.mock('@app/features/app/hooks/useSaveData', () => ({useSaveData: () => policy.saveData}));
vi.mock('@app/features/app/hooks/useHover', () => ({useHover: () => [() => {}, policy.hovering]}));
vi.mock('@app/features/app/hooks/useAnimatedMediaPlayback', () => ({
	useAnimatedMediaPlaybackAllowed: () => policy.allowed,
}));

const gif = new Uint8Array([
	71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44,
	1, 0, 0x3b,
]);
const response = (bytes = gif, length?: number) => ({
	ok: true,
	headers: new Headers(length == null ? {} : {'content-length': `${length}`}),
	body: new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	}),
});
let root: Root;
let host: HTMLElement;
let result: ReturnType<typeof useGuildBannerPlayback>;
let paint: Array<string | null>;
const fetchMock = vi.fn();
const createURL = vi.fn();
const revokeURL = vi.fn();
type Options = Parameters<typeof useGuildBannerPlayback>[0];
function Banner({guildId = 'A', bannerHash = 'a_hash', visible = true, ...rest}: Partial<Options>) {
	result = useGuildBannerPlayback({
		guildId,
		bannerHash,
		visible,
		staticUrl: `static:${guildId}:${bannerHash}`,
		animatedUrl: `animated:${guildId}:${bannerHash}`,
		...rest,
	});
	paint.push(result.imageUrl);
	return null;
}
async function render(props: Partial<Options> = {}) {
	await act(async () => root.render(<Banner {...props} />));
}
beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	Object.assign(policy, {autoplay: true, reduced: false, kept: false, saveData: false, hovering: false, allowed: true});
	paint = [];
	fetchMock.mockReset().mockImplementation(async () => response());
	createURL.mockReset().mockImplementation(() => `blob:${createURL.mock.calls.length}`);
	revokeURL.mockReset();
	vi.stubGlobal('fetch', fetchMock);
	vi.stubGlobal(
		'URL',
		class extends URL {
			static override createObjectURL = createURL;
			static override revokeObjectURL = revokeURL;
		},
	);
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

test('first paint is static, then plays once; a channel rerender does not fetch or restart', async () => {
	await render();
	expect(paint[0]).toBe('static:A:a_hash');
	expect(result.imageUrl).toBe('blob:1');
	await render();
	expect(fetchMock).toHaveBeenCalledOnce();
	expect(createURL).toHaveBeenCalledOnce();
});
test('leaving and returning to a guild creates a fresh entry', async () => {
	await render();
	await render({guildId: 'B'});
	await render();
	expect(fetchMock).toHaveBeenCalledTimes(3);
	expect(createURL).toHaveBeenCalledTimes(3);
	expect(revokeURL.mock.calls.flat()).toEqual(['blob:1', 'blob:2']);
});
test('a changed banner hash resets playback', async () => {
	await render();
	await render({bannerHash: 'a_new'});
	expect(fetchMock).toHaveBeenCalledTimes(2);
	expect(result.imageUrl).toBe('blob:2');
	expect(revokeURL).toHaveBeenCalledWith('blob:1');
});
test.each(['autoplay', 'reduced', 'saveData'] as const)('policy %s disables entry autoplay', async (setting) => {
	if (setting === 'autoplay') policy.autoplay = false;
	else policy[setting] = true;
	await render();
	expect(fetchMock).not.toHaveBeenCalled();
	expect(result.imageUrl).toBe('static:A:a_hash');
});
test('banner entry stays static even with the reduced motion keep-GIF exception', async () => {
	policy.reduced = true;
	policy.kept = true;
	await render();
	expect(result.imageUrl).toBe('static:A:a_hash');
	expect(fetchMock).not.toHaveBeenCalled();
	policy.hovering = true;
	await render();
	expect(result.imageUrl).toBe('blob:1');
});
test('the keep-GIF preference alone permits banner entry autoplay', async () => {
	policy.kept = true;
	await render();
	expect(fetchMock).toHaveBeenCalledOnce();
	expect(result.imageUrl).toBe('blob:1');
});
test('an initially invisible B entry plays once when it becomes visible', async () => {
	await render({guildId: 'B', visible: false});
	expect(fetchMock).not.toHaveBeenCalled();
	await render({guildId: 'B', visible: true});
	expect(fetchMock).toHaveBeenCalledOnce();
	expect(createURL).toHaveBeenCalledOnce();
	expect(result.imageUrl).toBe('blob:1');
});
test('an initially unfocused entry plays once when playback becomes allowed', async () => {
	policy.allowed = false;
	await render();
	policy.allowed = true;
	await render();
	expect(fetchMock).toHaveBeenCalledOnce();
	expect(result.imageUrl).toBe('blob:1');
});
test('hover download finishing after leave stays static and reuses bytes on the next hover', async () => {
	policy.autoplay = false;
	let finish!: (value: ReturnType<typeof response>) => void;
	fetchMock.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	await render();
	policy.hovering = true;
	await render();
	policy.hovering = false;
	await render();
	await act(async () => finish(response()));
	expect(result.imageUrl).toBe('static:A:a_hash');
	expect(createURL).not.toHaveBeenCalled();
	policy.hovering = true;
	await render();
	expect(fetchMock).toHaveBeenCalledOnce();
	expect(createURL).toHaveBeenCalledOnce();
	expect(result.imageUrl).toBe('blob:1');
});
test('an HTTP failure aborts the response body', async () => {
	fetchMock.mockResolvedValueOnce({...response(), ok: false});
	await render();
	expect((fetchMock.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
	expect(result.imageUrl).toBe('static:A:a_hash');
});
test('disabled autoplay permits one hover play, without fetching before hover', async () => {
	policy.autoplay = false;
	await render();
	expect(fetchMock).not.toHaveBeenCalled();
	policy.hovering = true;
	await render();
	expect(result.imageUrl).toBe('blob:1');
});
test('Save Data also forbids hover', async () => {
	policy.saveData = true;
	policy.hovering = true;
	await render();
	expect(fetchMock).not.toHaveBeenCalled();
});
test('each hover entry restarts even during playback, from the same bytes', async () => {
	await render();
	policy.hovering = true;
	await render();
	expect(result.imageUrl).toBe('blob:2');
	expect(revokeURL).toHaveBeenCalledWith('blob:1');
	await render();
	expect(createURL).toHaveBeenCalledTimes(2);
	policy.hovering = false;
	await render();
	policy.hovering = true;
	await render();
	expect(result.imageUrl).toBe('blob:3');
	expect(revokeURL).toHaveBeenCalledWith('blob:2');
	expect(fetchMock).toHaveBeenCalledOnce();
});
test('collapse before playback aborts pending work without consuming entry autoplay', async () => {
	let finish!: (value: ReturnType<typeof response>) => void;
	fetchMock.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	await render();
	const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
	await render({visible: false});
	expect(signal.aborted).toBe(true);
	await act(async () => finish(response()));
	expect(createURL).not.toHaveBeenCalled();
	await render();
	expect(fetchMock).toHaveBeenCalledTimes(2);
	expect(result.imageUrl).toBe('blob:1');
});
test('hiding a loaded banner revokes its URL and reopening does not autoplay', async () => {
	await render();
	await render({visible: false});
	await render();
	expect(revokeURL).toHaveBeenCalledWith('blob:1');
	expect(createURL).toHaveBeenCalledOnce();
	expect(result.imageUrl).toBe('static:A:a_hash');
});
test('focus loss keeps the consumed Blob URL without revoking or refetching', async () => {
	await render();
	policy.allowed = false;
	await render();
	expect(result.imageUrl).toBe('blob:1');
	expect(revokeURL).not.toHaveBeenCalled();
	policy.allowed = true;
	await render();
	expect(result.imageUrl).toBe('blob:1');
	expect(fetchMock).toHaveBeenCalledOnce();
	expect(createURL).toHaveBeenCalledOnce();
});
test('turning autoplay off while entry playback is pending cancels it until an explicit hover', async () => {
	let finish!: (value: ReturnType<typeof response>) => void;
	fetchMock.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	await render();
	const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
	policy.autoplay = false;
	await render();
	expect(signal.aborted).toBe(true);
	await act(async () => finish(response()));
	expect(createURL).not.toHaveBeenCalled();
	policy.hovering = true;
	await render();
	expect(result.imageUrl).toBe('blob:1');
});
test('turning reduced motion on during autoplay releases the loaded source', async () => {
	await render();
	policy.reduced = true;
	await render();
	expect(result.imageUrl).toBe('static:A:a_hash');
	expect(revokeURL).toHaveBeenCalledWith('blob:1');
});
test('unmount while downloading aborts and ignores the late response', async () => {
	let finish!: (value: ReturnType<typeof response>) => void;
	fetchMock.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	await render();
	const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
	act(() => root.render(null));
	expect(signal.aborted).toBe(true);
	await act(async () => finish(response()));
	expect(createURL).not.toHaveBeenCalled();
});
test('a late A response cannot replace B or allocate a stale Blob', async () => {
	let finish!: (value: ReturnType<typeof response>) => void;
	fetchMock.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	await render();
	const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
	await render({guildId: 'B'});
	expect(signal.aborted).toBe(true);
	await act(async () => finish(response()));
	expect(result.imageUrl).toBe('blob:1');
	expect(createURL).toHaveBeenCalledOnce();
});
test('unmount revokes the active URL after the download has completed', async () => {
	await render();
	act(() => root.render(null));
	expect(revokeURL).toHaveBeenCalledExactlyOnceWith('blob:1');
});

test('hover after collapse downloads a new Blob while entry autoplay stays consumed', async () => {
	await render();
	await render({visible: false});
	await render();
	expect(result.imageUrl).toBe('static:A:a_hash');
	policy.hovering = true;
	await render();
	expect(fetchMock).toHaveBeenCalledTimes(2);
	expect(result.imageUrl).toBe('blob:2');
});
test.each(['declared', 'streamed'] as const)('rejects %s responses over the byte limit', async (kind) => {
	fetchMock.mockResolvedValueOnce(
		kind === 'declared'
			? response(gif, GUILD_BANNER_MAX_BYTES + 1)
			: response(new Uint8Array(GUILD_BANNER_MAX_BYTES + 1)),
	);
	await render();
	expect(result.imageUrl).toBe('static:A:a_hash');
	expect(createURL).not.toHaveBeenCalled();
	expect((fetchMock.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
});
test.each(['malformed', 'http', 'network'] as const)('falls back silently on %s failure', async (kind) => {
	if (kind === 'network') fetchMock.mockRejectedValueOnce(new Error('offline'));
	else
		fetchMock.mockResolvedValueOnce(kind === 'http' ? {...response(), ok: false} : response(new Uint8Array([1, 2, 3])));
	await render();
	await render();
	expect(result.imageUrl).toBe('static:A:a_hash');
	expect(fetchMock).toHaveBeenCalledOnce();
	expect(createURL).not.toHaveBeenCalled();
});

test.each(
	(['malformed', 'http', 'network', 'declared', 'streamed'] as const).flatMap((kind) =>
		(['visibility', 'focus', 'hover'] as const).map((event) => ({kind, event})),
	),
)('a $kind failure survives $event and is retried only on a fresh guild entry', async ({kind, event}) => {
	if (kind === 'network') fetchMock.mockRejectedValueOnce(new Error('offline'));
	else if (kind === 'http') fetchMock.mockResolvedValueOnce({...response(), ok: false});
	else if (kind === 'declared') fetchMock.mockResolvedValueOnce(response(gif, GUILD_BANNER_MAX_BYTES + 1));
	else if (kind === 'streamed') fetchMock.mockResolvedValueOnce(response(new Uint8Array(GUILD_BANNER_MAX_BYTES + 1)));
	else fetchMock.mockResolvedValueOnce(response(new Uint8Array([1, 2, 3])));
	await render();
	if (event === 'visibility') await render({visible: false});
	else if (event === 'focus') {
		policy.allowed = false;
		await render();
		policy.allowed = true;
	} else policy.hovering = true;
	await render();
	expect(fetchMock).toHaveBeenCalledOnce();
	expect(createURL).not.toHaveBeenCalled();
	await render({guildId: 'B', bannerHash: null, animatedUrl: null});
	await render();
	expect(fetchMock).toHaveBeenCalledTimes(2);
	expect(result.imageUrl).toBe('blob:1');
});

test('the GIF Blob sent to createObjectURL removes NETSCAPE2.0 and preserves every other byte', async () => {
	const extension = [0x21, 0xff, 11, ...Array.from('NETSCAPE2.0', (char) => char.charCodeAt(0)), 3, 1, 0, 0, 0];
	const source = new Uint8Array([...gif.subarray(0, 19), ...extension, ...gif.subarray(19)]);
	fetchMock.mockResolvedValueOnce(response(source));
	await render();
	const blob = createURL.mock.calls[0][0] as Blob;
	const output = new Uint8Array(await blob.arrayBuffer());
	expect(blob.type).toBe('image/gif');
	expect(new TextDecoder().decode(output)).not.toContain('NETSCAPE2.0');
	expect(output).toEqual(gif);
});

test('the WebP Blob sent to createObjectURL has loop bytes 1,0 and preserves every other byte', async () => {
	const ascii = (value: string) => Array.from(value, (char) => char.charCodeAt(0));
	const le32 = (value: number) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, value >>> 24];
	const chunk = (id: string, data: Array<number>) => [
		...ascii(id),
		...le32(data.length),
		...data,
		...(data.length % 2 ? [0] : []),
	];
	const body = [
		...ascii('WEBP'),
		...chunk('VP8X', [2, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
		...chunk('ANIM', [4, 3, 2, 1, 0, 0]),
		...chunk('ANMF', [...Array<number>(16).fill(0), ...chunk('VP8L', [0x2f, 0, 0, 0, 0])]),
	];
	const source = new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body]);
	fetchMock.mockResolvedValueOnce(response(source));
	await render();
	const blob = createURL.mock.calls[0][0] as Blob;
	const output = new Uint8Array(await blob.arrayBuffer());
	expect(blob.type).toBe('image/webp');
	expect(Array.from(output.subarray(42, 44))).toEqual([1, 0]);
	expect(output.subarray(0, 42)).toEqual(source.subarray(0, 42));
	expect(output.subarray(44)).toEqual(source.subarray(44));
});

const deferred = () => {
	let finish!: (value: ReturnType<typeof response>) => void;
	fetchMock.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	return (value = response()) => act(async () => finish(value));
};

test('re-hovering a consumed entry while its download is in flight keeps a single owned fetch', async () => {
	await render();
	await render({visible: false});
	await render();
	const finish = deferred();
	policy.hovering = true;
	await render();
	policy.hovering = false;
	await render();
	policy.hovering = true;
	await render();
	expect(fetchMock).toHaveBeenCalledTimes(2);
	const signal = fetchMock.mock.calls[1][1].signal as AbortSignal;
	expect(signal.aborted).toBe(false);
	await finish();
	expect(result.imageUrl).toBe('blob:2');
	expect(fetchMock).toHaveBeenCalledTimes(2);
});
test.each(['focus', 'visibility'] as const)(
	'a held hover Blob released by %s loss is downloaded again on the next hover',
	async (event) => {
		policy.autoplay = false;
		const finish = deferred();
		await render();
		policy.hovering = true;
		await render();
		policy.hovering = false;
		await render();
		await finish();
		expect(createURL).not.toHaveBeenCalled();
		if (event === 'focus') {
			policy.allowed = false;
			await render();
			policy.allowed = true;
			await render();
		} else {
			await render({visible: false});
			await render();
		}
		policy.hovering = true;
		await render();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.imageUrl).toBe('blob:1');
	},
);

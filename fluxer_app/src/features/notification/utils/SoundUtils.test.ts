// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/notification/utils/CustomSoundDB', () => ({getCustomSound: vi.fn(async () => null)}));

class FakeParam {
	value = 1;
	cancelScheduledValues(): void {}
	setValueAtTime(): void {}
	linearRampToValueAtTime(): void {}
}

class FakeNode {
	readonly gain = new FakeParam();
	readonly connect = vi.fn();
	readonly disconnect = vi.fn();
	constructor(readonly context: FakeAudioContext) {}
}

class FakeAudioContext {
	static created: Array<FakeAudioContext> = [];
	state: 'running' | 'suspended' | 'closed' = 'running';
	currentTime = 0;
	readonly destination = {name: 'destination'};
	readonly createMediaElementSource = vi.fn(() => new FakeNode(this));
	readonly createGain = vi.fn(() => new FakeNode(this));
	readonly suspend = vi.fn(async () => {
		this.state = 'suspended';
	});
	readonly resume = vi.fn(async () => {
		this.state = 'running';
	});
	constructor() {
		FakeAudioContext.created.push(this);
	}
}

class FakeAudio extends EventTarget {
	static created: Array<FakeAudio> = [];
	src = '';
	crossOrigin: string | null = null;
	preload = '';
	currentTime = 0;
	loop = false;
	volume = 1;
	paused = true;
	error: unknown = null;
	private rejectPlay: ((error: unknown) => void) | null = null;
	holdPlay = false;
	constructor() {
		super();
		FakeAudio.created.push(this);
	}
	play(): Promise<void> {
		this.paused = false;
		if (!this.holdPlay) return Promise.resolve();
		return new Promise((_resolve, reject) => {
			this.rejectPlay = reject;
		});
	}
	pause(): void {
		this.paused = true;
		this.rejectPlay?.(
			Object.assign(new Error('The play() request was interrupted by a call to pause()'), {
				name: 'AbortError',
			}),
		);
		this.rejectPlay = null;
	}
	loads = 0;
	removeAttribute(): void {}
	load(): void {
		this.loads++;
		this.error = null;
	}
	finish(): void {
		this.paused = true;
		this.dispatchEvent(new Event('ended'));
	}
}

type SoundUtilsModule = typeof import('@app/features/notification/utils/SoundUtils');

async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}
let SoundUtils: SoundUtilsModule;

function onlyContext(): FakeAudioContext {
	expect(FakeAudioContext.created).toHaveLength(1);
	return FakeAudioContext.created[0]!;
}

async function playAndFinish(type: SoundUtilsModule['SoundType'][keyof SoundUtilsModule['SoundType']]): Promise<void> {
	const audio = (await SoundUtils.playSound(type, false, 0.4)) as unknown as FakeAudio | null;
	expect(audio).not.toBeNull();
	audio!.finish();
}

beforeEach(async () => {
	vi.useFakeTimers();
	vi.resetModules();
	FakeAudioContext.created.length = 0;
	FakeAudio.created.length = 0;
	vi.stubGlobal('AudioContext', FakeAudioContext);
	vi.stubGlobal('Audio', FakeAudio);
	SoundUtils = await import('@app/features/notification/utils/SoundUtils');
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('sound element sources', () => {
	it('one-shot sounds reuse one element source per sound type', async () => {
		const {SoundType} = SoundUtils;
		for (let i = 0; i < 10; i++) {
			await playAndFinish(SoundType.Message);
			await playAndFinish(SoundType.UserJoin);
		}
		for (let i = 0; i < 5; i++) {
			await SoundUtils.playSound(SoundType.Mute, false, 0.4);
		}
		expect(onlyContext().createMediaElementSource).toHaveBeenCalledTimes(3);
		expect(FakeAudio.created).toHaveLength(3);
	});

	it('every play still gets its own gain at the requested volume', async () => {
		const {SoundType} = SoundUtils;
		await playAndFinish(SoundType.UserJoin);
		await playAndFinish(SoundType.UserJoin);
		const ctx = onlyContext();
		const gains = ctx.createGain.mock.results.map((result) => result.value as FakeNode);
		expect(gains).toHaveLength(2);
		expect(gains[1]!.gain.value).toBeCloseTo(0.4);
		expect(gains[1]!.connect).toHaveBeenCalledWith(ctx.destination);
	});

	it('a play cut short by the next play of the same type is not reported as autoplay blocked', async () => {
		const {SoundType} = SoundUtils;
		await playAndFinish(SoundType.UserJoin);
		const element = FakeAudio.created[0]!;
		element.holdPlay = true;
		const blocked = vi.fn();
		const first = SoundUtils.playSound(SoundType.UserJoin, false, 0.4, blocked);
		await flush();
		element.holdPlay = false;
		await SoundUtils.playSound(SoundType.UserJoin, false, 0.4, blocked);
		expect(await first).toBeNull();
		expect(blocked).not.toHaveBeenCalled();
	});

	it('looped sounds reuse one element source per sound type', async () => {
		const {SoundType} = SoundUtils;
		for (let i = 0; i < 5; i++) {
			expect(await SoundUtils.playSound(SoundType.IncomingRing, true, 0.4)).not.toBeNull();
			const stopped = SoundUtils.stopSound(SoundType.IncomingRing);
			await vi.advanceTimersByTimeAsync(100);
			await stopped;
		}
		expect(onlyContext().createMediaElementSource).toHaveBeenCalledTimes(1);
	});

	it('a ring restarted while the previous one is fading out keeps playing', async () => {
		const {SoundType} = SoundUtils;
		await SoundUtils.playSound(SoundType.IncomingRing, true, 0.4);
		const stopped = SoundUtils.stopSound(SoundType.IncomingRing);
		const ring = (await SoundUtils.playSound(SoundType.IncomingRing, true, 0.4)) as unknown as FakeAudio;
		await vi.advanceTimersByTimeAsync(100);
		await stopped;
		expect(ring.paused).toBe(false);
	});
});

describe('sound element reuse edge cases', () => {
	it('a custom sound swaps the reused element to the new file', async () => {
		const {SoundType} = SoundUtils;
		const CustomSoundDB = await import('@app/features/notification/utils/CustomSoundDB');
		await playAndFinish(SoundType.UserJoin);
		const element = FakeAudio.created[0]!;
		const defaultSrc = element.src;
		vi.mocked(CustomSoundDB.getCustomSound).mockResolvedValueOnce({blob: new Blob(['custom'])} as never);
		await playAndFinish(SoundType.UserJoin);
		expect(element.src).toMatch(/^blob:/);
		expect(element.src).not.toBe(defaultSrc);
		expect(FakeAudio.created).toHaveLength(1);
		expect(onlyContext().createMediaElementSource).toHaveBeenCalledTimes(1);
	});

	it('an element that failed to load reloads its file and keeps its source', async () => {
		const {SoundType} = SoundUtils;
		await playAndFinish(SoundType.UserJoin);
		const element = FakeAudio.created[0]!;
		for (let i = 0; i < 20; i++) {
			element.error = {code: 2};
			await playAndFinish(SoundType.UserJoin);
		}
		expect(element.loads).toBe(20);
		expect(FakeAudio.created).toHaveLength(1);
		expect(onlyContext().createMediaElementSource).toHaveBeenCalledTimes(1);
	});

	it('aborting a play that was cut short does not stop the next play of the same type', async () => {
		const {SoundType} = SoundUtils;
		const first = new AbortController();
		await SoundUtils.playSound(SoundType.UserJoin, false, 0.4, undefined, first.signal);
		const next = (await SoundUtils.playSound(SoundType.UserJoin, false, 0.4)) as unknown as FakeAudio;
		first.abort();
		expect(next.paused).toBe(false);
	});

	it('aborting a play that already ended does not stop the next play of the same type', async () => {
		const {SoundType} = SoundUtils;
		const first = new AbortController();
		const played = (await SoundUtils.playSound(
			SoundType.UserJoin,
			false,
			0.4,
			undefined,
			first.signal,
		)) as unknown as FakeAudio;
		played.finish();
		const next = (await SoundUtils.playSound(SoundType.UserJoin, false, 0.4)) as unknown as FakeAudio;
		first.abort();
		expect(next.paused).toBe(false);
	});

	it('the context keeps running after the sounds end', async () => {
		await playAndFinish(SoundUtils.SoundType.Message);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(onlyContext().suspend).not.toHaveBeenCalled();
	});
});

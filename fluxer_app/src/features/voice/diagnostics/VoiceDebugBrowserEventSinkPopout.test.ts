// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	appendBrowserVoiceDebugEventSinkEntries,
	isBrowserVoiceDebugEventSinkPopoutOpen,
	openBrowserVoiceDebugEventSinkPopout,
	resetBrowserVoiceDebugEventSinkPopoutForTests,
	setBrowserVoiceDebugEventSinkStatsHtml,
} from '@app/features/voice/diagnostics/VoiceDebugBrowserEventSinkPopout';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const HISTORY_BYTE_BUDGET = 4 * 1024 * 1024;

class FakeBroadcastChannel {
	static instances: Array<FakeBroadcastChannel> = [];
	closed = false;
	readonly listeners = new Set<unknown>();

	constructor() {
		FakeBroadcastChannel.instances.push(this);
	}

	addEventListener(_type: string, listener: unknown): void {
		this.listeners.add(listener);
	}

	removeEventListener(_type: string, listener: unknown): void {
		this.listeners.delete(listener);
	}

	postMessage(): void {}

	close(): void {
		this.closed = true;
	}
}

let blobs: Array<Blob> = [];

function stubPopoutWindow(): {closed: boolean} {
	const popout = {closed: false, focus: vi.fn(), postMessage: vi.fn()};
	vi.spyOn(window, 'open').mockReturnValue(popout as unknown as Window);
	return popout;
}

function bigEntry(sequence: number): {sequence: number; line: string} {
	return {sequence, line: JSON.stringify({sequence, type: 'big', pad: 'm'.repeat(200_000)})};
}

describe('browser voice debug event sink popout', () => {
	beforeEach(() => {
		blobs = [];
		FakeBroadcastChannel.instances = [];
		resetBrowserVoiceDebugEventSinkPopoutForTests();
		vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
			blobs.push(blob as Blob);
			return `blob:${blobs.length - 1}`;
		});
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
	});

	afterEach(() => {
		resetBrowserVoiceDebugEventSinkPopoutForTests();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		document.body.innerHTML = '';
	});

	it('keeps the popout window log within the byte budget', async () => {
		vi.stubGlobal('BroadcastChannel', undefined);
		stubPopoutWindow();
		await openBrowserVoiceDebugEventSinkPopout([]);
		const [scriptBlob, htmlBlob] = blobs;
		const html = await htmlBlob.text();
		const body = new DOMParser().parseFromString(html, 'text/html').body;
		for (const script of Array.from(body.querySelectorAll('script'))) script.remove();
		document.body.innerHTML = body.innerHTML;
		new Function(await scriptBlob.text())();
		const append = (window as unknown as {__fluxerVoiceDebugEventSinkAppendEntries: (entries: unknown) => void})
			.__fluxerVoiceDebugEventSinkAppendEntries;
		const entries = Array.from({length: 40}, (_, index) => bigEntry(index + 1));
		append(entries);
		const status = document.getElementById('status')?.textContent ?? '';
		const kept = Number(/^(\d+) visible \/ (\d+) entries; last #40/.exec(status)?.[2]);
		expect(kept).toBeGreaterThan(0);
		expect(kept).toBeLessThan(entries.length);
		expect(kept * entries[0].line.length * 2).toBeLessThanOrEqual(HISTORY_BYTE_BUDGET);
	});

	it('releases channel, listener, blob URLs and retained state once the window is closed', async () => {
		vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
		const removeListener = vi.spyOn(window, 'removeEventListener');
		const popout = stubPopoutWindow();
		setBrowserVoiceDebugEventSinkStatsHtml('<p>old stats</p>');
		await openBrowserVoiceDebugEventSinkPopout([{sequence: 1, line: 'first'}]);
		const channel = FakeBroadcastChannel.instances[0];
		expect(channel?.listeners.size).toBe(1);

		popout.closed = true;
		appendBrowserVoiceDebugEventSinkEntries([{sequence: 2, line: 'second'}]);

		expect(isBrowserVoiceDebugEventSinkPopoutOpen()).toBe(false);
		expect(channel?.closed).toBe(true);
		expect(channel?.listeners.size).toBe(0);
		expect(removeListener).toHaveBeenCalledWith('message', expect.any(Function));
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:0');
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:1');

		stubPopoutWindow();
		await expect(openBrowserVoiceDebugEventSinkPopout([])).resolves.toBe(true);
		const reopenedHtml = await blobs[3]?.text();
		expect(reopenedHtml).not.toContain('old stats');
		expect(reopenedHtml).toContain('No stats snapshot captured before popout opened.');
		expect(FakeBroadcastChannel.instances).toHaveLength(2);
		expect(isBrowserVoiceDebugEventSinkPopoutOpen()).toBe(true);
	});
});

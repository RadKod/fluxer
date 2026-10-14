// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const env = vi.hoisted(() => ({
	electron: null as Record<string, ReturnType<typeof vi.fn>> | null,
}));
const useStatsForNerds = vi.hoisted(() => vi.fn(() => ({snapshot: true})));
const renderVoiceDebugStatsHtml = vi.hoisted(() => vi.fn(() => '<p>stats</p>'));
const renderVoiceDebugStatsUnavailableHtml = vi.hoisted(() => vi.fn(() => '<p>unavailable</p>'));

vi.mock('@app/features/ui/utils/NativeUtils', () => ({getElectronAPI: () => env.electron}));
vi.mock('@app/features/voice/components/useStatsForNerds', () => ({useStatsForNerds}));
vi.mock('@app/features/voice/diagnostics/VoiceDebugStatsHtml', () => ({
	renderVoiceDebugStatsHtml,
	renderVoiceDebugStatsUnavailableHtml,
}));

import {resetBrowserVoiceDebugEventSinkPopoutForTests} from '@app/features/voice/diagnostics/VoiceDebugBrowserEventSinkPopout';
import {VoiceDebugStatsForwarder} from '@app/features/voice/diagnostics/VoiceDebugStatsForwarder';
import voiceEngineV2AppDebugEventSinkHostAdapter from '@app/features/voice/engine/v2/VoiceEngineV2AppDebugEventSinkHostAdapter';

const INTERVAL_MS = 2000;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mountForwarder(): void {
	container = document.createElement('div');
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root?.render(createElement(VoiceDebugStatsForwarder));
	});
}

function advance(ms: number): void {
	act(() => {
		vi.advanceTimersByTime(ms);
	});
}

function createDesktopApi(): Record<string, ReturnType<typeof vi.fn>> {
	return {
		openVoiceDebugEventSinkPopout: vi.fn(async () => undefined),
		appendVoiceDebugEventSinkEntries: vi.fn(),
		setVoiceDebugEventSinkStatsHtml: vi.fn(),
	};
}

function stubBrowserPopout(): {closed: boolean} {
	const popout = {closed: false, focus: vi.fn(), postMessage: vi.fn()};
	vi.spyOn(window, 'open').mockReturnValue(popout as unknown as Window);
	vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:popout');
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
	return popout;
}

describe('VoiceDebugStatsForwarder', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		env.electron = null;
		useStatsForNerds.mockClear();
		renderVoiceDebugStatsHtml.mockClear();
		renderVoiceDebugStatsUnavailableHtml.mockClear();
		resetBrowserVoiceDebugEventSinkPopoutForTests();
		voiceEngineV2AppDebugEventSinkHostAdapter.resetEventSinkPopoutStateForTests();
	});

	afterEach(() => {
		act(() => {
			root?.unmount();
		});
		root = null;
		container?.remove();
		container = null;
		resetBrowserVoiceDebugEventSinkPopoutForTests();
		voiceEngineV2AppDebugEventSinkHostAdapter.resetEventSinkPopoutStateForTests();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('produces no stats, metrics or IPC while no diagnostics window is open', () => {
		const desktop = createDesktopApi();
		env.electron = desktop;
		mountForwarder();
		advance(INTERVAL_MS * 10);
		expect(useStatsForNerds).not.toHaveBeenCalled();
		expect(renderVoiceDebugStatsHtml).not.toHaveBeenCalled();
		expect(desktop.setVoiceDebugEventSinkStatsHtml).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('publishes immediately when the desktop window opens and then periodically', async () => {
		const desktop = createDesktopApi();
		env.electron = desktop;
		mountForwarder();
		await act(async () => {
			await voiceEngineV2AppDebugEventSinkHostAdapter.openEventSinkPopout();
		});
		expect(useStatsForNerds).toHaveBeenCalled();
		expect(desktop.setVoiceDebugEventSinkStatsHtml).toHaveBeenCalledTimes(1);
		advance(INTERVAL_MS);
		expect(desktop.setVoiceDebugEventSinkStatsHtml).toHaveBeenCalledTimes(2);
		advance(INTERVAL_MS * 2);
		expect(desktop.setVoiceDebugEventSinkStatsHtml).toHaveBeenCalledTimes(4);
	});

	it('stops producing and leaves no timer once the browser window closes', async () => {
		const popout = stubBrowserPopout();
		mountForwarder();
		await act(async () => {
			await voiceEngineV2AppDebugEventSinkHostAdapter.openEventSinkPopout();
		});
		expect(renderVoiceDebugStatsHtml).toHaveBeenCalledTimes(1);
		advance(INTERVAL_MS);
		expect(renderVoiceDebugStatsHtml).toHaveBeenCalledTimes(2);
		popout.closed = true;
		advance(INTERVAL_MS);
		const producedAtClose = renderVoiceDebugStatsHtml.mock.calls.length;
		advance(INTERVAL_MS * 10);
		expect(renderVoiceDebugStatsHtml).toHaveBeenCalledTimes(producedAtClose);
		expect(producedAtClose).toBe(2);
		expect(renderVoiceDebugStatsUnavailableHtml).not.toHaveBeenCalled();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:popout');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('starts producing again when the browser window is reopened', async () => {
		const popout = stubBrowserPopout();
		mountForwarder();
		await act(async () => {
			await voiceEngineV2AppDebugEventSinkHostAdapter.openEventSinkPopout();
		});
		popout.closed = true;
		advance(INTERVAL_MS * 3);
		const producedWhileClosed = renderVoiceDebugStatsHtml.mock.calls.length;
		stubBrowserPopout();
		await act(async () => {
			await voiceEngineV2AppDebugEventSinkHostAdapter.openEventSinkPopout();
		});
		expect(renderVoiceDebugStatsHtml).toHaveBeenCalledTimes(producedWhileClosed + 1);
	});
});

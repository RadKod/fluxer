// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	canOffer: true,
	isHydrated: true,
	dismissed: false,
	nagbarRefreshed: false,
	state: {pinned: false},
	refresh: vi.fn(async () => {}),
}));
vi.mock('@app/features/platform/state/TaskbarPin', () => ({default: state}));
const {useTaskbarPinNagbar} = await import('./useTaskbarPinNagbar');

let root: Root;
let host: HTMLDivElement;
let focused = true;
function View({authenticated}: {authenticated: boolean}) {
	return createElement('span', null, String(useTaskbarPinNagbar(authenticated)));
}
const render = async (authenticated: boolean) => {
	await act(async () => root.render(createElement(View, {authenticated})));
};
beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	focused = true;
	state.canOffer = true;
	state.isHydrated = true;
	state.dismissed = false;
	state.nagbarRefreshed = false;
	state.state.pinned = false;
	state.refresh.mockClear();
	vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it('waits two minutes after authentication and never requests a pin', async () => {
	await render(false);
	await act(async () => vi.advanceTimersByTime(120_000));
	expect(host.textContent).toBe('false');
	expect(state.refresh).not.toHaveBeenCalled();
	await render(true);
	await act(async () => vi.advanceTimersByTime(119_999));
	expect(host.textContent).toBe('false');
	await act(async () => vi.advanceTimersByTime(1));
	expect(host.textContent).toBe('true');
	expect(state.refresh).toHaveBeenCalledTimes(1);
	await render(false);
	expect(host.textContent).toBe('false');
});

it('waits for first focus then remains visible without more IPC on alt-tab', async () => {
	focused = false;
	await render(true);
	await act(async () => vi.advanceTimersByTime(120_000));
	expect(host.textContent).toBe('false');
	expect(state.refresh).not.toHaveBeenCalled();
	focused = true;
	await act(async () => window.dispatchEvent(new Event('focus')));
	expect(host.textContent).toBe('true');
	expect(state.refresh).toHaveBeenCalledTimes(1);
	await act(async () => vi.advanceTimersByTime(600_000));
	expect(state.refresh).toHaveBeenCalledTimes(1);
	focused = false;
	await act(async () => window.dispatchEvent(new Event('blur')));
	expect(host.textContent).toBe('true');
	for (let i = 0; i < 10; i++) {
		focused = true;
		await act(async () => window.dispatchEvent(new Event('focus')));
		focused = false;
		await act(async () => window.dispatchEvent(new Event('blur')));
	}
	expect(host.textContent).toBe('true');
	expect(state.refresh).toHaveBeenCalledTimes(1);
});

it.each(['dismissed', 'pinned'])('never refreshes a %s offer', async (reason) => {
	state.canOffer = false;
	state.dismissed = reason === 'dismissed';
	state.state.pinned = reason === 'pinned';
	await render(true);
	await act(async () => vi.advanceTimersByTime(120_000));
	expect(state.refresh).not.toHaveBeenCalled();
});

it('waits for storage hydration before refreshing', async () => {
	state.isHydrated = false;
	state.canOffer = false;
	await render(true);
	await act(async () => vi.advanceTimersByTime(120_000));
	expect(state.refresh).not.toHaveBeenCalled();
	state.isHydrated = true;
	state.canOffer = true;
	await render(true);
	expect(state.refresh).toHaveBeenCalledTimes(1);
});

it('keeps unsupported, pinned, LAF and dismissed offers hidden', async () => {
	state.canOffer = false;
	await render(true);
	await act(async () => vi.advanceTimersByTime(120_000));
	expect(host.textContent).toBe('false');
});

it('does not repeat the state query after a layout remount in the same session', async () => {
	await render(true);
	await act(async () => vi.advanceTimersByTime(120_000));
	expect(state.refresh).toHaveBeenCalledTimes(1);
	await act(async () => root.unmount());
	root = createRoot(host);
	await render(true);
	await act(async () => vi.advanceTimersByTime(120_000));
	expect(state.refresh).toHaveBeenCalledTimes(1);
});

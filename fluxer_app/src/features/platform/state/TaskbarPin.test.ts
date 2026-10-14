// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
	windows: true,
	api: null as Record<string, unknown> | null,
	persist: vi.fn(async () => {}),
}));
vi.mock('@app/features/ui/utils/NativeUtils', () => ({
	getElectronAPI: () => mocks.api,
	isNativeWindows: () => mocks.windows,
}));
vi.mock('@app/features/platform/utils/MobXPersistence', () => ({makePersistent: mocks.persist}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		warn() {}
	},
}));

const {TaskbarPin} = await import('./TaskbarPin');

describe('device taskbar pin offer', () => {
	beforeEach(() => {
		mocks.windows = true;
		mocks.persist.mockClear();
		mocks.api = {
			getTaskbarPinState: vi.fn(async () => ({supported: true, pinned: false, lafRequired: false})),
			requestTaskbarPin: vi.fn(async () => true),
		};
	});

	it('persists dismissal locally and hydrates before showing', async () => {
		const store = new TaskbarPin();
		expect(store.isHydrated).toBe(false);
		await Promise.resolve();
		expect(store.isHydrated).toBe(true);
		expect(mocks.persist).toHaveBeenCalledWith(store, 'TaskbarPin', ['dismissed'], {writeDelayMs: 0});
		await store.refresh();
		expect(store.canOffer).toBe(true);
		store.dismiss();
		expect(store.canOffer).toBe(false);
		expect(store.canPin).toBe(true);
	});

	it.each([
		{supported: false, pinned: false, lafRequired: false},
		{supported: true, pinned: true, lafRequired: false},
		{supported: true, pinned: false, lafRequired: true},
	])('hides and blocks unavailable state %j', async (state) => {
		mocks.api!.getTaskbarPinState = vi.fn(async () => state);
		const store = new TaskbarPin();
		await store.refresh();
		expect(store.canPin).toBe(false);
		expect(store.canOffer).toBe(false);
		expect(await store.requestPin()).toBe(false);
		expect(mocks.api!.requestTaskbarPin).not.toHaveBeenCalled();
	});

	it('ignores old shells and non-Windows platforms', async () => {
		mocks.windows = false;
		const store = new TaskbarPin();
		await store.refresh();
		expect(mocks.api!.getTaskbarPinState).not.toHaveBeenCalled();
		mocks.windows = true;
		mocks.api = {};
		await store.refresh();
		expect(store.canPin).toBe(false);
	});

	it.each([true, false])('dismisses after Windows returns result %s', async (result) => {
		mocks.api!.requestTaskbarPin = vi.fn(async () => result);
		const store = new TaskbarPin();
		await store.refresh();
		const pending = store.requestPin();
		expect(store.dismissed).toBe(false);
		expect(mocks.api!.requestTaskbarPin).toHaveBeenCalledTimes(1);
		expect(await pending).toBe(result);
		expect(store.dismissed).toBe(true);
		expect(store.canPin).toBe(false);
		expect(store.canOffer).toBe(false);
	});

	it('keeps the offer on native failure and permits retry', async () => {
		mocks.api!.requestTaskbarPin = vi.fn(async () => {
			throw new Error('request failed');
		});
		const store = new TaskbarPin();
		await store.refresh();
		await expect(store.requestPin()).resolves.toBe(false);
		expect(store.dismissed).toBe(false);
		expect(store.attempted).toBe(false);
		expect(store.canOffer).toBe(true);
		expect(store.busy).toBe(false);
		mocks.api!.requestTaskbarPin = vi.fn(async () => false);
		await store.requestPin();
		expect(mocks.api!.requestTaskbarPin).toHaveBeenCalledTimes(1);
		expect(store.dismissed).toBe(true);
	});

	it('does not request pinning on refresh and blocks duplicate clicks', async () => {
		let finish!: (result: boolean) => void;
		mocks.api!.requestTaskbarPin = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					finish = resolve;
				}),
		);
		const store = new TaskbarPin();
		await store.refresh();
		expect(mocks.api!.requestTaskbarPin).not.toHaveBeenCalled();
		const pending = store.requestPin();
		expect(await store.requestPin()).toBe(false);
		expect(mocks.api!.requestTaskbarPin).toHaveBeenCalledTimes(1);
		finish(true);
		await pending;
		expect(store.canPin).toBe(false);
	});

	it('fails closed if a state refresh fails', async () => {
		const store = new TaskbarPin();
		await store.refresh();
		mocks.api!.getTaskbarPinState = vi.fn(async () => {
			throw new Error('unavailable');
		});
		await store.refresh();
		expect(store.canPin).toBe(false);
	});
});

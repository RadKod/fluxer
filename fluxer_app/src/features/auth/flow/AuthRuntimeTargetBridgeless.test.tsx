// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

const resolve = vi.hoisted(() => vi.fn());

vi.mock('@app/features/ui/utils/NativeUtils', () => ({
	getElectronAPI: () => ({capabilities: {appStore: true}}),
	isDesktop: () => true,
}));

vi.mock('@app/features/app/state/InstanceSnapshotStore', () => ({
	default: {resolve},
}));
vi.mock('@app/features/auth/flow/AuthShellLoadingState', () => ({AuthShellLoadingState: () => null}));
vi.mock('@app/features/auth/flow/AuthRouteLoadError', () => ({AuthRouteLoadError: () => 'runtime-error'}));

import {warmAuthRuntimeTarget} from '@app/features/auth/flow/AuthRuntimeTargetBoundary';

describe('desktop authentication without the runtime-config bridge', () => {
	beforeEach(() => {
		resolve.mockReset();
	});

	it('resolves the instance from the hosted document origin instead of failing', async () => {
		const snapshot = {instance: 'hosted'};
		resolve.mockResolvedValue({snapshot});

		const runtime = await warmAuthRuntimeTarget(new AbortController().signal);

		expect(runtime).toBe(snapshot);
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(resolve.mock.calls[0][0].input).toBe(window.location.origin);
	});
});

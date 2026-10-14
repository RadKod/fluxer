// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const check = vi.hoisted(() => vi.fn());
vi.mock('@app/features/user/commands/UsernameCommands', () => ({checkUsernameAvailability: check}));

import type {InstanceHTTPTarget} from '@app/features/platform/transport/InstanceHTTP';
import {useUsernameSelectionAvailability} from './useUsernameSelectionAvailability';

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let result: ReturnType<typeof useUsernameSelectionAvailability>;
function Probe({value, enabled = true, target}: {value: string; enabled?: boolean; target?: InstanceHTTPTarget}) {
	result = useUsernameSelectionAvailability(value, {enabled, target});
	return null;
}
async function render(value: string, enabled = true) {
	await act(async () => root.render(createElement(Probe, {value, enabled})));
}
async function tick(ms = 350) {
	await act(async () => vi.advanceTimersByTimeAsync(ms));
}
describe('username selection availability', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		check.mockReset().mockResolvedValue({taken: false});
		container = document.createElement('div');
		root = createRoot(container);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		vi.useRealTimers();
	});
	test('debounces input and checks the canonical name without an @ prefix', async () => {
		await render(' @ALICE ');
		await tick(349);
		expect(check).not.toHaveBeenCalled();
		await tick(1);
		expect(check.mock.calls[0][0]).toBe('alice');
		expect(result.state).toBe('available');
	});
	test('does not allow an earlier request to overwrite the newest result', async () => {
		let resolveOld!: (value: {taken: boolean}) => void;
		check.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveOld = resolve;
				}),
		);
		await render('alice');
		await tick();
		await render('bobbie');
		expect(result.state).toBe('idle');
		await tick();
		await act(async () => resolveOld({taken: true}));
		expect(result.state).toBe('available');
	});
	test('preserves unavailable reason and date instead of reporting every denial as taken', async () => {
		check.mockResolvedValue({taken: true, reason: 'RELEASE_EMBARGO', available_at: '2026-10-23T00:00:00Z'});
		await render('alice');
		await tick();
		expect(result).toMatchObject({
			state: 'unavailable',
			reason: 'RELEASE_EMBARGO',
			available_at: '2026-10-23T00:00:00Z',
		});
	});
	test('keeps short valid names available for server controlled public tiers', async () => {
		await render('a');
		await tick();
		expect(result.state).toBe('available');
	});
	test('does not query invalid input or when selection is disabled', async () => {
		await render('al!ce');
		await tick();
		expect(result.state).toBe('invalid');
		await render('alice', false);
		await tick();
		expect(check).not.toHaveBeenCalled();
	});
	test('request failure is unavailable and never marks a name free', async () => {
		check.mockRejectedValue(new Error('offline'));
		await render('alice');
		await tick();
		expect(result.state).toBe('error');
	});
	test('drops an available result immediately when the selected instance changes', async () => {
		const target = {apiEndpoint: 'https://one.test/api', instanceKey: 'one', apiVersion: 9};
		await act(async () => root.render(createElement(Probe, {value: 'alice', target})));
		await tick();
		expect(result.state).toBe('available');
		await act(async () => root.render(createElement(Probe, {value: 'alice', target: {...target, instanceKey: 'two'}})));
		expect(result.state).toBe('idle');
	});
});

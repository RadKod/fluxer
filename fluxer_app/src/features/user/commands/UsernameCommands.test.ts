// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, expect, test, vi} from 'vitest';

const harness = vi.hoisted(() => ({get: vi.fn(), request: vi.fn()}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http: {get: harness.get}}));
vi.mock('@app/features/platform/transport/InstanceHTTP', () => ({instanceRequest: harness.request}));

import {checkUsernameAvailability, getUsernameStatus} from './UsernameCommands';

beforeEach(() => {
	harness.get.mockReset();
	harness.request.mockReset();
});
test('authenticated availability preserves the backward-compatible taken flag, denial and date', async () => {
	const body = {taken: true, reason: 'RELEASE_EMBARGO', available_at: '2026-10-23T00:00:00Z'};
	harness.get.mockResolvedValue({body});
	expect(await checkUsernameAvailability('alice')).toEqual(body);
	expect(harness.get).toHaveBeenCalledWith(
		'/users/check-tag',
		expect.objectContaining({query: {username: 'alice', discriminator: '0000'}}),
	);
});
test('registration checks the explicitly selected instance without session authentication', async () => {
	const target = {instanceKey: 'https://one.test/api', apiEndpoint: 'https://one.test/api', apiVersion: 9};
	harness.request.mockResolvedValue({body: {available: false, reason: 'RESERVED', available_at: null}});
	expect(await checkUsernameAvailability('alice', {target})).toMatchObject({
		taken: true,
		reason: 'RESERVED',
		available_at: null,
	});
	expect(harness.request).toHaveBeenCalledWith(
		expect.objectContaining({path: '/auth/username-availability?username=alice', target, auth: 'none'}),
	);
});
test('private status uses the current-user endpoint and its abort signal', async () => {
	const signal = new AbortController().signal;
	const body = {state: 'selected', freeChangeAvailable: false, changeAvailableAt: '2026-10-23T00:00:00Z'};
	harness.get.mockResolvedValue({body});
	expect(await getUsernameStatus(signal)).toEqual(body);
	expect(harness.get).toHaveBeenCalledWith('/users/@me/username', {signal});
});

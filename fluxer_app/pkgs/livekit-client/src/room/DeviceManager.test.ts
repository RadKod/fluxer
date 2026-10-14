// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import {afterEach, describe, expect, it, vi} from 'vitest';
import DeviceManager from './DeviceManager.ts';

afterEach(() => {
	vi.unstubAllGlobals();
	DeviceManager.userMediaPromiseMap.clear();
});

describe('device permission stream ownership', () => {
	it.each([false, true])('stops every permission track after enumeration (failure=%s)', async (failure) => {
		const tracks = Array.from({length: 2}, () => ({
			readyState: 'live',
			stop: vi.fn(function (this: {readyState: string}) {
				this.readyState = 'ended';
			}),
		}));
		const enumerateDevices = vi.fn().mockResolvedValueOnce([]);
		const error = new Error('enumeration failed');
		if (failure) enumerateDevices.mockRejectedValueOnce(error);
		else enumerateDevices.mockResolvedValueOnce([]);
		const getUserMedia = vi.fn().mockResolvedValue({getTracks: () => tracks});
		vi.stubGlobal('navigator', {userAgent: 'Chrome', mediaDevices: {enumerateDevices, getUserMedia}});

		const result = new DeviceManager().getDevices('audioinput');
		if (failure) await expect(result).rejects.toBe(error);
		else await expect(result).resolves.toEqual([]);

		expect(getUserMedia).toHaveBeenCalledTimes(1);
		expect(tracks.filter((track) => track.readyState === 'live')).toHaveLength(0);
		for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])(
		'does not acquire a stream when enumeration needs no permission (request=%s)',
		async (request) => {
			const devices = request ? [{kind: 'audioinput', label: 'Microphone', deviceId: 'mic-1', groupId: 'group-1'}] : [];
			const enumerateDevices = vi.fn().mockResolvedValue(devices);
			const getUserMedia = vi.fn();
			vi.stubGlobal('navigator', {userAgent: 'Chrome', mediaDevices: {enumerateDevices, getUserMedia}});
			const manager = new DeviceManager();

			await expect(manager.getDevices('audioinput', request)).resolves.toEqual(devices);

			expect(manager.previousDevices).toEqual(devices);
			expect(enumerateDevices).toHaveBeenCalledTimes(1);
			expect(getUserMedia).not.toHaveBeenCalled();
		},
	);
});

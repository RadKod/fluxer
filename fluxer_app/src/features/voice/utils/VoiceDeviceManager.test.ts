// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, expect, it, vi} from 'vitest';

vi.mock('@app/features/permissions/system/utils/NativePermissions', () => ({ensureNativePermission: vi.fn()}));
vi.mock('@app/features/ui/utils/NativeUtils', () => ({isDesktop: () => false, getNativePlatformSync: () => null}));

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

// Chromium starts its video capture service for a devicechange subscription and for any enumeration, so loading the
// device layer at startup must not touch navigator.mediaDevices.
it('does not watch or enumerate media devices until devices are first used', async () => {
	const mediaDevices = {addEventListener: vi.fn(), enumerateDevices: vi.fn(async () => [])};
	vi.stubGlobal('window', globalThis);
	vi.stubGlobal('navigator', {userAgent: 'test', language: 'en', languages: ['en'], mediaDevices});
	const {voiceDeviceManager} = await import('./VoiceDeviceManager');
	expect(mediaDevices.addEventListener).not.toHaveBeenCalled();
	expect(mediaDevices.enumerateDevices).not.toHaveBeenCalled();
	let inUse = false;
	void voiceDeviceManager.whenInUse().then(() => {
		inUse = true;
	});
	await Promise.resolve();
	expect(inUse).toBe(false);

	await voiceDeviceManager.ensureDevices({requestPermissions: false});
	expect(mediaDevices.addEventListener).toHaveBeenCalledExactlyOnceWith('devicechange', expect.any(Function));
	expect(mediaDevices.enumerateDevices).toHaveBeenCalledOnce();
	expect(inUse).toBe(true);

	await voiceDeviceManager.ensureDevices({forceRefresh: true});
	expect(mediaDevices.addEventListener).toHaveBeenCalledOnce();
});

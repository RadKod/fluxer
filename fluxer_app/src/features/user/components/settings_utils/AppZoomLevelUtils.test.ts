// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, describe, expect, it, vi} from 'vitest';

async function loadWithUserAgent(userAgent: string) {
	vi.resetModules();
	vi.stubGlobal('navigator', {...window.navigator, userAgent});
	return import('@app/features/user/components/settings_utils/AppZoomLevelUtils');
}

describe('shouldShowAppZoomLevel', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('shows the zoom setting in a desktop web browser', async () => {
		const {shouldShowAppZoomLevel} = await loadWithUserAgent(
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
		);

		expect(shouldShowAppZoomLevel()).toBe(true);
	});

	it('keeps the zoom setting hidden in a phone browser', async () => {
		const {shouldShowAppZoomLevel} = await loadWithUserAgent(
			'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
		);

		expect(shouldShowAppZoomLevel()).toBe(false);
	});
});

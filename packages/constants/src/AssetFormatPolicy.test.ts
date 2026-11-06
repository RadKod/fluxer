// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	COSMETIC_ASSET_POLICY,
	getAcceptString,
	getPolicy,
	isExtensionAllowed,
	ULTRA_FRONT_POLICY,
} from '@fluxer/constants/src/AssetFormatPolicy';
import {describe, expect, it} from 'vitest';

describe('AssetFormatPolicy', () => {
	it('holds every cosmetic, ultra decorations included, to 8 MiB', () => {
		expect(COSMETIC_ASSET_POLICY.maxBytes).toBe(8_388_608);
		expect(COSMETIC_ASSET_POLICY.ultraMaxBytes).toBe(8_388_608);
	});

	it('keeps the in-front ultra part limits of the angel-wings gate', () => {
		expect(ULTRA_FRONT_POLICY).toEqual({
			closedMaxBytes: 153_600,
			openFrameMaxBytes: 65_536,
			openTotalMaxBytes: 512_000,
			idleMaxBytes: 1_500_000,
			minFrames: 2,
			maxFrames: 30,
			height: {min: 96, max: 576},
		});
		expect(COSMETIC_ASSET_POLICY.dims).toEqual({min: 32, max: 2048});
	});
});


describe('role icon policy', () => {
	it('allows static PNG, JPEG, WebP and AVIF up to 256 KiB', () => {
		const policy = getPolicy('role_icon');
		expect(policy.upload).toEqual(['png', 'jpeg', 'webp', 'avif']);
		expect(policy.animated).toBe('never');
		expect(policy.maxBytes).toBe(256 * 1024);
		expect(policy.dims).toEqual({min: 32, max: 1024});
	});

	it('rejects SVG, GIF, HEIC and JXL', () => {
		for (const ext of ['svg', 'gif', 'heic', 'heif', 'jxl', 'apng']) {
			expect(isExtensionAllowed('role_icon', ext)).toBe(false);
		}
		expect(isExtensionAllowed('role_icon', 'jpg')).toBe(true);
	});

	it('builds an accept string from the allowed formats', () => {
		expect(getAcceptString('role_icon')).toBe('.png,.jpeg,.webp,.avif,image/png,image/jpeg,image/webp,image/avif');
	});
});

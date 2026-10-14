// SPDX-License-Identifier: AGPL-3.0-or-later

import {COSMETIC_ASSET_POLICY, ULTRA_FRONT_POLICY} from '@fluxer/constants/src/AssetFormatPolicy';
import {describe, expect, it} from 'vitest';

describe('AssetFormatPolicy', () => {
	it('holds ultra decorations to 1,228,800 bytes and every other cosmetic to 512 KB', () => {
		expect(COSMETIC_ASSET_POLICY.maxBytes).toBe(524_288);
		expect(COSMETIC_ASSET_POLICY.ultraMaxBytes).toBe(1_228_800);
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
		expect(COSMETIC_ASSET_POLICY.dims).toEqual({min: 96, max: 480}); // fallback rules unchanged
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {COSMETIC_ASSET_POLICY, ULTRA_FRONT_POLICY} from '@fluxer/constants/src/AssetFormatPolicy';
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

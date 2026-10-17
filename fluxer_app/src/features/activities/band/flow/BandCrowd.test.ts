// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	BAND_CHEER_INTERVAL_MS,
	BAND_CHEERING_MS,
	BandCrowd,
	isBandCheerKind,
} from '@app/features/activities/band/flow/BandCrowd';
import {describe, expect, it} from 'vitest';

describe('BandCrowd', () => {
	it('records cheers in the feed and as each person’s latest', () => {
		const crowd = new BandCrowd();
		crowd.receive('u1', 'clap', 0);
		crowd.receive('u2', 'fire', 10);
		crowd.receive('u1', 'horns', 1000);
		expect(crowd.feed.map((entry) => [entry.userId, entry.kind])).toEqual([
			['u1', 'clap'],
			['u2', 'fire'],
			['u1', 'horns'],
		]);
		expect(crowd.latestByUser.get('u1')?.kind).toBe('horns');
	});

	it('drops cheers faster than the rate limit, per sender', () => {
		const crowd = new BandCrowd();
		expect(crowd.receive('u1', 'clap', 0)).toBe(true);
		expect(crowd.canCheer('u1', BAND_CHEER_INTERVAL_MS - 1)).toBe(false);
		expect(crowd.receive('u1', 'clap', BAND_CHEER_INTERVAL_MS - 1)).toBe(false);
		expect(crowd.receive('u2', 'clap', 1)).toBe(true);
		expect(crowd.receive('u1', 'clap', BAND_CHEER_INTERVAL_MS)).toBe(true);
		expect(crowd.feed).toHaveLength(3);
	});

	it('keeps the feed short', () => {
		const crowd = new BandCrowd();
		for (let i = 0; i < 10; i++) crowd.receive(`u${i}`, 'wow', i);
		expect(crowd.feed.map((entry) => entry.userId)).toEqual(['u4', 'u5', 'u6', 'u7', 'u8', 'u9']);
	});

	it('raises hype with cheers, caps it and lets it fade', () => {
		const crowd = new BandCrowd();
		expect(crowd.hypeLevel(0)).toBe(0);
		crowd.receive('u1', 'fire', 0);
		const one = crowd.hypeLevel(0);
		crowd.receive('u2', 'fire', 0);
		expect(crowd.hypeLevel(0)).toBeCloseTo(one * 2);
		expect(crowd.hypeLevel(8000)).toBeCloseTo(one);
		for (let i = 0; i < 40; i++) crowd.receive(`x${i}`, 'clap', 8000);
		expect(crowd.hypeLevel(8000)).toBe(1);
	});

	it('tells who is cheering right now', () => {
		const crowd = new BandCrowd();
		crowd.receive('u1', 'clap', 100);
		expect(crowd.isCheering('u1', 100 + BAND_CHEERING_MS - 1)).toBe(true);
		expect(crowd.isCheering('u1', 100 + BAND_CHEERING_MS)).toBe(false);
		expect(crowd.isCheering('u2', 100)).toBe(false);
	});

	it('starts over for the next song', () => {
		const crowd = new BandCrowd();
		crowd.receive('u1', 'clap', 0);
		crowd.reset();
		expect(crowd.feed).toEqual([]);
		expect(crowd.hypeLevel(0)).toBe(0);
		expect(crowd.canCheer('u1', 1)).toBe(true);
	});

	it('knows the cheer kinds', () => {
		expect(isBandCheerKind('horns')).toBe(true);
		expect(isBandCheerKind('boo')).toBe(false);
		expect(isBandCheerKind(3)).toBe(false);
	});
});

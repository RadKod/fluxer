// SPDX-License-Identifier: AGPL-3.0-or-later

import {crc32} from 'node:zlib';
import {createUserID} from '@app/api/BrandedTypes';
import {SnowflakeGenerator} from '@fluxer/snowflake/src/Snowflake';
import {describe, expect, it} from 'vitest';
import {holdBucket, intentBucket} from '../UsernameOwnershipRepository';

describe('username intent buckets', () => {
	it('spreads snowflakes minted on consecutive milliseconds over all 64 buckets', () => {
		let now = Date.UTC(2026, 9, 10);
		const generator = new SnowflakeGenerator({workerId: 3, now: () => now++});
		const counts = new Array<number>(64).fill(0);
		for (let i = 0; i < 1000; i++) counts[intentBucket(createUserID(generator.generate()))]++;
		expect(counts[0] / 1000).toBeLessThanOrEqual(0.05);
		expect(counts.every((count) => count > 0)).toBe(true);
	});

	it('spreads a burst minted within one millisecond as well', () => {
		const generator = new SnowflakeGenerator({workerId: 0, now: () => Date.UTC(2026, 9, 10)});
		const buckets = new Set<number>();
		for (let i = 0; i < 1000; i++) buckets.add(intentBucket(createUserID(generator.generate())));
		expect(buckets.size).toBe(64);
	});

	it('keeps the hold bucket on the standard CRC-32 of the name', () => {
		for (const name of ['first', 'reserved', 'a', 'micup_user_32_characters_long_x'])
			expect(holdBucket(name)).toBe(crc32(name) % 1024);
		expect(['first', 'reserved', 'a', 'micup_user_32_characters_long_x'].map(holdBucket)).toEqual([599, 962, 579, 682]);
	});

	it('keeps stored intent buckets stable', () => {
		expect(intentBucket(createUserID(200n))).toBe(51);
		expect(intentBucket(createUserID(1234567890123456789n))).toBe(25);
	});
});

// SPDX-License-Identifier: AGPL-3.0-or-later

import {MockKVProvider, registerMockKVScript} from '@app/api/test/mocks/MockKVProvider';
import {describe, expect, it} from 'vitest';

describe('MockKVProvider scripts', () => {
	it('unknown script consults the registry', async () => {
		const kv = new MockKVProvider();
		await expect(kv.evalScript('mockRegistryProbe', 'return 1', 1, '{probe}', 'a', 2)).rejects.toThrow(
			'Unsupported mock script command: mockRegistryProbe',
		);

		registerMockKVScript('mockRegistryProbe', async (store, key, args) => {
			await store.set(key, args.join(','));
			return args.length;
		});

		expect(await kv.evalScript('mockRegistryProbe', 'return 1', 1, '{probe}', 'a', 2)).toBe(2);
		expect(await kv.get('{probe}')).toBe('a,2');
	});
});

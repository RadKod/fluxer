// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it, vi} from 'vitest';

// The instance's own gift links, as served for micup.gg.
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {isSelfHosted: () => true, giftUrlBase: 'micup.gg/gift'},
}));

const {findKey} = await import('@app/features/gift/utils/GiftCodeUtils');

describe('findKey', () => {
	it('finds a bare key and a gift link of this site; refuses others', () => {
		expect(findKey('Ab3dEf9hJk2mNp4Q')).toBe('Ab3dEf9hJk2mNp4Q');
		expect(findKey('  https://micup.gg/gift/Ab3dEf9hJk2mNp4Q  ')).toBe('Ab3dEf9hJk2mNp4Q');
		expect(findKey('https://evil.example/gift/Ab3dEf9hJk2mNp4Q')).toBeNull();
		expect(findKey('my key is Ab3dEf9h')).toBeNull();
		expect(findKey('A'.repeat(33))).toBeNull();
		expect(findKey('   ')).toBeNull();
	});
});

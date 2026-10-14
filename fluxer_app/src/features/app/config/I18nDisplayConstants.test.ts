// SPDX-License-Identifier: AGPL-3.0-or-later

import * as constants from '@app/features/app/config/I18nDisplayConstants';
import {describe, expect, it} from 'vitest';

describe('premium display constants', () => {
	it('exports sanalyer Plus names for cold boot and translated placeholders', () => {
		expect(constants).toMatchObject({PREMIUM_PRODUCT_NAME: 'sanalyer Plus', PREMIUM_PRODUCT_FULL_NAME: 'sanalyer Plus'});
	});
});
